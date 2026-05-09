"use client";

import type { OracleStatus } from "@/lib/analytics/oracle-agents/types";
import {
  useOracleAgentsSimulation,
  useOracleAgentsStore,
} from "@/lib/analytics/oracle-agents/store";
import { cn } from "@/lib/analytics/utils";

const oracleStatusConfig: Record<
  OracleStatus,
  { label: string; color: string; border: string; bgClass: string }
> = {
  healthy: {
    label: "Healthy",
    color: "#10b981",
    border: "border-electric-500/40",
    bgClass: "bg-electric-100 text-electric-500",
  },
  warning: {
    label: "Warning",
    color: "#f59e0b",
    border: "border-amber-500/40",
    bgClass: "bg-amber-500/15 text-amber-500",
  },
  stale: {
    label: "Stale",
    color: "#ef4444",
    border: "border-imperial-400/40",
    bgClass: "bg-imperial-100 text-imperial-400",
  },
};

export default function OraclesAgentsPanel() {
  useOracleAgentsSimulation(3000);
  const oracles = useOracleAgentsStore((s) => s.oracles);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-base font-bold tracking-tight text-vgray-800">
          Oracle pricing integrity
        </h2>
        <p className="text-sm mt-1 text-vgray-500">
          Oracle pricing freshness and source status
        </p>
      </div>

      {/* Oracle cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {oracles.map((oracle) => {
          const cfg = oracleStatusConfig[oracle.status];
          return (
            <div
              key={oracle.asset}
              className={cn(
                "rounded-r4 border p-5 bg-surface shadow-vanna",
                cfg.border
              )}
            >
              <div className="flex items-center justify-between mb-3">
                <p className="text-[14px] font-bold text-vgray-800">{oracle.asset}</p>
                <span
                  className={cn(
                    "inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold",
                    cfg.bgClass
                  )}
                >
                  {cfg.label}
                </span>
              </div>
              <p className="text-[11px] text-vgray-500 mb-3">
                Source: <span className="text-vgray-700">{oracle.source}</span>
              </p>
              <div className="rounded-lg p-3 bg-vgray-50 border border-vgray-100">
                <p className="text-[10px] uppercase tracking-wide font-medium mb-1 text-vgray-400">
                  Freshness
                </p>
                <div className="flex items-baseline gap-1">
                  <span
                    key={oracle.freshnessSeconds}
                    className="text-[20px] font-bold font-mono text-vgray-800 tabular-nums"
                  >
                    {oracle.freshnessSeconds}
                  </span>
                  <span className="text-[11px] text-vgray-500">seconds ago</span>
                </div>
                <div className="mt-2 h-1 rounded-full overflow-hidden bg-vgray-200">
                  <div
                    className="h-full rounded-full transition-all duration-500 ease-out"
                    style={{
                      width: `${Math.min((oracle.freshnessSeconds / 120) * 100, 100)}%`,
                      backgroundColor: cfg.color,
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
