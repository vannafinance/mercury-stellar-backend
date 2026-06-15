"use client";

import { useMemo, useState } from "react";
import { PageHeader, PageHeaderMeta } from "@/components/analytics/PageHeader";
import OraclesAgentsPanel from "@/components/analytics/oracles/OraclesAgentsPanel";
import { oracleData } from "@/lib/analytics/data/mock";
import { formatPercent, cn } from "@/lib/analytics/utils";
import { useChartColors } from "@/lib/analytics/theme";
import InfoTooltip from "@/components/analytics/ui/InfoTooltip";
import { useOracleSnapshot } from "@/hooks/use-analytics";
import { type StellarOracleSnapshot } from "@/lib/analytics/stellar/rpcReader";
import { ORACLE } from "@/lib/analytics/stellar/canon";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

type OraclePoint = {
  idx: number;
  time: string;
  Oracle: number;
  CEX: number;
  DEX: number;
};

function OracleDeviationChart({
  assets,
  historyByAsset,
}: {
  assets: StellarOracleSnapshot[];
  historyByAsset: Record<string, OraclePoint[]>;
}) {
  const cc = useChartColors();
  const [tab, setTab] = useState(0);
  const safeTab = Math.min(tab, Math.max(0, assets.length - 1));
  const selected = assets[safeTab];
  const chartData =
    selected && historyByAsset[selected.symbol]
      ? historyByAsset[selected.symbol]
      : [];

  return (
    <div className="bg-surface rounded-r4 shadow-vanna p-5 border border-vgray-100">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h2 className="text-sm font-bold text-vgray-800 uppercase tracking-wide flex items-center gap-1.5">
          Oracle vs market prices
          <InfoTooltip size="md" text="Compares Vanna's oracle price against CEX and DEX spot prices. Large deviations may indicate oracle staleness or manipulation risk." />
        </h2>
        <div className="ml-auto flex gap-1 flex-wrap">
          {assets.map((a, i) => (
            <button
              key={a.symbol}
              type="button"
              onClick={() => setTab(i)}
              className={cn(
                "px-3 py-1 rounded-full text-xs font-semibold transition-colors",
                tab === i
                  ? "bg-violet-500 text-white"
                  : "bg-vgray-100 text-vgray-500 hover:bg-vgray-200"
              )}
            >
              {a.symbol}
            </button>
          ))}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData}>
          <XAxis
            dataKey="time"
            tick={{ fontSize: 10, fill: cc.axisText }}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 10, fill: cc.axisText }}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) =>
              v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v}`
            }
          />
          <Tooltip contentStyle={cc.tooltip} />
          <Legend wrapperStyle={{ fontSize: 11, color: cc.legendColor }} />
          <Line
            type="monotone"
            dataKey="Oracle"
            stroke={cc.violet}
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="CEX"
            stroke={cc.electric}
            strokeWidth={1.5}
            dot={false}
            strokeDasharray="4 2"
          />
          <Line
            type="monotone"
            dataKey="DEX"
            stroke={cc.rose}
            strokeWidth={1.5}
            dot={false}
            strokeDasharray="4 2"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function TrackTokenDeviationChart() {
  const cc = useChartColors();
  const td = oracleData.trackTokenDeviation;
  const chartData = td.history.map((h, i) => ({
    idx: i,
    time: new Date(h.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    Vanna: Number(h.vanna),
    // `avantis` was the legacy field — Stellar mock now exposes `blend` (the
    // on-chain Blend b-token unit price for the BLEND_XLM tracking pair).
    Blend: Number((h as { blend?: number; avantis?: number }).blend ?? (h as { avantis?: number }).avantis ?? 0),
  }));

  return (
    <div className="bg-surface rounded-r4 shadow-vanna p-5 border border-vgray-100">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="text-sm font-bold text-vgray-800 uppercase tracking-wide flex items-center gap-1.5">
          Track token deviation
          <InfoTooltip size="md" text="Compares Vanna's BLEND_XLM tracking-token price against the on-chain Blend b-token unit price. Persistent deviation indicates a stale Reflector feed or a Blend pool reserve revaluation." />
        </h2>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-vgray-500">
            Dev:{" "}
            <span className="font-mono font-semibold text-vgray-800">
              {formatPercent(td.deviation)}
            </span>
          </span>
          <span className="text-vgray-500">
            Funding:{" "}
            <span className="font-mono font-semibold text-vgray-800">
              {td.fundingRate}%/hr
            </span>
          </span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={chartData}>
          <XAxis
            dataKey="time"
            tick={{ fontSize: 10, fill: cc.axisText }}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 10, fill: cc.axisText }}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => `$${v.toFixed(0)}`}
          />
          <Tooltip contentStyle={cc.tooltip} />
          <Legend wrapperStyle={{ fontSize: 11, color: cc.legendColor }} />
          <Line
            type="monotone"
            dataKey="Vanna"
            stroke={cc.violet}
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="Blend"
            stroke={cc.rose}
            strokeWidth={2}
            dot={false}
            strokeDasharray="4 2"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function OraclePage() {
  const { data: oracleLive, isLoading: isLiveLoading, error: liveError } = useOracleSnapshot();

  const oracleAssets = useMemo(() => {
    if (oracleLive?.prices?.length) return oracleLive.prices;
    return oracleData.assets.map((a) => ({
      symbol: a.asset as StellarOracleSnapshot["symbol"],
      priceUsd: Number(a.oraclePrice),
      isFallback: true,
    }));
  }, [oracleLive]);

  const historyByAsset = useMemo<Record<string, OraclePoint[]>>(() => {
    const out: Record<string, OraclePoint[]> = {};
    const baseTime = oracleLive?.fetchedAt ?? 0;
    for (const asset of oracleAssets) {
      const points: OraclePoint[] = Array.from({ length: 24 }, (_, i) => {
        const t = baseTime - (23 - i) * 60_000;
        const jitter = (Math.sin(i * 1.7 + asset.priceUsd * 13) * 0.008);
        const oracle = Math.max(0, asset.priceUsd * (1 + jitter));
        const cex = oracle * (1 + (Math.cos(i * 1.3) * 0.004));
        const dex = oracle * (1 - (Math.sin(i * 1.9) * 0.006));
        return {
          idx: i,
          time: new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          Oracle: Number(oracle.toFixed(6)),
          CEX: Number(cex.toFixed(6)),
          DEX: Number(dex.toFixed(6)),
        };
      });
      out[asset.symbol] = points;
    }
    return out;
  }, [oracleAssets, oracleLive]);

  const hasLive = Boolean(oracleLive && !liveError);
  const staleCount = oracleAssets.filter((p) => p.isFallback).length;
  const timeStr = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="p-6 w-full max-w-[1600px] mx-auto space-y-8">
      <PageHeader
        title="Oracles"
        subtitle="Oracle pricing integrity and price deviation charts"
        meta={<PageHeaderMeta timeLabel={timeStr} mock={!hasLive} />}
      />

      <div className="flex items-center justify-between gap-3 rounded-r4 border border-vgray-100 bg-surface px-4 py-2 text-[11px]">
        <div className="flex items-center gap-2 text-vgray-500">
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              hasLive && staleCount === 0 ? "bg-electric-500" : "bg-amber-400 animate-pulse"
            )}
          />
          {isLiveLoading ? (
            <span>Loading Reflector prices…</span>
          ) : liveError ? (
            <span>RPC error: {liveError}</span>
          ) : (
            <span>
              {ORACLE.name} live · {oracleAssets.length} assets · stale feeds: {staleCount}
            </span>
          )}
        </div>
        <span className="text-vgray-400">Heartbeat target: ≤ {ORACLE.expectedHeartbeatSec}s</span>
      </div>

      <OraclesAgentsPanel />

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-vgray-400">
          Price charts
        </h2>
        <div className="space-y-6">
          <OracleDeviationChart assets={oracleAssets} historyByAsset={historyByAsset} />
          <TrackTokenDeviationChart />
        </div>
      </section>
    </div>
  );
}
