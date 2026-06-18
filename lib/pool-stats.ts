// Shared, server-safe lending-pool stats for the 4 pools (XLM, USDC,
// AQUARIUS_USDC, SOROSWAP_USDC). Powers both the cached /api/pools route and
// the client `usePoolData` hook, so the APY/exchange-rate math lives in one
// place. `getPoolStats` uses a throwaway keypair as its sim source, so this
// runs server-side with no wallet.

import { ContractService, ASSET_TYPES } from "@/lib/stellar-utils";
import { computeBorrowApr } from "@/lib/utils/borrow-rate";

export const calculateSupplyAPY = (utilizationRate: string): string => {
  const utilization = parseFloat(utilizationRate) / 100;
  return (2.0 + utilization * 10).toFixed(2);
};

export const calculateBorrowAPY = (utilizationRate: string): string =>
  computeBorrowApr(parseFloat(utilizationRate) || 0).toFixed(2);

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

export type PoolStats = RawPoolStats & {
  supplyAPY: string;
  borrowAPY: string;
  exchangeRate: string;
};

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
