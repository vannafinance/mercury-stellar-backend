"use client";

import { useMemo, useState } from "react";
import { PageHeader, PageHeaderMeta } from "@/components/analytics/PageHeader";
import { liquidationMetrics } from "@/lib/analytics/data/mock";
import type { Chain } from "@/lib/analytics/data/mock";
import {
  formatUsd,
  formatPercent,
  formatNumber,
  formatTimeAgo,
  cn,
  hfColor,
} from "@/lib/analytics/utils";
import InfoTooltip from "@/components/analytics/ui/InfoTooltip";

const lm = liquidationMetrics;

const PAGE_SIZE = 5;

/* ── Chain Badge ── */
function ChainBadge({ chain }: { chain: Chain }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider",
        chain === "base"
          ? "bg-[#0052FF]/15 text-[#3b82f6]"
          : "bg-violet-100 text-violet-400",
      )}
    >
      {chain}
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

  const history = lm.liquidationHistory;
  const eligible = lm.walletsEligibleForLiquidation;

  const recentSlice = usePagedSlice(history, recentPage, PAGE_SIZE);
  const eligibleSlice = usePagedSlice(eligible, eligiblePage, PAGE_SIZE);

  const timeStr = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="p-6 w-full max-w-[1600px] mx-auto space-y-8">
      <PageHeader
        title="Liquidation monitor"
        subtitle="Recent liquidations and wallets eligible for liquidation"
        meta={<PageHeaderMeta timeLabel={timeStr} />}
      />

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-vgray-400">
          Analytics
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <KpiCard
            title="Number of liquidations"
            value={formatNumber(lm.numberOfLiquidations)}
            subtitle={lm.liquidationsPeriodLabel}
            tooltip="Total liquidation events executed on-chain during the selected period."
          />
          <KpiCard
            title="Collateral seized"
            value={formatUsd(lm.collateralSeizedUsd)}
            subtitle="Cumulative seized (period)"
            tooltip="Total USD value of collateral claimed by liquidators to cover under-collateralized debt."
          />
          <KpiCard
            title="Debt repaid"
            value={formatUsd(lm.debtRepaidUsd)}
            subtitle="From liquidations (period)"
            tooltip="Total outstanding debt that was repaid through liquidation events during this period."
          />
          <KpiCard
            title="Wallets with bad debt"
            value={formatNumber(lm.walletsWithBadDebt)}
            subtitle="Distinct addresses"
            tooltip="Wallets where collateral couldn't fully cover the debt — the protocol absorbs the remaining shortfall."
          />
          <KpiCard
            title="Success rate"
            value={formatPercent(lm.successRate)}
            subtitle="Completed liquidations"
            tooltip="Percentage of liquidation attempts that completed successfully without reverting on-chain."
          />
          <KpiCard
            title="Avg time to liquidate"
            value={`${lm.avgTimeToLiquidate}s`}
            subtitle="Mean execution time"
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
