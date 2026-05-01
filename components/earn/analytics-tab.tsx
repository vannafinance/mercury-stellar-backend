'use client';

import { useEffect, useMemo, useState } from "react";
import { Chart } from "./chart";
import { usePoolData } from "@/hooks/use-earn";
import { useSelectedPoolStore } from "@/store/selected-pool-store";

const toInternalAsset = (value: string): string => {
  if (value === "AqUSDC" || value === "AQUARIUS_USDC") return "AQUARIUS_USDC";
  if (value === "SoUSDC" || value === "SOROSWAP_USDC") return "SOROSWAP_USDC";
  if (value === "BLUSDC") return "USDC";
  return value.toUpperCase();
};

type ApySnapshot = {
  timestamp: number;
  supplyPct: number;
};

const HISTORY_MAX_ITEMS = 3000;
const SAMPLE_MIN_GAP_MS = 30_000;

const getHistoryKey = (assetKey: string) => `vanna_earn_apy_history_v2_${assetKey}`;

const normalizeTimestamp = (value: unknown): number => {
  const ts = Number(value ?? 0);
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return ts < 1_000_000_000_000 ? ts * 1000 : ts;
};

const readApyHistory = (assetKey: string): ApySnapshot[] => {
  if (typeof window === "undefined" || !assetKey) return [];
  try {
    const raw = window.localStorage.getItem(getHistoryKey(assetKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        timestamp: normalizeTimestamp(item?.timestamp),
        supplyPct: Number(item?.supplyPct ?? 0),
      }))
      .filter((item) => item.timestamp > 0 && Number.isFinite(item.supplyPct))
      .sort((a, b) => a.timestamp - b.timestamp);
  } catch {
    return [];
  }
};

const writeApyHistory = (assetKey: string, snapshots: ApySnapshot[]) => {
  if (typeof window === "undefined" || !assetKey) return;
  window.localStorage.setItem(getHistoryKey(assetKey), JSON.stringify(snapshots.slice(-HISTORY_MAX_ITEMS)));
};

const toApyChartData = (snapshots: ApySnapshot[]): Array<{ date: string; amount: number }> => {
  if (snapshots.length === 0) return [];
  const points = snapshots.map((item) => ({
    date: new Date(item.timestamp).toISOString(),
    amount: parseFloat(item.supplyPct.toFixed(2)),
  }));
  if (points.length >= 2) return points;
  const firstTs = snapshots[0].timestamp;
  const prevTs = Math.max(firstTs - 60_000, firstTs - 1);
  return [
    { date: new Date(prevTs).toISOString(), amount: points[0].amount },
    points[0],
  ];
};

export const AnalyticsTab = () => {
  const { pools } = usePoolData();
  const selectedAsset = useSelectedPoolStore((state) => state.selectedAsset);
  const assetKey = toInternalAsset(selectedAsset);
  const [apyHistory, setApyHistory] = useState<ApySnapshot[]>([]);

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

  useEffect(() => {
    const next = readApyHistory(assetKey);
    queueMicrotask(() => setApyHistory(next));
  }, [assetKey]);

  useEffect(() => {
    if (!assetKey || !Number.isFinite(supplyPct)) return;

    queueMicrotask(() => {
      setApyHistory((prev) => {
        const now = Date.now();
        const last = prev[prev.length - 1];
        const changed = !last || Math.abs(last.supplyPct - supplyPct) >= 0.01;
        const enoughTimePassed = !last || now - last.timestamp >= SAMPLE_MIN_GAP_MS;

        if (!changed && !enoughTimePassed) return prev;

        const next = [...prev, { timestamp: now, supplyPct }].slice(-HISTORY_MAX_ITEMS);
        writeApyHistory(assetKey, next);
        return next;
      });
    });
  }, [assetKey, supplyPct]);

  const apyChartData = useMemo(() => toApyChartData(apyHistory), [apyHistory]);

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
