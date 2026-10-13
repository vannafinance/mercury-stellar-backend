"use client";

/**
 * Data layer for the V3 analytics screens. Everything comes from the Stellar app's existing live
 * readers - the protocol-wide margin-account snapshot (`useAnalyticsSnapshot`, Registry + Soroban),
 * the Reflector oracle read (`useOracleSnapshot`), the Soroban event feed (`useLiveEventFeed`) and the
 * shared lending-pool read (`/api/pools`, the same source the Earn page uses) - reshaped into the row /
 * summary model the Solana-style views render. Nothing is stored in browser storage.
 */
import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLedgerTick } from "@/contexts/ledger-subscriber";
import { useAnalyticsSnapshot, useLiveEventFeed, useOracleSnapshot } from "@/hooks/use-analytics";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore, type BorrowedBalance } from "@/store/margin-account-info-store";
import type { AllPoolStats } from "@/lib/pool-stats";
import type { AccountSnapshot } from "@/lib/analytics/onchain/types";
import { buildRows, summarize, type AccountRow } from "@/lib/analytics/v3/model";
import { poolRows, poolSymbolFor, poolTotals, type PoolRow } from "@/lib/analytics/v3/pools";
import { priceKey } from "@/lib/account-model";

const POOLS_KEY = ["analytics", "v3-pools"] as const;

/** Live lending-pool stats + APRs from the shared edge-cached `/api/pools` route, refreshed on the ledger tick. */
export function usePoolsApi() {
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const last = useRef(tick);
  const query = useQuery({
    queryKey: POOLS_KEY,
    queryFn: async (): Promise<AllPoolStats> => {
      const res = await fetch("/api/pools");
      if (!res.ok) throw new Error(`/api/pools failed (${res.status})`);
      return (await res.json()) as AllPoolStats;
    },
    staleTime: 15_000,
  });
  useEffect(() => {
    if (tick === last.current) return;
    last.current = tick;
    void qc.invalidateQueries({ queryKey: POOLS_KEY });
  }, [tick, qc]);
  return query;
}

/**
 * Health readings THIS browser has seen per account, one per snapshot read, while the app is open.
 * In memory only (never browser storage): it is a short trend, not chain history.
 */
const trendByAccount = new Map<string, number[]>();
let trendReadAt = 0;
function recordTrend(accounts: AccountSnapshot[], fetchedAt: number) {
  if (fetchedAt === trendReadAt) return;
  trendReadAt = fetchedAt;
  for (const a of accounts) {
    if (!(a.totalDebtUsd > 0)) continue;
    const hf = a.totalCollateralUsd / a.totalDebtUsd;
    if (!Number.isFinite(hf)) continue;
    trendByAccount.set(a.account, [...(trendByAccount.get(a.account) ?? []), hf].slice(-12));
  }
}

/** The connected wallet and its margin account, for the "YOU" pill and pinning. */
export function useYou() {
  const wallet = useUserStore((s) => s.address);
  const margin = useMarginAccountInfoStore((s) => (s.hasMarginAccount && s.marginAccountAddress ? s.marginAccountAddress : null));
  return { wallet: wallet ?? null, margin };
}

export interface AnalyticsData {
  rows: AccountRow[] | null;
  summary: ReturnType<typeof summarize> | null;
  pools: PoolRow[];
  poolTotals: ReturnType<typeof poolTotals>;
  poolsLoaded: boolean;
  /** Live Reflector prices by asset symbol (XLM, BLUSDC, AQUSDC, SOUSDC); null when the oracle returned none. */
  oraclePrices: Record<string, number | null>;
  oracleLoaded: boolean;
  oracleReadAt: number | null;
  /** Prices by price key (XLM, USDC, …) for liquidation prices and scenarios: oracle first, else the price the account lines were valued at. */
  prices: Record<string, number | null>;
  missingPrices: string[];
  fetchedAt: number | null;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => void;
}

