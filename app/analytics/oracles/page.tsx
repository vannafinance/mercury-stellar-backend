"use client";

import { useState } from "react";
import { PageHeader, PageHeaderMeta } from "@/components/analytics/PageHeader";
import OraclesAgentsPanel from "@/components/analytics/oracles/OraclesAgentsPanel";
import { oracleData } from "@/lib/analytics/data/mock";
import { formatPercent, cn } from "@/lib/analytics/utils";
import { useChartColors } from "@/lib/analytics/theme";
import InfoTooltip from "@/components/analytics/ui/InfoTooltip";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

function OracleDeviationChart() {
  const cc = useChartColors();
  const [tab, setTab] = useState(0);
  const asset = oracleData.assets[tab];

  const chartData = asset.history.map((h, i) => ({
    idx: i,
    time: new Date(h.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    Oracle: Number(h.oracle),
    CEX: Number(h.cex),
    DEX: Number(h.dex),
  }));

  return (
    <div className="bg-surface rounded-r4 shadow-vanna p-5 border border-vgray-100">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h2 className="text-sm font-bold text-vgray-800 uppercase tracking-wide flex items-center gap-1.5">
          Oracle vs market prices
          <InfoTooltip size="md" text="Compares Vanna's oracle price against CEX and DEX spot prices. Large deviations may indicate oracle staleness or manipulation risk." />
        </h2>
        <div className="ml-auto flex gap-1 flex-wrap">
          {oracleData.assets.map((a, i) => (
            <button
              key={a.asset}
              type="button"
              onClick={() => setTab(i)}
              className={cn(
                "px-3 py-1 rounded-full text-xs font-semibold transition-colors",
                tab === i
                  ? "bg-violet-500 text-white"
                  : "bg-vgray-100 text-vgray-500 hover:bg-vgray-200"
              )}
            >
              {a.asset}
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
    Avantis: Number(h.avantis),
  }));

  return (
    <div className="bg-surface rounded-r4 shadow-vanna p-5 border border-vgray-100">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="text-sm font-bold text-vgray-800 uppercase tracking-wide flex items-center gap-1.5">
          Track token deviation
          <InfoTooltip size="md" text="Tracks Vanna's synthetic token price vs Avantis reference. Persistent deviation triggers funding rate adjustments to bring prices back in line." />
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
            dataKey="Avantis"
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
  const timeStr = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="p-6 w-full max-w-[1600px] mx-auto space-y-8">
      <PageHeader
        title="Oracles"
        subtitle="Oracle pricing integrity and price deviation charts"
        meta={<PageHeaderMeta timeLabel={timeStr} />}
      />

      <OraclesAgentsPanel />

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-vgray-400">
          Price charts
        </h2>
        <div className="space-y-6">
          <OracleDeviationChart />
          <TrackTokenDeviationChart />
        </div>
      </section>
    </div>
  );
}
