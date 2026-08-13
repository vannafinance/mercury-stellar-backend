'use client';

/**
 * Analytics tab for an earn pool. Current APY comes directly from the lending
 * pool; no browser-generated time series is presented as protocol history.
 */
import { useMemo } from "react";
import { Chart } from "./chart";
import { usePoolData } from "@/hooks/use-earn";
import { useSelectedPoolStore } from "@/store/selected-pool-store";

const toInternalAsset = (value: string): string => {
  if (value === "AqUSDC" || value === "AQUARIUS_USDC") return "AQUARIUS_USDC";
  if (value === "SoUSDC" || value === "SOROSWAP_USDC") return "SOROSWAP_USDC";
  if (value === "BLUSDC") return "USDC";
  return value.toUpperCase();
};

/**
 * Reads the selected pool's live APYs and renders an honest current-rate line.
 * Historical APY should be added only when an indexer-backed series exists.
 */
export const AnalyticsTab = () => {
  const { pools } = usePoolData();
  const selectedAsset = useSelectedPoolStore((state) => state.selectedAsset);
  const assetKey = toInternalAsset(selectedAsset);
  const { supplyAPY, borrowAPY, supplyPct } = useMemo(() => {
    const pool = pools[assetKey as keyof typeof pools] ?? pools.XLM;
    const supplyPct = parseFloat(pool?.supplyAPY || '0');
    const borrowPct = parseFloat(pool?.borrowAPY || '0');

    return {
      supplyAPY: supplyPct / 100,
      borrowAPY: borrowPct / 100,
      supplyPct,
    };
  }, [pools, assetKey]);

  const apyChartData = useMemo(() => {
    const now = Date.now();
    const amount = Number.isFinite(supplyPct) ? parseFloat(supplyPct.toFixed(2)) : 0;
    return [
      { date: new Date(now - 60_000).toISOString(), amount },
      { date: new Date(now).toISOString(), amount },
    ];
  }, [supplyPct]);

  return (
    <section className="w-full flex-1 min-h-0" aria-label="Analytics Dashboard">
      <figure className="w-full h-full">
        <Chart
          type="deposit-apy"
          currencyTab={true}
          height={393}
          containerWidth="w-full"
          containerHeight="h-full"
          supplyAPY={supplyAPY}
          borrowAPY={borrowAPY}
          customData={apyChartData}
        />
      </figure>
    </section>
  );
};
