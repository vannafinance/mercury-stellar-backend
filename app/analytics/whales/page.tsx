"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader, PageHeaderMeta } from "@/components/analytics/PageHeader";
import {
  formatUsd,
  formatPercent,
  formatTimeAgo,
  hfColor,
  cn,
} from "@/lib/analytics/utils";
import InfoTooltip from "@/components/analytics/ui/InfoTooltip";
import { useChartColors } from "@/lib/analytics/theme";
import { useAnalyticsOnchainStore } from "@/lib/analytics/onchain/store";
import { deriveWhaleConcentration, type WhaleConcentration } from "@/lib/analytics/onchain/derivations";
import { useUserStore } from "@/store/user";
import { readLiveEventFeed, type LiveWhaleActivityRow } from "@/lib/analytics/stellar/eventFeed";

/* ────────────────────────────────────────────
   HELPERS
   ──────────────────────────────────────────── */

// Single-chain build — every wallet/account is a Soroban G-account.
function chainBadge(_chain: string) {
  return (
    <span className="inline-flex items-center rounded-full bg-electric-50 px-2 py-0.5 text-[10px] font-semibold text-electric-700">
      STELLAR
    </span>
  );
}

const EMPTY_CONCENTRATION: WhaleConcentration = {
  top5Share: 0,
  top10Share: 0,
  top20Share: 0,
  topPositions: [],
};

const actionStyles: Record<string, { bg: string; text: string }> = {
  OPEN_POSITION: { bg: "bg-electric-100", text: "text-electric-500" },
  CLOSE_POSITION: { bg: "bg-rose-100", text: "text-rose-400" },
  INCREASE_LEVERAGE: { bg: "bg-amber-500/15", text: "text-amber-500" },
  DECREASE_LEVERAGE: { bg: "bg-violet-100", text: "text-violet-400" },
  DEPOSIT: { bg: "bg-[#0052FF]/15", text: "text-[#3b82f6]" },
  WITHDRAW: { bg: "bg-imperial-100", text: "text-imperial-400" },
};

function actionLabel(action: string) {
  return action.replace(/_/g, " ");
}

/* ────────────────────────────────────────────
   Concentration Bar
   ──────────────────────────────────────────── */

function ConcentrationBar({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-vgray-600 w-16 text-right">{label}</span>
      <div className="flex-1 h-5 bg-vgray-50 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${value}%`, backgroundColor: color }}
        />
      </div>
      <span className="font-mono text-xs font-semibold text-vgray-800 w-12 text-right">
        {formatPercent(value)}
      </span>
    </div>
  );
}

/* ────────────────────────────────────────────
   ROW 1 — Supply + Borrow Concentration Bars
   ──────────────────────────────────────────── */

