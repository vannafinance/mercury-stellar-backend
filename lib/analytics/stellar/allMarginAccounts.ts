// Fetches every margin account created by the CreditLayer — not just the
// connected wallet's account — and snapshots its on-chain collateral / debt for
// the analytics dashboards.
//
// How this works on-chain (credit-layer redeploy 2026-11-06):
//   • There is no account list in storage any more (the Registry's
//     SmartAccountsList is gone). Every `create_margin` emits
//     `margin_created` [name, trader] data=margin, so the roster is rebuilt from
//     those events: Mercury (full history, when configured server-side) merged
//     with a windowed RPC getEvents scan (~7 days retention).
//   • Each account is then read with the same credit-layer reads the margin
//     page uses (lib/margin-credit-reads.ts): token balances, LP tokens, Blend
//     positions, reserve debt_of, and CreditLayer margin_value for the
//     contract's own collateral / debt totals (Liquidation prices).
//
// Everything here is read-only. Callers wire the resulting `AccountSnapshot[]`
// straight into the existing `derive*` helpers in `lib/analytics/onchain`.

import * as StellarSdk from "@stellar/stellar-sdk";

import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";
import { CREDIT_EVENTS, HEALTH_THRESHOLD } from "@/lib/credit-layer";
import { readMarginPortfolio, type BalanceMap } from "@/lib/margin-credit-reads";
import { decodeMercuryEvent, type RawMercuryEvent } from "@/lib/mercury-client";
import { eventName, getEventsWindowed, symbolTopic } from "@/lib/credit-events-rpc";
import type {
  AccountSnapshot,
  CollateralPosition,
  DebtPosition,
} from "@/lib/analytics/onchain/types";
import { collateralPositionTypeForSymbol } from "@/lib/analytics/stellar/collateralClassification";

const STELLAR_CHAIN_ID = 0;

let lastResult: { accounts: AccountSnapshot[]; ownerByAccount: Map<string, string>; fetchedAt: number } | null = null;
let inflight: Promise<{ accounts: AccountSnapshot[]; ownerByAccount: Map<string, string> }> | null = null;
const ALL_ACCOUNTS_TTL_MS = 30_000;

// Hard ceiling on how many accounts we deep-scan in a single pass. Each
// account costs ~15 simulations, so without a cap the protocol-wide scan grows
// O(accounts) and will overwhelm RPC at mainnet scale. We keep the most
// recently created accounts and log how many were omitted — never silently
// truncate. The permanent fix is a Mercury per-account table.
const MAX_DEEP_SCAN_ACCOUNTS = 200;

// Cap simultaneous in-flight account reads.
const SCAN_CONCURRENCY = 8;

/** Run `fn` over `items` with at most `limit` promises in flight at once. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

type Creation = { margin: string; trader: string; order: number };

/**
 * `margin_created` from Mercury, read server-side straight from Mercury's REST
 * endpoint (the /api/mercury proxy is a relative URL that only works in the
 * browser). Returns [] when Mercury is not configured or fails.
 */
async function creationsFromMercury(): Promise<Creation[]> {
  const base = process.env.MERCURY_URL?.replace(/\/graphql\/?$/, "");
  const key = process.env.MERCURY_KEY;
  if (typeof window !== "undefined" || !base || !key) return [];
  const out: Creation[] = [];
  try {
    let cursor: number | undefined;
    for (let page = 0; page < 50; page += 1) {
      const url = new URL(`${base}/rest/events/by-contract/${CONTRACT_ADDRESSES.CREDIT_LAYER}`);
      url.searchParams.set("limit", "200");
      url.searchParams.set("topics", symbolTopic(CREDIT_EVENTS.marginCreated));
      if (cursor != null) url.searchParams.set("cursor", String(cursor));
      const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) break;
      const json = (await res.json().catch(() => null)) as RawMercuryEvent[] | { events?: RawMercuryEvent[]; data?: RawMercuryEvent[] } | null;
      const rows = Array.isArray(json) ? json : json?.events ?? json?.data ?? [];
      for (const raw of rows) {
        const e = decodeMercuryEvent(raw);
        if (e.eventName !== CREDIT_EVENTS.marginCreated) continue;
        const trader = typeof e.topics[1] === "string" ? (e.topics[1] as string) : null;
        const margin = typeof e.data === "string" ? e.data : null;
        if (trader && margin) out.push({ margin, trader, order: raw.id });
      }
      if (rows.length < 200) break;
      cursor = rows[rows.length - 1].id;
    }
  } catch (err) {
    console.warn("[allMarginAccounts] Mercury margin_created read failed:", err);
  }
  return out;
}

/** `margin_created` from a windowed RPC scan over the node's retention. */
async function creationsFromRpc(): Promise<Creation[]> {
  try {
    const events = await getEventsWindowed([
      {
        type: "contract",
        contractIds: [CONTRACT_ADDRESSES.CREDIT_LAYER],
        topics: [[symbolTopic(CREDIT_EVENTS.marginCreated), "*"]],
      },
    ]);
    const out: Creation[] = [];
    for (const e of events) {
      if (eventName(e) !== CREDIT_EVENTS.marginCreated) continue;
      try {
        const trader = String(StellarSdk.scValToNative(e.topic[1]));
        const margin = String(StellarSdk.scValToNative(e.value));
        out.push({ margin, trader, order: e.ledger });
      } catch {
        /* skip malformed */
      }
    }
    return out;
  } catch (err) {
    console.warn("[allMarginAccounts] RPC margin_created scan failed:", err);
    return [];
  }
}

