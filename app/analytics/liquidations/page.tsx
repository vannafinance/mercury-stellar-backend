"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader, PageHeaderMeta } from "@/components/analytics/PageHeader";
type Chain = "stellar";
import {
  formatUsd,
  formatPercent,
  formatNumber,
  formatTimeAgo,
  cn,
  hfColor,
} from "@/lib/analytics/utils";
import InfoTooltip from "@/components/analytics/ui/InfoTooltip";
import { useAnalyticsOnchainStore } from "@/lib/analytics/onchain/store";
import { derivePositionRows } from "@/lib/analytics/onchain/derivations";
import { useUserStore } from "@/store/user";
import { readLiveEventFeed, type LiveLiquidationRow } from "@/lib/analytics/stellar/eventFeed";

const PAGE_SIZE = 5;

/* ── Chain Badge ──
 * Single-chain build: every margin account lives on Soroban testnet.
 * Component kept so existing call-sites continue to compile. */
function ChainBadge({ chain: _chain }: { chain: Chain }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-electric-50 text-electric-700">
      stellar
    </span>
  );
}

/* ── KPI card ── */
function KpiCard({
  title,
  value,
  subtitle,
  tooltip,
}: {
  title: string;
  value: string;
  subtitle?: string;
  tooltip?: string;
}) {
  return (
    <div className="bg-surface rounded-r4 p-5 border border-vgray-100 shadow-vanna">
      <div className="flex items-center gap-1.5 mb-1.5">
        <p className="text-[11px] font-semibold text-vgray-500 uppercase tracking-wide">
          {title}
        </p>
        {tooltip && <InfoTooltip text={tooltip} />}
      </div>
      <p className="text-xl sm:text-2xl font-bold font-mono text-vgray-800 tabular-nums">
        {value}
      </p>
      {subtitle && (
        <p className="text-xs text-vgray-400 mt-1.5 leading-snug">{subtitle}</p>
      )}
    </div>
  );
}

/* ── Liquidation Status Badge ── */
function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    success: "bg-electric-100 text-electric-500",
    partial: "bg-amber-400/15 text-amber-500",
    failed: "bg-imperial-100 text-imperial-400",
  };
  return (
    <span
      className={cn(
        "px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider",
        styles[status] || "bg-vgray-100 text-vgray-600",
      )}
    >
      {status}
    </span>
  );
}

function TablePagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (p: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const end = Math.min(safePage * pageSize, total);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-t border-vgray-100 pt-4 mt-4">
      <p className="text-xs text-vgray-500 tabular-nums">
        {total === 0 ? (
          "No rows"
        ) : (
          <>
            Showing <span className="font-medium text-vgray-700">{start}</span>
            {" – "}
            <span className="font-medium text-vgray-700">{end}</span>
            {" of "}
            <span className="font-medium text-vgray-700">{total}</span>
          </>
        )}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, safePage - 1))}
          disabled={safePage <= 1 || total === 0}
          className={cn(
            "px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors",
            safePage <= 1 || total === 0
              ? "border-vgray-100 text-vgray-300 cursor-not-allowed"
              : "border-vgray-200 text-vgray-700 hover:bg-vgray-50",
          )}
        >
          Previous
        </button>
        <span className="text-xs text-vgray-500 tabular-nums px-2">
          Page {safePage} of {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
          disabled={safePage >= totalPages || total === 0}
          className={cn(
            "px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors",
            safePage >= totalPages || total === 0
              ? "border-vgray-100 text-vgray-300 cursor-not-allowed"
              : "border-vgray-200 text-vgray-700 hover:bg-vgray-50",
          )}
        >
          Next
        </button>
      </div>
    </div>
  );
}

