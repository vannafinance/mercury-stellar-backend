"use client";

import { useState, useMemo } from "react";
import { PageHeader, PageHeaderMeta } from "@/components/analytics/PageHeader";
import { alertsData } from "@/lib/analytics/data/mock";
import { formatTimeAgo, cn } from "@/lib/analytics/utils";
import type { AlertPriority } from "@/lib/analytics/data/mock";
import InfoTooltip from "@/components/analytics/ui/InfoTooltip";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useUserStore } from "@/store/user";

const priorityConfig: Record<AlertPriority, { bg: string; text: string; border: string; label: string }> = {
  P0: { bg: "bg-imperial-500", text: "text-white", border: "border-l-imperial-500", label: "EMERGENCY" },
  P1: { bg: "bg-rose-500", text: "text-white", border: "border-l-rose-500", label: "CRITICAL" },
  P2: { bg: "bg-amber-500", text: "text-white", border: "border-l-amber-500", label: "WARNING" },
  P3: { bg: "bg-vgray-300", text: "text-white", border: "border-l-vgray-300", label: "INFO" },
};

function PriorityBadge({ priority }: { priority: AlertPriority }) {
  const c = priorityConfig[priority];
  return (
    <span className={cn("px-2 py-0.5 rounded-rfull text-[10px] font-bold", c.bg, c.text)}>
      {priority}
    </span>
  );
}

function AlertCard({ alert }: { alert: typeof alertsData.active[0] }) {
  const c = priorityConfig[alert.priority];
  return (
    <div className={cn("bg-surface rounded-r3 shadow-vanna p-4 border-l-[4px] flex items-start gap-4", c.border,
      alert.acknowledged && "opacity-60"
    )}>
      <PriorityBadge priority={alert.priority} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-vgray-800">{alert.message}</p>
        <div className="flex items-center gap-3 mt-1.5">
          <span className="text-xs text-vgray-400">{formatTimeAgo(alert.timestamp)}</span>
          <span className="text-xs px-1.5 py-0.5 rounded-r1 bg-vgray-50 text-vgray-500 font-mono">{alert.metric}</span>
          <span className="text-xs text-vgray-400">
            Value: <span className="font-mono font-semibold text-vgray-700">{alert.value}</span>
            {" "}(threshold: {alert.threshold})
          </span>
          {alert.chain && (
            <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded-rfull",
              alert.chain === "base" ? "bg-[#0052FF]/15 text-[#3b82f6]" : "bg-violet-100 text-violet-400"
            )}>
              {alert.chain === "base" ? "Base" : "Stellar"}
            </span>
          )}
        </div>
      </div>
      {alert.acknowledged && (
        <span className="text-xs text-electric-500 font-semibold">✓ ACK</span>
      )}
    </div>
  );
}

