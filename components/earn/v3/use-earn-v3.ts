"use client";

/**
 * One read model for the Earn V3 screens: live pool stats (GET /api/pools), the wallet's lender
 * positions (vToken balance × exchange rate), its supply / withdraw history (Mercury merged with
 * the bounded RPC fallback — always scoped to the connected wallet), Reflector oracle prices, and
 * the chart series built from them (./earn-series). Everything comes from the existing hooks in
 * hooks/use-earn.ts — nothing is stored in the browser.
 */
import { useEffect, useMemo, useState } from "react";
import { useUserStore } from "@/store/user";
import { usePoolData, useUserPositions, useEarnTransactions } from "@/hooks/use-earn";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { EARN_POOLS, EARN_PRICE_SYMS, type PoolKey } from "./earn-pools";
import { buildValueSeries, flatSeries, type SeriesInput, type SeriesPoint, type Tf } from "./earn-series";

/**
 * Dust threshold: 0.0001 token. After a 100% withdrawal, contracts typically leave 1-100 stroops
 * (1e-7 to 1e-5) of rounding residue in the user's vToken balance — purely numerical, not a real
 * position. Filtering at 1e-4 hides that dust everywhere consistently.
 */
export const POSITION_DUST = 1e-4;

/** Interest earned on one pool (underlying units), or why it can't be shown. */
export interface EarnedEntry {
  earned: number | null;
  reason?: string;
}

/** Pool stats as numbers (the API returns decimal strings; percentages stay in percent). */
export interface PoolNum {
  totalSupplied: number;
  totalBorrowed: number;
  availableLiquidity: number;
  /** Percent (e.g. 42.1). */
  utilization: number;
  /** Percent. */
  supplyApy: number;
  /** Percent. */
  borrowApy: number;
  vTokenSupply: number;
  exchangeRate: number;
}

const num = (s: string | undefined) => parseFloat(s ?? "0") || 0;

