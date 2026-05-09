// Direct Soroban RPC reader for analytics. Wraps the existing
// `ContractService` (lib/stellar-utils.ts) and `oracle-price.ts`
// helpers and re-shapes their output for chart/aggregator consumers.
//
// No indexer, no backend job: every call here resolves through the
// public Soroban RPC. We keep call fan-out tight (Promise.all batches)
// and rely on the existing oracle-price cache to dedupe price lookups.

import { ContractService, ASSET_TYPES, type AssetType } from "@/lib/stellar-utils";
import { fetchTokenPrices, getCachedTokenPrice } from "@/lib/oracle-price";
import { ACTIVE_ASSETS, FALLBACK_PRICES, ORACLE, type StellarAsset } from "./canon";

const POOL_ASSETS: AssetType[] = [
  ASSET_TYPES.XLM,
  ASSET_TYPES.USDC, // Blend USDC pool
  ASSET_TYPES.AQUARIUS_USDC,
  ASSET_TYPES.SOROSWAP_USDC,
];

/** Map a pool AssetType to the canonical app symbol used in the UI. */
const ASSET_TYPE_TO_SYMBOL: Record<AssetType, StellarAsset> = {
  XLM: "XLM",
  USDC: "BLUSDC",
  BLEND_USDC: "BLUSDC",
  AQUARIUS_USDC: "AQUSDC",
  SOROSWAP_USDC: "SOUSDC",
};

export type StellarPoolStats = {
  symbol: StellarAsset;
  assetType: AssetType;
  totalSupply: number;       // human units
  totalBorrowed: number;
  availableLiquidity: number;
  utilizationRate: number;   // percent 0–100
  vTokenSupply: number;
  /** USD-denominated totals using cached oracle price. */
  totalSupplyUsd: number;
  totalBorrowedUsd: number;
  availableLiquidityUsd: number;
  /** Live price snapshot (post-fetch) used to compute USD totals. */
  priceUsd: number;
};

export type StellarOracleSnapshot = {
  symbol: StellarAsset;
  priceUsd: number;
  /** True when we used a static fallback (RPC missed). UI surfaces this
   *  as a yellow "stale" badge on the Oracles page. */
  isFallback: boolean;
};

export type StellarAnalyticsSource = {
  pools: StellarPoolStats[];
  oracle: {
    name: string;
    contractAddress: string;
    expectedHeartbeatSec: number;
    prices: StellarOracleSnapshot[];
    /** Block ledger-sequence (or `Date.now()` proxy) for "last updated". */
    fetchedAt: number;
  };
  /** Aggregated totals across the 4 pools — drives Protocol Overview KPIs. */
  totals: {
    totalSupplyUsd: number;
    totalBorrowedUsd: number;
    availableLiquidityUsd: number;
    avgUtilization: number;
  };
};

/** Read every supported lending pool's stats in parallel. Each pool
 *  failure degrades gracefully to zeros (so the dashboard still loads
 *  if one pool's RPC times out). */
export async function readAllPoolStats(): Promise<StellarPoolStats[]> {
  // Warm the price cache for everything we're about to need.
  await fetchTokenPrices([...ACTIVE_ASSETS]).catch(() => undefined);

  const results = await Promise.allSettled(
    POOL_ASSETS.map(async (a) => {
      const stats = await ContractService.getPoolStats(a);
      const sym = ASSET_TYPE_TO_SYMBOL[a];
      const priceUsd = getCachedTokenPrice(sym) || FALLBACK_PRICES[sym] || 0;
      const totalSupply = parseFloat(stats.totalSupply) || 0;
      const totalBorrowed = parseFloat(stats.totalBorrowed) || 0;
      const availableLiquidity = parseFloat(stats.availableLiquidity) || 0;
      const utilizationRate = parseFloat(stats.utilizationRate) || 0;
      const vTokenSupply = parseFloat(stats.vTokenSupply) || 0;
      return {
        symbol: sym,
        assetType: a,
        totalSupply,
        totalBorrowed,
        availableLiquidity,
        utilizationRate,
        vTokenSupply,
        totalSupplyUsd: totalSupply * priceUsd,
        totalBorrowedUsd: totalBorrowed * priceUsd,
        availableLiquidityUsd: availableLiquidity * priceUsd,
        priceUsd,
      } satisfies StellarPoolStats;
    }),
  );

  return results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const a = POOL_ASSETS[i];
    const sym = ASSET_TYPE_TO_SYMBOL[a];
    return {
      symbol: sym,
      assetType: a,
      totalSupply: 0,
      totalBorrowed: 0,
      availableLiquidity: 0,
      utilizationRate: 0,
      vTokenSupply: 0,
      totalSupplyUsd: 0,
      totalBorrowedUsd: 0,
      availableLiquidityUsd: 0,
      priceUsd: FALLBACK_PRICES[sym] || 0,
    } satisfies StellarPoolStats;
  });
}

/** Probe Reflector via the canonical OracleContract for every active
 *  asset. Returns a price snapshot per asset, marked `isFallback` when
 *  the RPC returned nothing parseable. */
export async function readOracleSnapshot(): Promise<StellarAnalyticsSource["oracle"]> {
  const fetched = await fetchTokenPrices([...ACTIVE_ASSETS]).catch(() => ({}) as Record<string, number>);
  const prices: StellarOracleSnapshot[] = ACTIVE_ASSETS.map((sym) => {
    const live = fetched[sym];
    if (typeof live === "number" && live > 0) {
      return { symbol: sym, priceUsd: live, isFallback: false };
    }
    return { symbol: sym, priceUsd: FALLBACK_PRICES[sym] || 0, isFallback: true };
  });
  return {
    name: ORACLE.name,
    contractAddress: ORACLE.contractAddress,
    expectedHeartbeatSec: ORACLE.expectedHeartbeatSec,
    prices,
    fetchedAt: Date.now(),
  };
}

/** Top-level RPC fan-out used by the Protocol Overview page. Resolves
 *  pool stats + oracle prices in parallel and rolls them up into a
 *  single object for downstream KPI cards. */
export async function readAnalyticsSource(): Promise<StellarAnalyticsSource> {
  const [pools, oracle] = await Promise.all([readAllPoolStats(), readOracleSnapshot()]);
  const totalSupplyUsd = pools.reduce((acc, p) => acc + p.totalSupplyUsd, 0);
  const totalBorrowedUsd = pools.reduce((acc, p) => acc + p.totalBorrowedUsd, 0);
  const availableLiquidityUsd = pools.reduce((acc, p) => acc + p.availableLiquidityUsd, 0);
  const avgUtilization =
    pools.length > 0
      ? pools.reduce((acc, p) => acc + p.utilizationRate, 0) / pools.length
      : 0;
  return {
    pools,
    oracle,
    totals: { totalSupplyUsd, totalBorrowedUsd, availableLiquidityUsd, avgUtilization },
  };
}