/** Every margin account ever created, oldest first, deduped by margin address. */
export async function listAllMarginAccounts(): Promise<{ margin: string; trader: string }[]> {
  const [mercury, rpc] = await Promise.all([creationsFromMercury(), creationsFromRpc()]);
  const byMargin = new Map<string, { margin: string; trader: string }>();
  // Mercury ids and RPC ledgers are both monotonic within their source; keep
  // Mercury's order first, then append anything only RPC has.
  for (const c of mercury.sort((a, b) => a.order - b.order)) byMargin.set(c.margin, { margin: c.margin, trader: c.trader });
  for (const c of rpc.sort((a, b) => a.order - b.order)) if (!byMargin.has(c.margin)) byMargin.set(c.margin, { margin: c.margin, trader: c.trader });
  return Array.from(byMargin.values());
}

/** BalanceMap → rows, dropping the USDC mirror of BLUSDC so it isn't counted twice. */
function rows(map: BalanceMap): { symbol: string; amount: number; usd: number }[] {
  return Object.entries(map)
    .filter(([sym]) => !(sym === "USDC" && map.BLUSDC))
    .map(([symbol, b]) => ({ symbol, amount: parseFloat(b.amount) || 0, usd: parseFloat(b.usdValue) || 0 }))
    .filter((r) => r.amount > 0);
}

async function snapshotAccount(margin: string, owner: string): Promise<AccountSnapshot | null> {
  const p = await readMarginPortfolio(margin);

  const collateral: CollateralPosition[] = rows(p.collateral).map((r) => ({
    asset: r.symbol,
    symbol: r.symbol,
    decimals: 7,
    amount: r.amount,
    usd: r.usd,
    type: collateralPositionTypeForSymbol(r.symbol),
  }));
  const debt: DebtPosition[] = rows(p.debts).map((r) => ({
    asset: r.symbol,
    symbol: r.symbol,
    decimals: 7,
    amount: r.amount,
    usd: r.usd,
  }));

  // Contract totals (margin_value) are the source of truth; the per-row sums
  // are the fallback when that read failed.
  const totalCollateralUsd = p.collateralUsd ?? collateral.reduce((s, c) => s + c.usd, 0);
  const totalDebtUsd = p.debtUsd ?? debt.reduce((s, d) => s + d.usd, 0);
  if (!(totalCollateralUsd > 0) && !(totalDebtUsd > 0)) return null; // empty / closed account

  const healthFactor = totalDebtUsd > 0 ? totalCollateralUsd / totalDebtUsd : Number.POSITIVE_INFINITY;
  const leverage = totalCollateralUsd > 0 ? 1 + totalDebtUsd / totalCollateralUsd : 1;

  return {
    account: margin,
    ownerProxy: owner,
    chainId: STELLAR_CHAIN_ID,
    collateral,
    debt,
    totalCollateralUsd,
    totalDebtUsd,
    healthFactor,
    leverage,
    isHealthy: !(totalDebtUsd > 0) || healthFactor > HEALTH_THRESHOLD,
  };
}

/**
 * Top-level reader for the analytics dashboard. Builds the margin-account
 * roster from `margin_created` events, snapshots each non-empty account, and
 * rolls them up into the `AccountSnapshot[]` shape consumed by every `derive*`
 * helper.
 *
 * Load is bounded two ways: at most {@link SCAN_CONCURRENCY} accounts are read
 * at once, and the deep per-account scan is capped at
 * {@link MAX_DEEP_SCAN_ACCOUNTS} (most-recent accounts kept, overflow logged).
 */
export async function fetchAllMarginAccountSnapshots(opts?: {
  force?: boolean;
}): Promise<{
  accounts: AccountSnapshot[];
  ownerByAccount: Map<string, string>;
}> {
  const force = opts?.force ?? false;
  const now = Date.now();

  if (!force && lastResult && now - lastResult.fetchedAt < ALL_ACCOUNTS_TTL_MS) {
    return { accounts: lastResult.accounts, ownerByAccount: lastResult.ownerByAccount };
  }
  if (inflight) return inflight;

  const run = (async () => {
    const all = await listAllMarginAccounts();
    if (all.length === 0) {
      return { accounts: [] as AccountSnapshot[], ownerByAccount: new Map<string, string>() };
    }

    let scan = all;
    if (all.length > MAX_DEEP_SCAN_ACCOUNTS) {
      const omitted = all.length - MAX_DEEP_SCAN_ACCOUNTS;
      scan = all.slice(-MAX_DEEP_SCAN_ACCOUNTS);
      console.warn(
        `[allMarginAccounts] ${all.length} accounts exceed the ${MAX_DEEP_SCAN_ACCOUNTS} deep-scan cap — ` +
          `snapshotting the ${MAX_DEEP_SCAN_ACCOUNTS} most recent, omitting ${omitted}.`,
      );
    }

    const results = await mapWithConcurrency(scan, SCAN_CONCURRENCY, ({ margin, trader }) =>
      snapshotAccount(margin, trader).catch((err) => {
        console.warn(`[allMarginAccounts] state read failed for ${margin}:`, err);
        return null;
      }),
    );

    const ownerByAccount = new Map<string, string>();
    const snapshots: AccountSnapshot[] = [];
    for (const snap of results) {
      if (!snap) continue;
      ownerByAccount.set(snap.account, snap.ownerProxy);
      snapshots.push(snap);
    }
    return { accounts: snapshots, ownerByAccount };
  })();

  inflight = run;
  try {
    const result = await run;
    lastResult = { ...result, fetchedAt: Date.now() };
    return result;
  } finally {
    inflight = null;
  }
}

/** Drop the in-memory cache so the next call re-reads from RPC. Useful from
 *  hot-paths after an account has been opened/closed in the same session. */
export function invalidateAllMarginAccountsCache(): void {
  lastResult = null;
}
