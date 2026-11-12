/**
 * Pure derivations over the live lending-pool read (`/api/pools`, the same shared source the Earn
 * page uses) and the Reflector oracle read. A pool is valued in USD only when the oracle returned a
 * live price for its asset; otherwise its USD figures are null - never zero, never a reference price -
 * and totals say which pools they exclude.
 */
import type { AllPoolStats } from "@/lib/pool-stats";
import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";
import { finite } from "./format";

/** The four Vanna lending pools, in display order. `key` is the `/api/pools` key. */
export const POOLS = [
  { key: "XLM", symbol: "XLM", name: "Stellar Lumens", address: CONTRACT_ADDRESSES.LENDING_PROTOCOL_XLM },
  { key: "USDC", symbol: "BLUSDC", name: "Blend USDC", address: CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC },
  { key: "AQUARIUS_USDC", symbol: "AQUSDC", name: "Aquarius USDC", address: CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC },
  { key: "SOROSWAP_USDC", symbol: "SOUSDC", name: "Soroswap USDC", address: CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC },
] as const satisfies ReadonlyArray<{ key: keyof AllPoolStats; symbol: string; name: string; address: string }>;

/** Which pool a debt (or collateral) symbol belongs to, by its pool symbol. */
export function poolSymbolFor(symbol: string): string | null {
  const u = symbol.toUpperCase();
  if (u === "XLM") return "XLM";
  if (u === "USDC" || u === "BLUSDC" || u === "BLEND_USDC") return "BLUSDC";
  if (u === "AQUSDC" || u === "AQUARIUS_USDC") return "AQUSDC";
  if (u === "SOUSDC" || u === "SOROSWAP_USDC") return "SOUSDC";
  return null;
}

export interface PoolRow {
  symbol: string;
  name: string;
  address: string;
  /** Token units. */
  totalSupplied: number;
  totalBorrowed: number;
  availableLiquidity: number;
  vTokenSupply: number;
  /** Borrowed ÷ supplied (0..1). */
  utilization: number;
  /** Annual rates (0..1), null when the rate model could not be read. */
  borrowApr: number | null;
  supplyApr: number | null;
  /** Value of one deposit share in the pool's token. */
  exchangeRate: number | null;
  /** Live Reflector price, or null when the oracle did not return one. */
  price: number | null;
  valued: boolean;
  usdSupplied: number | null;
  usdBorrowed: number | null;
  usdCash: number | null;
}

export interface PoolTotals {
  supplied: number;
  borrowed: number;
  cash: number;
  ratio: number | null;
  partial: boolean;
  excluded: string[];
  maxUtilization: number | null;
  maxUtilizationSymbol: string | null;
  /** Debt-weighted borrow APR / supply-weighted supply APR across the valued pools. */
  borrowApr: number | null;
  supplyApr: number | null;
}

const n = (s: string | undefined) => {
  const v = parseFloat(s ?? "");
  return Number.isFinite(v) ? v : 0;
};
const rate = (s: string | undefined) => {
  const v = parseFloat(s ?? "");
  return Number.isFinite(v) ? v / 100 : null;
};

/** `prices` = live oracle prices by pool symbol (null when the oracle returned nothing usable). */
export function poolRows(api: AllPoolStats | undefined, prices: Record<string, number | null>): PoolRow[] {
  if (!api) return [];
  return POOLS.filter((p) => !!api[p.key]).map((p) => {
    const s = api[p.key];
    const price = prices[p.symbol] ?? null;
    const valued = finite(price) && price > 0;
    const supplied = n(s.totalSupply), borrowed = n(s.totalBorrowed), cash = n(s.availableLiquidity);
    const v = (x: number) => (valued ? x * (price as number) : null);
    const ex = parseFloat(s.exchangeRate);
    return {
      symbol: p.symbol, name: p.name, address: p.address,
      totalSupplied: supplied, totalBorrowed: borrowed, availableLiquidity: cash, vTokenSupply: n(s.vTokenSupply),
      utilization: n(s.utilizationRate) / 100,
      borrowApr: rate(s.borrowAPY), supplyApr: rate(s.supplyAPY),
      exchangeRate: Number.isFinite(ex) ? ex : null,
      price: valued ? price : null, valued,
      usdSupplied: v(supplied), usdBorrowed: v(borrowed), usdCash: v(cash),
    };
  });
}

export function poolTotals(rows: PoolRow[]): PoolTotals | null {
  const valued = rows.filter((r) => r.valued);
  if (!valued.length) return null;
  const supplied = valued.reduce((s, r) => s + (r.usdSupplied ?? 0), 0);
  const borrowed = valued.reduce((s, r) => s + (r.usdBorrowed ?? 0), 0);
  const cash = valued.reduce((s, r) => s + (r.usdCash ?? 0), 0);
  const top = [...rows].sort((a, b) => b.utilization - a.utilization)[0];
  const withBorrowApr = valued.filter((r) => r.borrowApr !== null);
  const bDebt = withBorrowApr.reduce((s, r) => s + (r.usdBorrowed ?? 0), 0);
  const withSupplyApr = valued.filter((r) => r.supplyApr !== null);
  const sSup = withSupplyApr.reduce((s, r) => s + (r.usdSupplied ?? 0), 0);
  return {
    supplied, borrowed, cash,
    ratio: supplied > 0 ? borrowed / supplied : null,
    partial: valued.length < rows.length,
    excluded: rows.filter((r) => !r.valued).map((r) => r.symbol),
    maxUtilization: top?.utilization ?? null,
    maxUtilizationSymbol: top?.symbol ?? null,
    borrowApr: bDebt > 0 ? withBorrowApr.reduce((s, r) => s + (r.borrowApr as number) * (r.usdBorrowed ?? 0), 0) / bDebt : null,
    supplyApr: sSup > 0 ? withSupplyApr.reduce((s, r) => s + (r.supplyApr as number) * (r.usdSupplied ?? 0), 0) / sSup : null,
  };
}
