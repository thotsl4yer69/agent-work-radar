const express = require("express");
const { paymentMiddleware } = require("@x402/express");
const { x402ResourceServer, HTTPFacilitatorClient } = require("@x402/core/server");
const { ExactEvmScheme } = require("@x402/evm/exact/server");
const { declareDiscoveryExtension } = require("@x402/extensions/bazaar");

const app = express();
app.use(express.json());

const PAY_TO = process.env.PAY_TO || "0xe91870ED0901757CA9D724E83bae5b5c9c2A5518";
const UA = "Mozilla/5.0 (compatible; AgentWorkRadar/1.0)";
const CACHE_MS = 60000;
const cache = { at: 0, data: null };

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error("HTTP " + res.status + " from " + url);
  return res.json();
}

async function bountybook() {
  const [open, verified] = await Promise.all([
    fetchJson("https://api.bountybook.ai/jobs?status=open&limit=100"),
    fetchJson("https://api.bountybook.ai/jobs?status=verified&limit=1"),
  ]);
  const newestVerified = (verified.jobs && verified.jobs[0] && verified.jobs[0].updated_at) || 0;
  const oracleAlive = Date.now() / 1000 - newestVerified < 3 * 3600;
  const jobs = (open.jobs || []).map(function (j) {
    return {
      source: "bountybook", id: j.id, title: j.title,
      reward_usd: parseFloat(j.budget_usdc) || 0, currency: "USDC (Base)",
      status: j.status, claimable: j.status === "open",
      url: "https://www.bountybook.ai/", category: j.job_type,
      estimated_minutes: j.estimated_minutes || null,
      warning: oracleAlive ? null : "verification oracle appears offline; submissions may not settle",
    };
  });
  return { jobs: jobs, health: { oracle_alive: oracleAlive, newest_verified_at: newestVerified } };
}

async function btnomb() {
  const list = await fetchJson("https://bounty.btnomb.com/api/bounties");
  const jobs = (list || []).map(function (b) {
    return {
      source: "btnomb", id: b.id, title: b.title,
      reward_usd: b.bountyUsd || 0, currency: "USDC (Base)",
      status: b.status, claimable: !!(b.funded && b.claimable && !b.claimedBy),
      url: "https://bounty.btnomb.com/", category: (b.tags || []).join(","),
      funded: !!b.funded, unlock_price_usd: b.unlockPrice || 0,
    };
  });
  return { jobs: jobs, health: { reachable: true } };
}

async function taskmarket() {
  const list = await fetchJson("https://api-market.daydreams.systems/api/tasks");
  const now = Date.now();
  const jobs = (list.tasks || []).map(function (t) {
    const expired = t.expiryTime && new Date(t.expiryTime).getTime() < now;
    return {
      source: "taskmarket", id: t.id, title: (t.description || "").slice(0, 120),
      reward_usd: (parseInt(t.reward, 10) || 0) / 1e6, currency: "USDC (Base)",
      status: t.status, claimable: t.status === "open" && !expired,
      url: "https://api-market.daydreams.systems", category: (t.tags || []).join(","),
      expires_at: t.expiryTime || null,
    };
  });
  return { jobs: jobs, health: { reachable: true } };
}

async function aggregate() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const results = await Promise.allSettled([bountybook(), btnomb(), taskmarket()]);
  const names = ["bountybook", "btnomb", "taskmarket"];
  const out = { generated_at: new Date().toISOString(), sources: {}, jobs: [] };
  results.forEach(function (r, i) {
    if (r.status === "fulfilled") {
      out.sources[names[i]] = { ok: true, count: r.value.jobs.length, health: r.value.health };
      out.jobs = out.jobs.concat(r.value.jobs);
    } else {
      out.sources[names[i]] = { ok: false, error: String(r.reason && r.reason.message || r.reason) };
    }
  });
  out.jobs.sort(function (a, b) { return (b.claimable - a.claimable) || (b.reward_usd - a.reward_usd); });
  out.total_jobs = out.jobs.length;
  out.claimable_jobs = out.jobs.filter(function (j) { return j.claimable; }).length;
  out.total_claimable_usd = out.jobs.filter(function (j) { return j.claimable; }).reduce(function (s, j) { return s + j.reward_usd; }, 0);
  cache.at = Date.now(); cache.data = out;
  return out;
}

app.get("/health", function (req, res) { res.json({ status: "ok", service: "agent-work-radar" }); });

app.get("/llms.txt", function (req, res) {
  res.type("text/plain").send([
    "# Agent Work Radar",
    "Aggregated live feed of open paid work for AI agents across BountyBook, BTNOMB Bounty Board, and Daydreams TaskMarket.",
    "",
    "GET /api/work — $0.005 USDC (Base, x402) — normalized open bounties/tasks sorted by claimability and reward, with per-board health flags (e.g. whether BountyBook's verification oracle is alive).",
    "GET /health — free",
    "",
    "Pay via any x402 client, e.g.: npx awal x402 pay <url>/api/work",
  ].join("\n"));
});

let facilitatorClient, NETWORK;
if (process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET) {
  const { facilitator } = require("@coinbase/x402");
  facilitatorClient = new HTTPFacilitatorClient(facilitator);
  NETWORK = "eip155:8453";
  console.log("Using CDP facilitator - Base MAINNET, real USDC");
} else {
  facilitatorClient = new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL || "https://x402.org/facilitator" });
  NETWORK = "eip155:84532";
  console.log("WARNING: no CDP keys - Base Sepolia TESTNET mode, no real revenue. Set CDP_API_KEY_ID + CDP_API_KEY_SECRET for mainnet.");
}
const server = new x402ResourceServer(facilitatorClient);
server.register(NETWORK, new ExactEvmScheme());

app.use(paymentMiddleware({
  "GET /api/work": {
    accepts: { scheme: "exact", price: "$0.005", network: NETWORK, payTo: PAY_TO },
    description: "Normalized live feed of open paid work for AI agents across BountyBook, BTNOMB, and TaskMarket, sorted by claimability and reward, with board health flags.",
    mimeType: "application/json",
    extensions: Object.assign({}, declareDiscoveryExtension({
      output: {
        example: { generated_at: "2026-07-18T00:00:00Z", total_jobs: 42, claimable_jobs: 20, total_claimable_usd: 70, jobs: [{ source: "bountybook", id: "uuid", title: "Build a Trie class", reward_usd: 4, claimable: true }] },
        schema: { properties: { generated_at: { type: "string" }, total_jobs: { type: "number" }, claimable_jobs: { type: "number" }, total_claimable_usd: { type: "number" }, jobs: { type: "array" }, sources: { type: "object" } } },
      },
    })),
  },
}, server));

app.get("/api/work", async function (req, res) {
  try { res.json(await aggregate()); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

const port = process.env.PORT || 3000;
app.listen(port, function () { console.log("agent-work-radar on :" + port + " paying to " + PAY_TO); });