/** Everything the analytics views need, from the existing live Stellar readers. */
export function useAnalyticsData(): AnalyticsData {
  const { wallet } = useYou();
  const snap = useAnalyticsSnapshot(wallet);
  const oracle = useOracleSnapshot();
  const poolsQ = usePoolsApi();

  const oraclePrices = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const p of oracle.data?.prices ?? []) out[p.symbol] = !p.isFallback && p.priceUsd > 0 ? p.priceUsd : null;
    return out;
  }, [oracle.data]);
  const missingPrices = useMemo(() => (oracle.data?.prices ?? []).filter((p) => p.isFallback).map((p) => p.symbol), [oracle.data]);

  const pools = useMemo(() => poolRows(poolsQ.data, oraclePrices), [poolsQ.data, oraclePrices]);

  const result = snap.result;
  const rows = useMemo(() => {
    if (!result) return null;
    recordTrend(result.accounts, result.fetchedAt);
    const apr = (symbol: string) => pools.find((p) => p.symbol === poolSymbolFor(symbol))?.borrowApr ?? null;
    return buildRows(result.accounts, apr, trendByAccount, result.fetchedAt);
  }, [result, pools]);
  const summary = useMemo(() => (rows ? summarize(rows) : null), [rows]);

  const prices = useMemo(() => {
    const out: Record<string, number | null> = {};
    // The price each line was valued at (usd ÷ amount), for assets the oracle read does not cover.
    for (const r of rows ?? []) {
      for (const l of [...r.collateral.filter((c) => c.kind !== "lp").map((c) => ({ key: c.underlying, amount: c.amount, usd: c.usd })), ...r.debts.map((d) => ({ key: priceKey(d.symbol), amount: d.amount, usd: d.usd }))]) {
        if (out[l.key] == null && l.amount > 0 && l.usd > 0) out[l.key] = l.usd / l.amount;
      }
    }
    if (oraclePrices.XLM) out.XLM = oraclePrices.XLM;
    const usdc = oraclePrices.BLUSDC ?? oraclePrices.AQUSDC ?? oraclePrices.SOUSDC ?? null;
    if (usdc) out.USDC = usdc;
    return out;
  }, [rows, oraclePrices]);

  const qc = useQueryClient();
  return {
    rows,
    summary,
    pools,
    poolTotals: poolTotals(pools),
    poolsLoaded: !!poolsQ.data,
    oraclePrices,
    oracleLoaded: !!oracle.data,
    oracleReadAt: oracle.data?.fetchedAt ?? null,
    prices,
    missingPrices,
    fetchedAt: result?.fetchedAt ?? null,
    isLoading: snap.isLoading,
    isRefreshing: snap.isRefreshing,
    error: oracle.error ?? (poolsQ.error instanceof Error ? poolsQ.error.message : null),
    refresh: () => { void snap.refresh(); void qc.invalidateQueries({ queryKey: ["analytics"] }); },
  };
}

export { useLiveEventFeed };

/** Stellar account (`G…`) or contract (`C…`) address. */
export const STELLAR_ADDR = /^[GC][A-Z2-7]{55}$/;

interface AccountApi {
  hasMarginAccount: boolean;
  marginAccountAddress?: string;
  collateralBalances?: Record<string, BorrowedBalance>;
  borrowedBalances?: Record<string, BorrowedBalance>;
  totalCollateralValue?: number;
  totalBorrowedValue?: number;
  error?: string;
}

async function readAccount(address: string): Promise<AccountApi> {
  const res = await fetch(`/api/account/${address}`);
  const body = (await res.json().catch(() => ({}))) as AccountApi;
  if (!res.ok) throw new Error(body.error ? `Could not read this account (${body.error}).` : `Could not read this account (${res.status}).`);
  return body;
}

/** Resolve a wallet or margin address to its margin account (read-only). Throws when it has none. */
export async function lookupAddress(address: string): Promise<string> {
  const a = await readAccount(address);
  if (!a.hasMarginAccount || !a.marginAccountAddress) throw new Error("No Vanna margin account was found for this address.");
  return a.marginAccountAddress;
}

const balancesToLines = (b: Record<string, BorrowedBalance> | undefined) =>
  Object.entries(b ?? {})
    .map(([symbol, x]) => ({ asset: symbol, symbol, decimals: 7, amount: parseFloat(x.amount) || 0, usd: parseFloat(x.usdValue) || 0 }))
    .filter((x) => x.amount > 0);

/**
 * One account for its own page: from the protocol snapshot when it is there (by margin account or owner
 * wallet), else read directly from the chain through `/api/account/[addr]` (the same read the Margin page uses).
 */
export function useAccountRow(address: string, data: AnalyticsData) {
  const fromList = useMemo(() => data.rows?.find((r) => r.address === address || r.owner === address) ?? null, [data.rows, address]);
  const direct = useQuery({
    queryKey: ["analytics", "v3-account", address],
    enabled: !!data.rows && !fromList && STELLAR_ADDR.test(address),
    queryFn: async (): Promise<AccountRow | null> => {
      const a = await readAccount(address);
      if (!a.hasMarginAccount || !a.marginAccountAddress) return null;
      const snapshot: AccountSnapshot = {
        account: a.marginAccountAddress,
        ownerProxy: address.startsWith("G") ? address : "",
        chainId: 0,
        collateral: balancesToLines(a.collateralBalances).map((l) => ({ ...l, type: "unknown" as const })),
        debt: balancesToLines(a.borrowedBalances),
        totalCollateralUsd: a.totalCollateralValue ?? 0,
        totalDebtUsd: a.totalBorrowedValue ?? 0,
        healthFactor: 0,
        leverage: 0,
        isHealthy: true,
      };
      const apr = (symbol: string) => data.pools.find((p) => p.symbol === poolSymbolFor(symbol))?.borrowApr ?? null;
      return buildRows([snapshot], apr, trendByAccount, Date.now())[0] ?? null;
    },
    staleTime: 15_000,
  });
  return {
    row: fromList ?? direct.data ?? null,
    inList: !!fromList,
    isLoading: data.isLoading || (!fromList && direct.isLoading && direct.fetchStatus !== "idle"),
    error: direct.error instanceof Error ? direct.error.message : null,
    notFound: !!data.rows && !fromList && (direct.data === null || !STELLAR_ADDR.test(address)),
  };
}
