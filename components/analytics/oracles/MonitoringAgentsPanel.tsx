"use client";

import { useMemo } from "react";
import type { AlertSeverity, AgentStatus } from "@/lib/analytics/oracle-agents/types";
import {
  useOracleAgentsSimulation,
  useOracleAgentsStore,
} from "@/lib/analytics/oracle-agents/store";
import { cn } from "@/lib/analytics/utils";

const agentStatusConfig: Record<
  AgentStatus,
  { label: string; dotClass: string; pillBg: string; pulse: boolean }
> = {
  Running: {
    label: "Running",
    dotClass: "bg-electric-400",
    pillBg: "bg-electric-100 text-electric-500",
    pulse: true,
  },
  Warning: {
    label: "Warning",
    dotClass: "bg-amber-400",
    pillBg: "bg-amber-500/15 text-amber-500",
    pulse: false,
  },
  Error: {
    label: "Error",
    dotClass: "bg-imperial-400",
    pillBg: "bg-imperial-100 text-imperial-400",
    pulse: false,
  },
  Paused: {
    label: "Paused",
    dotClass: "bg-vgray-300",
    pillBg: "bg-vgray-100 text-vgray-400",
    pulse: false,
  },
};

const severityDot: Record<AlertSeverity, string> = {
  critical: "bg-imperial-400",
  warning: "bg-amber-400",
  info: "bg-electric-400",
};

function timeAgo(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export default function MonitoringAgentsPanel() {
  useOracleAgentsSimulation(3000);
  const agents = useOracleAgentsStore((s) => s.agents);
  const alerts = useOracleAgentsStore((s) => s.alerts);
  const acknowledgeAlert = useOracleAgentsStore((s) => s.acknowledgeAlert);

  const sortedAlerts = useMemo(
    () => [...alerts].sort((a, b) => b.timestamp - a.timestamp),
    [alerts]
  );

  return (
    <div className="space-y-8">
      {/* Agents */}
      <div>
        <h3 className="text-sm font-bold text-vgray-800 mb-3">Monitoring agents — 24/7</h3>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {agents.map((agent) => {
            const cfg = agentStatusConfig[agent.status];
            return (
              <div
                key={agent.id}
                className="rounded-r4 border border-vgray-100 p-5 bg-surface shadow-vanna"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="text-[14px] font-bold truncate text-vgray-800">{agent.name}</p>
                    {agent.alertCount > 0 && (
                      <span className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full bg-imperial-500 text-white text-[10px] font-bold">
                        {agent.alertCount}
                      </span>
                    )}
                  </div>
                  <span
                    className={cn(
                      "shrink-0 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold",
                      cfg.pillBg
                    )}
                  >
                    <span
                      className={cn(
                        "w-1.5 h-1.5 rounded-full",
                        cfg.dotClass,
                        cfg.pulse && "animate-pulse"
                      )}
                    />
                    {cfg.label}
                  </span>
                </div>
                <p className="text-[12px] leading-relaxed mb-3 text-vgray-500">{agent.description}</p>
                <div className="flex items-center gap-4 text-[10px] font-mono text-vgray-400">
                  <span>Last: {timeAgo(agent.lastCheck)}</span>
                  <span className="text-vgray-300">|</span>
                  <span>Interval: {agent.interval}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Alert feed */}
      <div className="rounded-r4 border border-vgray-100 p-5 bg-surface shadow-vanna">
        <h3 className="text-sm font-bold text-vgray-800 mb-3">Alert feed</h3>
        <div className="max-h-80 overflow-y-auto pr-1 space-y-1 scrollbar-thin">
          {sortedAlerts.map((alert) => (
            <div
              key={alert.id}
              className={cn(
                "flex items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-surface-hover transition-colors",
                alert.acknowledged && "opacity-50"
              )}
            >
              <span
                className={cn(
                  "mt-1.5 shrink-0 w-2 h-2 rounded-full",
                  severityDot[alert.severity]
                )}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] font-bold text-vgray-700">{alert.agentName}</span>
                  <span className="text-[10px] text-vgray-400">{timeAgo(alert.timestamp)}</span>
                </div>
                <p className="text-[11px] leading-snug mt-0.5 text-vgray-500">{alert.message}</p>
              </div>
              {!alert.acknowledged && (
                <button
                  type="button"
                  onClick={() => acknowledgeAlert(alert.id)}
                  className="shrink-0 mt-0.5 px-2.5 py-1 rounded-md text-[10px] font-semibold bg-violet-100 text-violet-400 hover:bg-violet-500/20 transition-colors"
                >
                  Ack
                </button>
              )}
            </div>
          ))}
          {sortedAlerts.length === 0 && (
            <p className="text-[11px] text-center py-6 text-vgray-300">No alerts</p>
          )}
        </div>
      </div>
    </div>
  );
}