export default function AlertsPage() {
  const [filter, setFilter] = useState<"all" | AlertPriority>("all");
  const [tab, setTab] = useState<"active" | "history">("active");

  // Surface a REAL alert if the connected wallet's margin position is unhealthy.
  // Everything else on this page stays mock — bridging the rest needs an indexer.
  const userAddress = useUserStore((s) => s.address);
  const hasMargin = useMarginAccountInfoStore((s) => s.hasMarginAccount);
  const hf = useMarginAccountInfoStore((s) => s.avgHealthFactor);
  const totalDebt = useMarginAccountInfoStore((s) => s.totalBorrowedValue);

  const realActiveAlerts = useMemo(() => {
    if (!userAddress || !hasMargin || totalDebt <= 0) return [];
    if (!Number.isFinite(hf) || hf <= 0 || hf >= 1.3) return [];
    const priority: AlertPriority = hf < 1.05 ? "P0" : hf < 1.1 ? "P1" : "P2";
    return [{
      id: `self-hf-${userAddress.slice(0, 8)}`,
      priority,
      metric: "your_health_factor",
      value: parseFloat(hf.toFixed(2)),
      threshold: 1.3,
      message: `Your margin position health factor at ${hf.toFixed(2)} (debt $${totalDebt.toFixed(2)})`,
      chain: "stellar" as const,
      timestamp: Date.now(),
      acknowledged: false,
    }];
  }, [userAddress, hasMargin, hf, totalDebt]);

  const summaryCounts = useMemo(() => {
    const s = { ...alertsData.summary };
    for (const a of realActiveAlerts) {
      s[a.priority] += 1;
    }
    return s;
  }, [realActiveAlerts]);

  const data = tab === "active"
    ? [...realActiveAlerts, ...alertsData.active]
    : alertsData.history;
  const filtered = filter === "all" ? data : data.filter(a => a.priority === filter);

  const timeStr = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="p-6 w-full max-w-[1600px] mx-auto space-y-8">
      <PageHeader
        title="Alerts & notifications"
        subtitle="Priority feed, filters, and alert history"
        meta={<PageHeaderMeta timeLabel={timeStr} />}
      />

      {/* Summary Badges */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {(["P0", "P1", "P2", "P3"] as AlertPriority[]).map(p => {
          const c = priorityConfig[p];
          const count = summaryCounts[p];
          return (
            <div key={p} className={cn("bg-surface rounded-r4 shadow-vanna p-5 border-l-[4px]", c.border)}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-1.5">
                    <p className="text-xs font-semibold text-vgray-500 uppercase">{p} — {c.label}</p>
                    <InfoTooltip text={
                      p === "P0" ? "Emergency — protocol-threatening events requiring immediate action (e.g. oracle failure, massive bad debt)." :
                      p === "P1" ? "Critical — high-severity issues like rapid HF drops, large liquidation failures, or whale risk spikes." :
                      p === "P2" ? "Warning — elevated risk signals such as positions approaching liquidation or unusual activity patterns." :
                      "Info — routine notifications like successful liquidations, parameter updates, or agent status changes."
                    } />
                  </div>
                  <p className={cn("text-3xl font-bold font-mono mt-1",
                    count > 0 && (p === "P0" || p === "P1") ? "text-imperial-400" : "text-vgray-800"
                  )}>{count}</p>
                </div>
                {count === 0 && p !== "P3" && (
                  <span className="text-electric-500 text-lg">✓</span>
                )}
                {count > 0 && (p === "P0" || p === "P1") && (
                  <span className="w-3 h-3 rounded-full bg-imperial-500 animate-pulse-fast" />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Tab + Filter */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1 bg-vgray-50 rounded-rfull p-1">
          {(["active", "history"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={cn("px-4 py-1.5 rounded-rfull text-xs font-semibold transition-all",
                tab === t ? "bg-violet-500 text-white" : "text-vgray-500 hover:text-vgray-700"
              )}>
              {t === "active" ? `Active (${realActiveAlerts.length + alertsData.active.length})` : `History (${alertsData.history.length})`}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {(["all", "P0", "P1", "P2", "P3"] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={cn("px-3 py-1 rounded-rfull text-xs font-semibold transition-all",
                filter === f ? "bg-violet-500 text-white" : "bg-vgray-100 text-vgray-500 hover:text-vgray-700"
              )}>
              {f === "all" ? "All" : f}
            </button>
          ))}
        </div>
      </div>

      {/* Alert Feed */}
      <div className="space-y-3">
        {filtered.length === 0 ? (
          <div className="bg-surface rounded-r4 shadow-vanna p-8 text-center">
            <p className="text-electric-500 text-3xl mb-2">✓</p>
            <p className="text-sm text-vgray-500">No {filter === "all" ? "" : filter + " "}alerts</p>
          </div>
        ) : (
          filtered.map(alert => <AlertCard key={alert.id} alert={alert} />)
        )}
      </div>

      {/* Notification Channels */}
      <div className="bg-surface rounded-r4 shadow-vanna p-5 border border-vgray-100">
        <div className="flex items-center gap-1.5 mb-4">
          <p className="text-xs font-semibold text-vgray-500 uppercase tracking-wide">Notification Channels</p>
          <InfoTooltip text="Connected channels receive real-time alerts based on priority routing rules. P0/P1 alerts go to all channels simultaneously." />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { name: "Slack", status: "Connected", icon: "#", color: "bg-[#4A154B]" },
            { name: "Telegram", status: "Connected", icon: "TG", color: "bg-[#0088cc]" },
            { name: "Discord", status: "Connected", icon: "D", color: "bg-[#5865F2]" },
            { name: "Email", status: "3 recipients", icon: "@", color: "bg-vgray-300" },
          ].map(ch => (
            <div key={ch.name} className="flex items-center gap-3 p-3 rounded-r3 bg-vgray-50 border border-vgray-100">
              <div className={cn("w-8 h-8 rounded-r2 flex items-center justify-center text-white text-sm font-bold", ch.color)}>
                {ch.icon}
              </div>
              <div>
                <p className="text-sm font-semibold text-vgray-800">{ch.name}</p>
                <div className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-electric-500" />
                  <span className="text-xs text-vgray-400">{ch.status}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