function ConcentrationBars({
  data,
}: {
  data: WhaleConcentration;
}) {
  const cc = useChartColors();
  const supplyConc = {
    top1: data.topPositions[0]?.sharePercent ?? 0,
    top5: data.top5Share,
    top10: data.top10Share,
    top20: data.top20Share,
  };
  const borrowConc = {
    top1: data.topPositions[0]?.sharePercent ?? 0,
    top5: data.top5Share,
    top10: data.top10Share,
    top20: data.top20Share,
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Supply */}
      <div className="bg-surface rounded-r4 shadow-vanna p-5 border border-vgray-100">
        <div className="flex items-center gap-1.5 mb-4">
          <h2 className="text-sm font-bold text-vgray-800 uppercase tracking-wide">
            Supply Concentration
          </h2>
          <InfoTooltip size="md" text="Shows how much of total supply is controlled by top wallets. High concentration means a few whales withdrawing could significantly impact liquidity." />
        </div>
        <div className="space-y-3">
          <ConcentrationBar label="Top 1" value={supplyConc.top1} color={cc.violet} />
          <ConcentrationBar label="Top 5" value={supplyConc.top5} color={cc.accent2} />
          <ConcentrationBar label="Top 10" value={supplyConc.top10} color={cc.electric} />
          <ConcentrationBar label="Top 20" value={supplyConc.top20} color={cc.rose} />
        </div>
      </div>

      {/* Borrow */}
      <div className="bg-surface rounded-r4 shadow-vanna p-5 border border-vgray-100">
        <div className="flex items-center gap-1.5 mb-4">
          <h2 className="text-sm font-bold text-vgray-800 uppercase tracking-wide">
            Borrow Concentration
          </h2>
          <InfoTooltip size="md" text="Shows how much of total borrowing is held by top wallets. High concentration means a single whale liquidation could cascade and create bad debt." />
        </div>
        <div className="space-y-3">
          <ConcentrationBar label="Top 1" value={borrowConc.top1} color={cc.violet} />
          <ConcentrationBar label="Top 5" value={borrowConc.top5} color={cc.accent2} />
          <ConcentrationBar label="Top 10" value={borrowConc.top10} color={cc.electric} />
          <ConcentrationBar label="Top 20" value={borrowConc.top20} color={cc.rose} />
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────
   ROW 2 — Top 10 Positions Table
   ──────────────────────────────────────────── */

function TopPositionsTable({
  data,
}: {
  data: WhaleConcentration;
}) {
  return (
    <div className="bg-surface rounded-r4 shadow-vanna p-5 border border-vgray-100">
      <div className="flex items-center gap-1.5 mb-4">
        <h2 className="text-sm font-bold text-vgray-800 uppercase tracking-wide">
          Top 10 Positions
        </h2>
        <InfoTooltip size="md" text="Largest positions by debt size. Monitor these closely — if any of these wallets get liquidated, it can impact market prices and create cascading liquidations." />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-vgray-50">
              <th className="text-left px-3 py-2 text-vgray-500 font-semibold uppercase tracking-wider rounded-tl-lg">#</th>
              <th className="text-left px-3 py-2 text-vgray-500 font-semibold uppercase tracking-wider">Chain</th>
              <th className="text-left px-3 py-2 text-vgray-500 font-semibold uppercase tracking-wider">Address</th>
              <th className="text-right px-3 py-2 text-vgray-500 font-semibold uppercase tracking-wider">Debt</th>
              <th className="text-right px-3 py-2 text-vgray-500 font-semibold uppercase tracking-wider">Share</th>
              <th className="text-right px-3 py-2 text-vgray-500 font-semibold uppercase tracking-wider">HF</th>
              <th className="text-right px-3 py-2 text-vgray-500 font-semibold uppercase tracking-wider rounded-tr-lg">Leverage</th>
            </tr>
          </thead>
          <tbody>
            {data.topPositions.map((pos, i) => (
              <tr
                key={pos.address}
                className={cn(
                  "border-b border-vgray-100",
                  i % 2 === 0 ? "bg-surface" : "bg-vgray-50"
                )}
              >
                <td className="px-3 py-2.5 font-bold text-vgray-500">
                  {i + 1}
                </td>
                <td className="px-3 py-2.5">{chainBadge(pos.chain)}</td>
                <td className="px-3 py-2.5 font-mono text-vgray-700">
                  {pos.address}
                </td>
                <td className="px-3 py-2.5 text-right font-mono font-semibold text-vgray-800">
                  {formatUsd(pos.debtUsd)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-vgray-600">
                  {formatPercent(pos.sharePercent)}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <span
                    className="font-mono font-bold"
                    style={{ color: hfColor(pos.healthFactor) }}
                  >
                    {pos.healthFactor.toFixed(2)}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-vgray-800">
                  {pos.leverage.toFixed(1)}x
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────
   ROW 3 — Whale Activity Feed (24h)
   ──────────────────────────────────────────── */

function WhaleActivityFeed({
  activity,
}: {
  activity: LiveWhaleActivityRow[];
}) {
  return (
    <div className="bg-surface rounded-r4 shadow-vanna p-5 border border-vgray-100">
      <div className="flex items-center gap-1.5 mb-4">
        <h2 className="text-sm font-bold text-vgray-800 uppercase tracking-wide">
          Whale Activity Feed (24h)
        </h2>
        <InfoTooltip size="md" text="Real-time feed of large wallet actions — opens, closes, leverage changes, deposits, and withdrawals. Sudden whale moves often signal market-moving events." />
      </div>
      <div className="space-y-3">
        {activity.map((evt, i) => {
          const style = actionStyles[evt.action] ?? {
            bg: "bg-vgray-200",
            text: "text-vgray-700",
          };
          return (
            <div
              key={i}
              className="flex items-start gap-3 border-l-2 border-vgray-200 pl-4 py-2"
            >
              {/* Timestamp dot */}
              <div className="flex flex-col items-center flex-shrink-0 -ml-[21px]">
                <span className="w-3 h-3 rounded-full bg-violet-500 border-2 border-surface" />
              </div>

              {/* Action badge */}
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold flex-shrink-0 whitespace-nowrap",
                  style.bg,
                  style.text
                )}
              >
                {actionLabel(evt.action)}
              </span>

              {/* Content */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-mono text-xs text-vgray-700">
                    {evt.address}
                  </span>
                  {chainBadge(evt.chain)}
                </div>
                <p className="text-[11px] text-vgray-500">{evt.details}</p>
              </div>

              {/* Amount + Time */}
              <div className="flex-shrink-0 text-right">
                <p className="font-mono text-xs font-semibold text-vgray-800">
                  {formatUsd(evt.amountUsd)}
                </p>
                <p className="text-[10px] text-vgray-400">
                  {formatTimeAgo(evt.timestamp)}
                </p>
              </div>
            </div>
          );
        })}

        {activity.length === 0 && (
          <p className="text-xs text-vgray-400 text-center py-6">
            No whale activity in the last 24 hours
          </p>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────
   PAGE
   ──────────────────────────────────────────── */

export default function WhalesPage() {
  const userAddress = useUserStore((s) => s.address);
  const snapshot = useAnalyticsOnchainStore((s) => s.result);
  const isLoading = useAnalyticsOnchainStore((s) => s.isLoading);
  const load = useAnalyticsOnchainStore((s) => s.load);
  const [liveActivity, setLiveActivity] = useState<LiveWhaleActivityRow[]>([]);
  const [isLiveFeedLoading, setIsLiveFeedLoading] = useState(true);

  useEffect(() => {
    void load(userAddress);
  }, [userAddress, load]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pull = async () => {
      try {
        const feed = await readLiveEventFeed();
        if (!cancelled) setLiveActivity(feed.whaleActivity);
      } catch {
        // keep fallback
      } finally {
        if (!cancelled) {
          setIsLiveFeedLoading(false);
          timer = setTimeout(pull, 30_000);
        }
      }
    };
    void pull();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const whalesData = useMemo(
    () => (snapshot ? deriveWhaleConcentration(snapshot.accounts, 10) : EMPTY_CONCENTRATION),
    [snapshot],
  );
  const hasLive = whalesData.topPositions.length > 0;
  const hasLiveActivity = liveActivity.length > 0;
  const activityData = liveActivity;

  const timeStr = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="p-6 w-full max-w-[1600px] mx-auto space-y-8">
      <PageHeader
        title="Whale tracker"
        subtitle="Large positions, concentration risk, and recent whale activity"
        meta={<PageHeaderMeta timeLabel={timeStr} mock={false} />}
      />

      <div className="flex items-center justify-between gap-3 rounded-r4 border border-vgray-100 bg-surface px-4 py-2 text-[11px]">
        <div className="flex items-center gap-2 text-vgray-500">
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              hasLive ? "bg-electric-500" : isLoading ? "bg-amber-400 animate-pulse" : "bg-vgray-300",
            )}
          />
          {hasLive ? (
            <span>Whale concentration derived from live account snapshots</span>
          ) : isLoading ? (
            <span>Loading live positions…</span>
          ) : (
            <span>No borrowed positions on the protocol yet — whale view fills as margin accounts open leveraged debt</span>
          )}
          <span className="text-vgray-400">·</span>
          {hasLiveActivity ? (
            <span>Activity feed from live Soroban events</span>
          ) : isLiveFeedLoading ? (
            <span>Loading live activity…</span>
          ) : (
            <span>No whale events in lookback window (live)</span>
          )}
        </div>
      </div>

      {/* Row 1 — Concentration Bars */}
      <ConcentrationBars data={whalesData} />

      {/* Row 2 — Top 10 Table */}
      <TopPositionsTable data={whalesData} />

      {/* Row 3 — Activity Feed */}
      <WhaleActivityFeed activity={activityData} />
    </div>
  );
}
