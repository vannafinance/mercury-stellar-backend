// Shared, server-safe lending-pool stats for all earn pools (XLM, USDC
// variants). Powers both the cached /api/pools route and
// the client `usePoolData` hook, so the APY/exchange-rate math lives in one
// place. `getPoolStats` uses a throwaway keypair as its sim source, so this
// runs server-side with no wallet.

import { ContractService, ASSET_TYPES } from "@/lib/stellar-utils";
import { computeBorrowApr } from "@/lib/utils/borrow-rate";

// Matches RateModelContract's own SECS_PER_YEAR_U128 constant exactly, so the
// annualization here lines up with what the contract itself divides by when
// computing get_borrow_rate_per_sec.
const SECS_PER_YEAR = 31_556_952;

const toWad = (amount: number): bigint => BigInt(Math.floor(amount * 1e18));

/**
 * Borrow APY (%), read LIVE from the deployed RateModelContract's
 * `get_borrow_rate_per_sec(liquidity_wad, borrows_wad)` — the exact same
 * curve `lending-pool`'s own `get_rate_factor()` calls on-chain to accrue
 * interest. Falls back to the old synthetic kinked-utilization curve
 * (`computeBorrowApr`) if the on-chain read fails (RPC hiccup), so the page
 * degrades gracefully instead of showing "N/A".
 */
export const calculateBorrowAPY = async (
  liquidity: string,
  borrows: string,
  utilizationRate: string,
): Promise<string> => {
  const liquidityWad = toWad(parseFloat(liquidity) || 0);
  const borrowsWad = toWad(parseFloat(borrows) || 0);
  const ratePerSecWad = await ContractService.getBorrowRatePerSecWad(liquidityWad, borrowsWad);
  if (ratePerSecWad == null) {
    return computeBorrowApr(parseFloat(utilizationRate) || 0).toFixed(2);
  }
  // The contract divides by SECS_PER_YEAR to get a per-second rate; multiply
  // back (in bigint space, before any float conversion) to recover the
  // annual WAD-scaled rate, then convert WAD (1e18 == 100%) to a percentage.
  const annualRateWad = ratePerSecWad * BigInt(SECS_PER_YEAR);
  return (Number(annualRateWad) / 1e16).toFixed(2);
};

/**
 * Supply APY (%) — always a utilization-scaled fraction of the real borrow
 * APY. Vanna's lending pools take no ongoing reserve-factor cut on interest
 * (protocol revenue is the one-time origination fee at borrow time, not an
 * interest-rate spread — see lending-pool's `get_origination_fee`), so 100%
 * of borrower interest flows to suppliers: `supply = borrow × utilization`.
 * This makes supply <= borrow by construction, fixing the previous
 * independent/uncoupled formulas that let supply show HIGHER than borrow.
 */
export const calculateSupplyAPY = (borrowApyPct: number, utilizationRate: string): string => {
  const utilization = (parseFloat(utilizationRate) || 0) / 100;
  return (borrowApyPct * utilization).toFixed(2);
};

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

/** Enriched stats for all supported lending pools, keyed by asset. */
export type AllPoolStats = {
  XLM: PoolStats;
  USDC: PoolStats;
  AQUARIUS_USDC: PoolStats;
  SOROSWAP_USDC: PoolStats;
};

const enrich = async (s: RawPoolStats): Promise<PoolStats> => {
  const borrowAPY = await calculateBorrowAPY(s.availableLiquidity, s.totalBorrowed, s.utilizationRate);
  return {
    ...s,
    supplyAPY: calculateSupplyAPY(parseFloat(borrowAPY), s.utilizationRate),
    borrowAPY,
    exchangeRate: calculateExchangeRateFromPool(s.totalSupply, s.vTokenSupply),
  };
};

/** Read all lending pools concurrently and enrich with APY/exchange-rate. */
export async function computeAllPoolStats(): Promise<AllPoolStats> {
  const [xlm, usdc, aquarius, soroswap] = await Promise.all([
    ContractService.getPoolStats(ASSET_TYPES.XLM),
    ContractService.getPoolStats(ASSET_TYPES.USDC),
    ContractService.getPoolStats(ASSET_TYPES.AQUARIUS_USDC),
    ContractService.getPoolStats(ASSET_TYPES.SOROSWAP_USDC),
  ]);
  const [xlmE, usdcE, aquariusE, soroswapE] = await Promise.all([
    enrich(xlm),
    enrich(usdc),
    enrich(aquarius),
    enrich(soroswap),
  ]);
  return {
    XLM: xlmE,
    USDC: usdcE,
    AQUARIUS_USDC: aquariusE,
    SOROSWAP_USDC: soroswapE,
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
