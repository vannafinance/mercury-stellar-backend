/**
 * Re-record the protocol facts the asset registry is checked against.
 *
 *     node scripts/refresh-chain-facts.mjs
 *
 * Writes lib/copilot/registry/chain-facts.json from live MCP reads. The DIFF on that
 * file is the point: it is how a protocol change becomes something a human reviews
 * rather than something a user discovers mid-transaction.
 *
 * Why this is a script and not a test: CI must not depend on testnet being reachable,
 * or an RPC blip becomes a red build with nothing wrong in the code. So CI checks the
 * registry against the recording, and this script is what makes the recording current.
 * The trade is explicit — the window between a protocol change and someone running
 * this is uncovered, and no amount of test-writing closes it.
 *
 * Reads only. Calls no write tool, signs nothing, needs no user assertion.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "lib/copilot/registry/chain-facts.json");

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const BASE = env.MCP_BASE_URL || "https://mcp.vanna.finance/mcp";
const TOKEN_URL = env.WORKOS_M2M_TOKEN_URL;

/** Symbols to probe for an earn pool. There is no list action, so we ask one by one. */
const EARN_CANDIDATES = ["XLM", "USDC", "BLUSDC", "AQUSDC", "SOUSDC", "EURC", "AQUA"];

async function m2mToken() {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.WORKOS_M2M_CLIENT_ID,
      client_secret: env.WORKOS_M2M_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

function lastJson(text) {
  if (text.trimStart().startsWith("{")) return JSON.parse(text);
  let last = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (raw && raw !== "[DONE]") {
      try {
        last = JSON.parse(raw);
      } catch {
        /* keep scanning */
      }
    }
  }
  return last;
}

let headers;
let sessionId;

async function openSession() {
  const token = await m2mToken();
  headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const init = await fetch(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "refresh-chain-facts", version: "1" },
      },
    }),
  });
  sessionId = init.headers.get("mcp-session-id");
  await init.text();
  if (!sessionId) throw new Error("MCP initialize returned no session id");
  headers = { ...headers, "mcp-session-id": sessionId };
  await fetch(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).catch(() => {});
}

async function call(tool, args) {
  const res = await fetch(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  const payload = lastJson(await res.text());
  const result = payload?.result;
  if (!result) throw new Error(`${tool}: empty result`);
  if (result.structuredContent) return result.structuredContent;
  return JSON.parse(result.content?.[0]?.text ?? "{}");
}

await openSession();

// ── collateral ──────────────────────────────────────────────────────────────
const cfg = await call("vanna_protocol_info", { action: "collateral_config", kwargs: {} });
const allowed = {};
for (const row of cfg.allowed_collateral ?? []) allowed[row.symbol] = !!row.allowed;
console.log("collateral:", allowed);

// ── Blend reserves ──────────────────────────────────────────────────────────
const reserves = await call("vanna_farm_blend", { action: "list_reserves", kwargs: {} });
const blend = (reserves.reserves ?? []).map((r) => r.symbol);
console.log("blend reserves:", blend);

// ── earn pools, one probe per candidate ─────────────────────────────────────
const pools = [];
const rejected = [];
const apy = {};
for (const symbol of EARN_CANDIDATES) {
  try {
    const stats = await call("vanna_earn_market", { action: "pool_stats", kwargs: { symbol } });
    if (stats.error || stats.supply_apy_pct == null) {
      rejected.push(symbol);
    } else {
      pools.push(symbol);
      apy[symbol] = String(stats.supply_apy_pct);
    }
  } catch {
    rejected.push(symbol);
  }
  process.stdout.write(`  earn ${symbol}: ${apy[symbol] ?? "none"}\n`);
}

/**
 * An alias is not a separate pool. Two symbols returning byte-identical rates on the
 * same read are the same reserve — that is how we know BLUSDC IS the USDC pool rather
 * than assuming it from a naming convention.
 */
const aliases = {};
const canonical = [];
for (const sym of pools) {
  const twin = canonical.find((c) => apy[c] === apy[sym]);
  if (twin) aliases[sym] = twin;
  else canonical.push(sym);
}

const facts = {
  _comment: [
    "Protocol facts read from the live MCP, recorded so CI can check the asset registry",
    "without depending on testnet being reachable. Regenerate with:",
    "    node scripts/refresh-chain-facts.mjs",
    "A diff on this file means the protocol changed under us — review it, do not just accept it.",
  ],
  recordedAt: new Date().toISOString().slice(0, 10),
  source: BASE,
  collateral: {
    _source: "vanna_protocol_info { action: collateral_config }",
    allowed,
    maxDistinctCollateralAssets: Number(cfg.max_distinct_collateral_assets ?? 0) || null,
  },
  blendReserves: {
    _source: "vanna_farm_blend { action: list_reserves }",
    symbols: blend,
  },
  earnPools: {
    _source: "vanna_earn_market { action: pool_stats, kwargs: { symbol } }, probed per symbol",
    _note: [
      "No list action exists, so each symbol is probed individually. A symbol is a pool when",
      "pool_stats returns rates, and is not when it returns invalid_input.",
      "Two symbols with identical rates on the same read are one pool under two names —",
      "that is how the alias map below is derived rather than assumed.",
    ],
    symbols: canonical,
    aliases,
    rejected,
  },
};

fs.writeFileSync(OUT, JSON.stringify(facts, null, 2) + "\n");
console.log(`\nwrote ${path.relative(ROOT, OUT)} — review the diff before committing.`);
