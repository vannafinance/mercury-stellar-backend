// Shared, server-safe lending-pool stats for the 4 pools (XLM, USDC,
// AQUARIUS_USDC, SOROSWAP_USDC). Powers both the cached /api/pools route and
// the client `usePoolData` hook, so the APY/exchange-rate math lives in one
// place. `getPoolStats` uses a throwaway keypair as its sim source, so this
// runs server-side with no wallet.

import { ContractService, ASSET_TYPES } from "@/lib/stellar-utils";
import { computeBorrowApr } from "@/lib/utils/borrow-rate";

/**
 * Supply APY (%) for a lending pool, as a function of its utilization. Linear
 * model: 2% floor + up to 10% at full utilization, mirroring the lender's share
 * of borrow interest. `utilizationRate` is a percentage string (e.g. "73.50").
 */
export const calculateSupplyAPY = (utilizationRate: string): string => {
  const utilization = parseFloat(utilizationRate) / 100;
  return (2.0 + utilization * 10).toFixed(2);
};

/**
 * Borrow APY (%) for a lending pool from its utilization percentage string,
 * delegating to the shared kinked-curve {@link computeBorrowApr}.
 */
export const calculateBorrowAPY = (utilizationRate: string): string =>
  computeBorrowApr(parseFloat(utilizationRate) || 0).toFixed(2);

/**
 * vToken→underlying exchange rate = `totalAssets / vTokenSupply`, formatted to
 * 7 decimals. Accrued interest pushes it above 1 over time. Returns "1" when
 * either input is non-positive (fresh/empty pool).
 */
export const calculateExchangeRateFromPool = (
  totalAssets: string,
  vTokenSupply: string,
): string => {
  const assets = parseFloat(totalAssets) || 0;
  const supply = parseFloat(vTokenSupply) || 0;
  // Rate = total_assets / vToken_supply; interest pushes it above 1.
  if (assets <= 0 || supply <= 0) return "1";
  return (assets / supply).toFixed(7);
};

type RawPoolStats = Awaited<ReturnType<typeof ContractService.getPoolStats>>;

/** On-chain pool stats enriched with the three derived display fields. */
export type PoolStats = RawPoolStats & {
  supplyAPY: string;
  borrowAPY: string;
  exchangeRate: string;
};

/** Enriched stats for all four supported lending pools, keyed by asset. */
export type AllPoolStats = {
  XLM: PoolStats;
  USDC: PoolStats;
  AQUARIUS_USDC: PoolStats;
  SOROSWAP_USDC: PoolStats;
};

const enrich = (s: RawPoolStats): PoolStats => ({
  ...s,
  supplyAPY: calculateSupplyAPY(s.utilizationRate),
  borrowAPY: calculateBorrowAPY(s.utilizationRate),
  exchangeRate: calculateExchangeRateFromPool(s.totalSupply, s.vTokenSupply),
});

/** Read all 4 lending pools concurrently and enrich with APY/exchange-rate. */
export async function computeAllPoolStats(): Promise<AllPoolStats> {
  const [xlm, usdc, aquarius, soroswap] = await Promise.all([
    ContractService.getPoolStats(ASSET_TYPES.XLM),
    ContractService.getPoolStats(ASSET_TYPES.USDC),
    ContractService.getPoolStats(ASSET_TYPES.AQUARIUS_USDC),
    ContractService.getPoolStats(ASSET_TYPES.SOROSWAP_USDC),
  ]);
  return {
    XLM: enrich(xlm),
    USDC: enrich(usdc),
    AQUARIUS_USDC: enrich(aquarius),
    SOROSWAP_USDC: enrich(soroswap),
  };
}

// Shared 30s in-memory memo so the two edge routes that need pool stats
// (`/api/pools` and `/api/analytics/pool-stats`) don't each fire their own
// 4-pool RPC read within the same serverless instance — the first call scans,
// the second reuses it. The per-route edge cache (s-maxage 30s) shares across
// instances/visitors; this collapses the duplicate read within one instance.
let poolStatsCache: { data: AllPoolStats; ts: number } | null = null;
const POOL_STATS_TTL_MS = 30_000;

/**
 * `computeAllPoolStats` behind a 30s in-memory memo — the single source of pool
 * stats for every caller (the `/api/pools` route and the analytics pool-stats
 * reader), so the 4-pool RPC read isn't duplicated.
 */
export async function getAllPoolStats(): Promise<AllPoolStats> {
  const now = Date.now();
  if (poolStatsCache && now - poolStatsCache.ts < POOL_STATS_TTL_MS) {
    return poolStatsCache.data;
  }
  const data = await computeAllPoolStats();
  poolStatsCache = { data, ts: now };
  return data;
}
