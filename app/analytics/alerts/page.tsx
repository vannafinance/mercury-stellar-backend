"use client";

import { useState, useMemo } from "react";
import { PageHeader, PageHeaderMeta } from "@/components/analytics/PageHeader";
import { alertsData } from "@/lib/analytics/data/mock";
import { formatTimeAgo, cn } from "@/lib/analytics/utils";
import type { AlertPriority } from "@/lib/analytics/data/mock";
import InfoTooltip from "@/components/analytics/ui/InfoTooltip";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useUserStore } from "@/store/user";
import { useOracleSnapshot, usePoolStats } from "@/hooks/use-analytics";
import { ORACLE } from "@/lib/analytics/stellar/canon";

// Live RPC-derived alert. Carries a `source` flag so the UI can show a
// "LIVE" badge (vs the mock alerts that originate from the static fixture).
type LiveAlert = {
  id: string;
  priority: AlertPriority;
  metric: string;
  value: number | string;
  threshold: number | string;
  message: string;
  chain: "stellar";
  timestamp: number;
  acknowledged: false;
  source: "live";
};

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

function AlertCard({ alert }: { alert: typeof alertsData.active[0] | LiveAlert }) {
  const c = priorityConfig[alert.priority];
  const isLive = (alert as LiveAlert).source === "live";
  return (
    <div className={cn("bg-surface rounded-r3 shadow-vanna p-4 border-l-[4px] flex items-start gap-4", c.border,
      alert.acknowledged && "opacity-60"
    )}>
      <PriorityBadge priority={alert.priority} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-vgray-800">{alert.message}</p>
        <div className="flex items-center gap-3 mt-1.5 flex-wrap">
          <span className="text-xs text-vgray-400">{formatTimeAgo(alert.timestamp)}</span>
          <span className="text-xs px-1.5 py-0.5 rounded-r1 bg-vgray-50 text-vgray-500 font-mono">{alert.metric}</span>
          <span className="text-xs text-vgray-400">
            Value: <span className="font-mono font-semibold text-vgray-700">{alert.value}</span>
            {" "}(threshold: {alert.threshold})
          </span>
          {alert.chain && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-rfull bg-electric-50 text-electric-700">
              Stellar
            </span>
          )}
          {isLive ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-rfull bg-electric-500 text-white">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
              LIVE · RPC
            </span>
          ) : (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-rfull bg-vgray-100 text-vgray-500">
              MOCK
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

  // ── Real-signal sources (RPC-only, no indexer) ───────────────────────
  // 1. Connected wallet margin: from `margin-account-info-store` (already
  //    polling RiskEngine + LendingProtocol contracts via ContractService).
  // 2. Reflector oracle freshness: pulled directly from OracleContract via
  //    `readOracleSnapshot()` (canonical fallback when an asset misses).
  // 3. Per-pool utilization: pulled from each LendingProtocol via
  //    `readAllPoolStats()` — flags when utilization > 95% (borrow-rate
  //    spike imminent + withdraw queue risk).
  const userAddress = useUserStore((s) => s.address);
  const hasMargin = useMarginAccountInfoStore((s) => s.hasMarginAccount);
  const hf = useMarginAccountInfoStore((s) => s.avgHealthFactor);
  const totalDebt = useMarginAccountInfoStore((s) => s.totalBorrowedValue);

  const { data: oracle, error: oracleError } = useOracleSnapshot();
  const { data: pools = [], error: poolsError } = usePoolStats();
  const rpcError = oracleError ?? poolsError;
  const rpcStale = Boolean(rpcError) || (oracle?.prices.some((x) => x.isFallback) ?? false);

  const realActiveAlerts = useMemo<LiveAlert[]>(() => {
    const out: LiveAlert[] = [];
    // Stamp generated alerts with the data-snapshot time (pure) rather than
    // render-time Date.now(); falls back to 0 only before the first oracle read.
    const now = oracle?.fetchedAt ?? 0;

    // (1) Connected wallet margin HF
    if (
      userAddress &&
      hasMargin &&
      totalDebt > 0 &&
      Number.isFinite(hf) &&
      hf > 0 &&
      hf < 1.3
    ) {
      const priority: AlertPriority = hf < 1.05 ? "P0" : hf < 1.1 ? "P1" : "P2";
      out.push({
        id: `self-hf-${userAddress.slice(0, 8)}`,
        priority,
        metric: "your_health_factor",
        value: parseFloat(hf.toFixed(2)),
        threshold: 1.3,
        message: `Your margin position health factor at ${hf.toFixed(2)} (debt $${totalDebt.toFixed(2)})`,
        chain: "stellar",
        timestamp: now,
        acknowledged: false,
        source: "live",
      });
    }

    // (2) Reflector oracle staleness — every fallback price means the live
    // RPC didn't return a usable value for that asset.
    if (oracle) {
      for (const p of oracle.prices) {
        if (p.isFallback) {
          out.push({
            id: `oracle-stale-${p.symbol}`,
            priority: "P1",
            metric: `reflector_${p.symbol.toLowerCase()}`,
            value: "stale",
            threshold: `${ORACLE.expectedHeartbeatSec}s`,
            message: `Reflector feed for ${p.symbol} did not return a fresh price — Risk Engine will block borrows / withdraws on this asset.`,
            chain: "stellar",
            timestamp: now,
            acknowledged: false,
            source: "live",
          });
        }
      }
    }

    // (3) Pool utilization — borrow-side stress.
    for (const pool of pools) {
      if (pool.utilizationRate >= 95) {
        out.push({
          id: `util-${pool.symbol}`,
          priority: pool.utilizationRate >= 99 ? "P0" : "P1",
          metric: `${pool.symbol.toLowerCase()}_utilization`,
          value: `${pool.utilizationRate.toFixed(1)}%`,
          threshold: "95%",
          message: `${pool.symbol} pool utilization at ${pool.utilizationRate.toFixed(1)}% — borrow APR spiking, withdraws may queue.`,
          chain: "stellar",
          timestamp: now,
          acknowledged: false,
          source: "live",
        });
      } else if (pool.utilizationRate >= 85) {
        out.push({
          id: `util-${pool.symbol}`,
          priority: "P2",
          metric: `${pool.symbol.toLowerCase()}_utilization`,
          value: `${pool.utilizationRate.toFixed(1)}%`,
          threshold: "85%",
          message: `${pool.symbol} pool utilization at ${pool.utilizationRate.toFixed(1)}% — approaching borrow-rate kink.`,
          chain: "stellar",
          timestamp: now,
          acknowledged: false,
          source: "live",
        });
      }
    }

    // (4) RPC outage itself.
    if (rpcError) {
      out.push({
        id: `rpc-error`,
        priority: "P1",
        metric: "soroban_rpc",
        value: "unreachable",
        threshold: "ok",
        message: `Soroban RPC unavailable — falling back to cached/synthetic data. (${rpcError})`,
        chain: "stellar",
        timestamp: now,
        acknowledged: false,
        source: "live",
      });
    }

    return out;
  }, [userAddress, hasMargin, hf, totalDebt, oracle, pools, rpcError]);

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

  // Freshness summary for the live-status strip.
  const liveSummary = useMemo(() => {
    if (!oracle && pools.length === 0) {
      return { ready: false, label: rpcError ? "RPC error" : "Loading Soroban RPC…" };
    }
    if (rpcError) return { ready: false, label: rpcError };
    if (rpcStale) return { ready: true, label: "Reflector partially stale" };
    return { ready: true, label: `Reflector + ${pools.length} pools live` };
  }, [oracle, pools, rpcStale, rpcError]);

  return (
    <div className="p-6 w-full max-w-[1600px] mx-auto space-y-8">
      <PageHeader
        title="Alerts & notifications"
        subtitle="Priority feed, filters, and alert history"
        meta={<PageHeaderMeta timeLabel={timeStr} mock={!liveSummary.ready} />}
      />

      {/* ── Live Data Status Strip ─────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 rounded-r4 border border-vgray-100 bg-surface px-4 py-2 text-[11px]">
        <div className="flex items-center gap-2 text-vgray-500">
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              liveSummary.ready && !rpcStale ? "bg-electric-500" : "bg-amber-400 animate-pulse"
            )}
          />
          <span>{liveSummary.label}</span>
          {realActiveAlerts.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-rfull bg-electric-500 text-white text-[9px] font-bold">
              {realActiveAlerts.length} LIVE
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-vgray-400">
          {oracle && (
            <span>Reflector heartbeat ≤ {oracle.expectedHeartbeatSec}s</span>
          )}
          {pools.length > 0 && (
            <span>Pools polled: {pools.map((p) => p.symbol).join(" · ")}</span>
          )}
        </div>
      </div>

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