/** Live Earn data for the connected wallet (or the public pool data when disconnected). */
export function useEarnV3() {
  const address = useUserStore((s) => s.address);
  const { pools: rawPools, isLoading: poolsLoading } = usePoolData();
  const { positions: rawPositions } = useUserPositions();
  const { transactions, isLoading: historyLoading } = useEarnTransactions();
  const oracle = useTokenPrices(EARN_PRICE_SYMS);

  // Chart clock: refreshed every minute (and pushed past the newest event), so "now" is never
  // read impurely during render.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  /** Numeric pool stats per pool key. */
  const pools = useMemo(() => {
    const out = {} as Record<PoolKey, PoolNum>;
    for (const p of EARN_POOLS) {
      const s = rawPools[p.key];
      out[p.key] = {
        totalSupplied: num(s?.totalSupply),
        totalBorrowed: num(s?.totalBorrowed),
        availableLiquidity: num(s?.availableLiquidity),
        utilization: num(s?.utilizationRate),
        supplyApy: num(s?.supplyAPY),
        borrowApy: num(s?.borrowAPY),
        vTokenSupply: num(s?.vTokenSupply),
        exchangeRate: num(s?.exchangeRate) || 1,
      };
    }
    return out;
  }, [rawPools]);

  /** USD price per pool key (0 when the oracle has no price — never a made-up $1). */
  const prices = useMemo(() => {
    const out = {} as Record<PoolKey, number>;
    for (const p of EARN_POOLS) out[p.key] = oracle[p.priceSym] ?? 0;
    return out;
  }, [oracle]);

  /** Supplied value per pool key (underlying units, interest included), dust filtered. */
  const supplied = useMemo(() => {
    const out = {} as Record<PoolKey, number>;
    for (const p of EARN_POOLS) {
      const a = address ? num(rawPositions[p.key]?.deposited) : 0;
      out[p.key] = a > POSITION_DUST ? a : 0;
    }
    return out;
  }, [rawPositions, address]);

  /** vToken balance per pool key. */
  const shares = useMemo(() => {
    const out = {} as Record<PoolKey, number>;
    for (const p of EARN_POOLS) out[p.key] = address ? num(rawPositions[p.key]?.vTokenBalance) : 0;
    return out;
  }, [rawPositions, address]);

  /** Overall Deposit headline: Σ supplied × oracle price. */
  const depositUsd = useMemo(() => EARN_POOLS.reduce((s, p) => s + supplied[p.key] * prices[p.key], 0), [supplied, prices]);
  const depositMissingPrice = EARN_POOLS.filter((p) => supplied[p.key] > 0 && !(prices[p.key] > 0)).map((p) => p.sym);

  /**
   * Interest earned per pool = current vToken-derived value minus net principal (Σ supply −
   * Σ withdraw, both in real underlying units — Mercury's withdraw amount is `asset_amount`, not
   * the vToken share count). Same rule as the pre-V3 page: a pool's yield only counts once we've
   * actually SEEN at least one supply/withdraw event for it. A missing history entry means "we
   * don't know this pool's principal" — NOT "principal is 0" (treating it as 0 misreports the
   * entire deposit as earned yield). Skipped while history is loading.
   */
  const earned = useMemo(() => {
    const out = {} as Record<PoolKey, EarnedEntry>;
    const net: Record<string, number> = {};
    for (const tx of transactions) {
      const amt = parseFloat(tx.amount) || 0;
      if (!(amt > 0)) continue;
      net[tx.asset] = (net[tx.asset] ?? 0) + (tx.type === "supply" ? amt : -amt);
    }
    for (const p of EARN_POOLS) {
      if (historyLoading) out[p.key] = { earned: null };
      else if (!Object.prototype.hasOwnProperty.call(net, p.key)) out[p.key] = supplied[p.key] > 0 ? { earned: null, reason: "No indexed supply history" } : { earned: 0 };
      else out[p.key] = { earned: Math.max(0, supplied[p.key] - Math.max(0, net[p.key])) };
    }
    return out;
  }, [transactions, historyLoading, supplied]);

  /** Net Earnings headline (null = can't be proven from history; never shown as a made-up figure). */
  const earnedSummary = useMemo(() => {
    let usd = 0;
    let known = 0;
    const unknownSymbols: string[] = [];
    for (const p of EARN_POOLS) {
      if (!(supplied[p.key] > 0)) continue;
      const e = earned[p.key].earned;
      if (e === null) unknownSymbols.push(p.sym);
      else {
        usd += e * prices[p.key];
        known++;
      }
    }
    const anyPosition = EARN_POOLS.some((p) => supplied[p.key] > 0);
    return {
      usd: historyLoading || (anyPosition && known === 0) ? null : usd,
      partial: known > 0 && unknownSymbols.length > 0,
      unknownSymbols: historyLoading ? [] : unknownSymbols,
    };
  }, [earned, supplied, prices, historyLoading]);

  const seriesInput = useMemo<SeriesInput>(() => ({ rows: transactions, live: supplied, prices }), [transactions, supplied, prices]);

  /** Chart clock: now, or the newest event if the ledger timestamp runs ahead of this browser. */
  const now = useMemo(() => Math.max(clock, ...transactions.map((r) => r.timestamp)), [clock, transactions]);

  return {
    address,
    pools,
    poolsLoading,
    supplied,
    shares,
    transactions,
    historyLoading,
    earned,
    prices,
    depositUsd,
    depositMissingPrice,
    earnedSummary,
    seriesInput,
    now,
  };
}

/**
 * Value series ("dep" / "my") over `tf` for pool `keys`. Falls back to a flat line at the live
 * value when the history can't replay the past for some pool (`excluded` lists them).
 */
export function seriesFor(tf: Tf, keys: readonly string[], inp: SeriesInput, now: number, liveValue: number): { pts: SeriesPoint[]; excluded: string[] } {
  const r = buildValueSeries(tf, keys, inp, now);
  if (!r.complete) return { pts: liveValue > 0 ? flatSeries(tf, liveValue, now) : [], excluded: r.excluded };
  return { pts: r.pts, excluded: r.excluded };
}