function usePagedSlice<T>(items: T[], page: number, pageSize: number) {
  return useMemo(() => {
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const start = (safePage - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, page, pageSize]);
}

export default function LiquidationsPage() {
  const [recentPage, setRecentPage] = useState(1);
  const [eligiblePage, setEligiblePage] = useState(1);
  const [liveHistory, setLiveHistory] = useState<LiveLiquidationRow[]>([]);
  const [isEventFeedLoading, setIsEventFeedLoading] = useState(true);
  const userAddress = useUserStore((s) => s.address);
  const snapshot = useAnalyticsOnchainStore((s) => s.result);
  const isLoading = useAnalyticsOnchainStore((s) => s.isLoading);
  const load = useAnalyticsOnchainStore((s) => s.load);

  useEffect(() => {
    void load(userAddress);
  }, [userAddress, load]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pull = async () => {
      try {
        const feed = await readLiveEventFeed();
        if (!cancelled) setLiveHistory(feed.liquidations);
      } catch {
        // keep fallback
      } finally {
        if (!cancelled) {
          setIsEventFeedLoading(false);
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

  const history: LiveLiquidationRow[] = liveHistory;
  const liveEligible = useMemo(() => {
    if (!snapshot) return [];
    return derivePositionRows(snapshot.accounts).filter((p) => p.healthFactor < 1.1).map((p) => ({
      address: p.address,
      chain: "stellar" as const,
      healthFactor: p.healthFactor,
      debtUsd: p.totalDebt,
      collateralUsd: p.grossCollateralUsd,
    }));
  }, [snapshot]);
  const hasLiveEligible = liveEligible.length > 0;
  const eligible = liveEligible;
  const liveBadDebtEstimate = useMemo(
    () => eligible.reduce((sum, w) => sum + Math.max(0, w.debtUsd - w.collateralUsd * 0.9), 0),
    [eligible],
  );

  const recentSlice = usePagedSlice(history, recentPage, PAGE_SIZE);
  const eligibleSlice = usePagedSlice(eligible, eligiblePage, PAGE_SIZE);
  const successRate = useMemo(() => {
    if (history.length === 0) return 0;
    const success = history.filter((h) => h.status === "success").length;
    return (success / history.length) * 100;
  }, [history]);

  const collateralSeizedUsd = useMemo(
    () => history.reduce((s, h) => s + h.recoveryAmount, 0),
    [history],
  );
  const debtRepaidUsd = useMemo(() => history.reduce((s, h) => s + h.debtAmount, 0), [history]);
  const avgTimeToLiquidateSec = useMemo(() => {
    if (history.length === 0) return 0;
    const sum = history.reduce((s, h) => s + h.durationSeconds, 0);
    return Math.round(sum / history.length);
  }, [history]);

  const timeStr = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="p-6 w-full max-w-[1600px] mx-auto space-y-8">
      <PageHeader
        title="Liquidation monitor"
        subtitle="Recent liquidations and wallets eligible for liquidation"
        meta={<PageHeaderMeta timeLabel={timeStr} mock={false} />}
      />

      <div className="flex items-center justify-between gap-3 rounded-r4 border border-vgray-100 bg-surface px-4 py-2 text-[11px]">
        <div className="flex items-center gap-2 text-vgray-500">
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              hasLiveEligible ? "bg-electric-500" : isLoading ? "bg-amber-400 animate-pulse" : "bg-vgray-300",
            )}
          />
          {hasLiveEligible ? (
            <span>Eligible wallets derived from live snapshot HF (&lt; 1.1)</span>
          ) : isLoading ? (
            <span>Loading live positions…</span>
          ) : (
            <span>No eligible wallets in your snapshot (HF ≥ 1.1) or still loading</span>
          )}
          <span className="text-vgray-400">·</span>
          {history.length > 0 ? (
            <span>Recent liquidation events from Soroban RPC</span>
          ) : isEventFeedLoading ? (
            <span>Loading liquidation events…</span>
          ) : (
            <span>No liquidation events in lookback window (live)</span>
          )}
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-vgray-400">
          Analytics
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <KpiCard
            title="Number of liquidations"
            value={formatNumber(history.length)}
            subtitle={isEventFeedLoading ? "Loading events…" : "Soroban events in lookback window"}
            tooltip="Total liquidation events executed on-chain during the selected period."
          />
          <KpiCard
            title="Collateral seized"
            value={formatUsd(collateralSeizedUsd)}
            subtitle="Sum of recoveryAmount from events (often 0 if payload sparse)"
            tooltip="Total USD value of collateral claimed by liquidators to cover under-collateralized debt."
          />
          <KpiCard
            title="Debt repaid"
            value={formatUsd(debtRepaidUsd)}
            subtitle="Sum of debtAmount from events"
            tooltip="Total outstanding debt that was repaid through liquidation events during this period."
          />
          <KpiCard
            title="Wallets with bad debt"
            value={formatNumber(eligible.filter((w) => w.debtUsd > w.collateralUsd * 0.9).length)}
            subtitle="Distinct addresses (eligible set)"
            tooltip="Wallets where collateral couldn't fully cover the debt — the protocol absorbs the remaining shortfall."
          />
          <KpiCard
            title="Live bad debt estimate"
            value={formatUsd(liveBadDebtEstimate)}
            subtitle={hasLiveEligible ? "Derived from live eligible set" : "No HF < 1.1 positions in snapshot"}
            tooltip="Approximation using current debt vs 90% collateral recovery for eligible wallets."
          />
          <KpiCard
            title="Success rate"
            value={formatPercent(successRate)}
            subtitle={history.length === 0 ? "No events in window" : "From live event feed"}
            tooltip="Percentage of liquidation attempts that completed successfully without reverting on-chain."
          />
          <KpiCard
            title="Avg time to liquidate"
            value={avgTimeToLiquidateSec > 0 ? `${avgTimeToLiquidateSec}s` : "—"}
            subtitle={history.length === 0 ? "No timed events" : "Mean durationSeconds from events"}
            tooltip="Average time from when a position drops below HF 1.1 to when the liquidation transaction is confirmed."
          />
        </div>
      </section>

      {/* Recent liquidation events */}
      <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-5">
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-lg font-semibold text-vgray-800">
            Recent liquidation events
          </h2>
          <InfoTooltip size="md" text="Latest on-chain liquidation events across all supported chains with full transaction details." />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-vgray-50">
                <th className="px-4 py-3 text-left font-semibold text-vgray-500 text-xs uppercase tracking-wider rounded-tl-lg">
                  Time
                </th>
                <th className="px-4 py-3 text-left font-semibold text-vgray-500 text-xs uppercase tracking-wider">Chain</th>
                <th className="px-4 py-3 text-left font-semibold text-vgray-500 text-xs uppercase tracking-wider">Tx hash</th>
                <th className="px-4 py-3 text-left font-semibold text-vgray-500 text-xs uppercase tracking-wider">Position</th>
                <th className="px-4 py-3 text-left font-semibold text-vgray-500 text-xs uppercase tracking-wider">
                  Liquidator
                </th>
                <th className="px-4 py-3 text-right font-semibold text-vgray-500 text-xs uppercase tracking-wider">Debt</th>
                <th className="px-4 py-3 text-right font-semibold text-vgray-500 text-xs uppercase tracking-wider">
                  Recovered
                </th>
                <th className="px-4 py-3 text-right font-semibold text-vgray-500 text-xs uppercase tracking-wider">Bad debt</th>
                <th className="px-4 py-3 text-right font-semibold text-vgray-500 text-xs uppercase tracking-wider">Duration</th>
                <th className="px-4 py-3 text-center font-semibold text-vgray-500 text-xs uppercase tracking-wider rounded-tr-lg">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {recentSlice.map((h, i) => (
                <tr
                  key={h.txHash}
                  className={cn(
                    "border-b border-vgray-100 hover:bg-surface-hover transition-colors",
                    i % 2 === 0 ? "bg-surface" : "bg-vgray-50/50",
                  )}
                >
                  <td className="px-4 py-3 text-xs text-vgray-500 whitespace-nowrap">
                    {formatTimeAgo(h.timestamp)}
                  </td>
                  <td className="px-4 py-3">
                    <ChainBadge chain={h.chain} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-vgray-700">
                    {h.txHash}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-vgray-700">
                    {h.positionAddress}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-vgray-700">
                    {h.liquidatorAddress}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs">
                    {formatUsd(h.debtAmount)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs">
                    {formatUsd(h.recoveryAmount)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs">
                    {h.badDebt > 0 ? (
                      <span className="text-imperial-500 font-semibold">
                        {formatUsd(h.badDebt)}
                      </span>
                    ) : (
                      <span className="text-electric-500">$0</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs">
                    {h.durationSeconds}s
                  </td>
                  <td className="px-4 py-3 text-center">
                    <StatusBadge status={h.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <TablePagination
          page={recentPage}
          pageSize={PAGE_SIZE}
          total={history.length}
          onPageChange={(p) => setRecentPage(p)}
        />
      </div>

      {/* Wallets eligible for liquidation */}
      <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-5">
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-lg font-semibold text-vgray-800">
            Wallets eligible for liquidation
          </h2>
          <InfoTooltip size="md" text="These wallets have HF ≤ 1.1 and are eligible for liquidation but haven't been liquidated yet. Ideally this table should be empty — every entry here is potential bad debt if prices move further against them before a liquidator steps in." />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-vgray-50">
                <th className="px-4 py-3 text-left font-semibold text-vgray-500 text-xs uppercase tracking-wider rounded-tl-lg">
                  Wallet
                </th>
                <th className="px-4 py-3 text-left font-semibold text-vgray-500 text-xs uppercase tracking-wider">Chain</th>
                <th className="px-4 py-3 text-right font-semibold text-vgray-500 text-xs uppercase tracking-wider">
                  Health factor
                </th>
                <th className="px-4 py-3 text-right font-semibold text-vgray-500 text-xs uppercase tracking-wider">Debt</th>
                <th className="px-4 py-3 text-right font-semibold text-vgray-500 text-xs uppercase tracking-wider rounded-tr-lg">
                  Collateral
                </th>
              </tr>
            </thead>
            <tbody>
              {eligibleSlice.map((w, i) => (
                <tr
                  key={`${w.address}-${w.chain}`}
                  className={cn(
                    "border-b border-vgray-100 hover:bg-surface-hover transition-colors",
                    i % 2 === 0 ? "bg-surface" : "bg-vgray-50/50",
                  )}
                >
                  <td className="px-4 py-3 font-mono text-xs text-vgray-700">
                    {w.address}
                  </td>
                  <td className="px-4 py-3">
                    <ChainBadge chain={w.chain} />
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs font-semibold">
                    <span style={{ color: hfColor(w.healthFactor) }}>
                      {w.healthFactor.toFixed(2)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs">
                    {formatUsd(w.debtUsd)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs">
                    {formatUsd(w.collateralUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <TablePagination
          page={eligiblePage}
          pageSize={PAGE_SIZE}
          total={eligible.length}
          onPageChange={(p) => setEligiblePage(p)}
        />
      </div>
    </div>
  );
}
