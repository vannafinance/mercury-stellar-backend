"use client";

import { useMemo } from "react";
import { formatUsd, formatPercent, cn } from "@/lib/analytics/utils";
import { Card, useColors } from "./primitives";
import type { WalletPosition } from "./constants";
import InfoTooltip from "@/components/analytics/ui/InfoTooltip";

/** Protocol reserve / insurance not read from a Soroban getter in this client yet. */
const RESERVE_FUND_USD = 0;

export default function BadDebtMonitorSummary({ wallets }: { wallets: WalletPosition[] }) {
  const c = useColors();

  const badDebtMetrics = useMemo(() => {
    const underwaterWallets = wallets.filter((w) => w.hf < 1);

    let totalBadDebt = 0;
    const byAsset: Record<string, number> = {};

    for (const w of underwaterWallets) {
      const shortfall = w.debt - w.collateral * 0.9;
      if (shortfall > 0) {
        totalBadDebt += shortfall;
        byAsset[w.primaryAsset] = (byAsset[w.primaryAsset] || 0) + shortfall;
      }
    }

    const totalDebt = wallets.reduce((sum, w) => sum + w.debt, 0);
    const ratio = totalDebt > 0 ? (totalBadDebt / totalDebt) * 100 : 0;
    const reserveCoverage =
      totalBadDebt <= 0
        ? Infinity
        : RESERVE_FUND_USD > 0
          ? (RESERVE_FUND_USD / totalBadDebt) * 100
          : 0;

    return { totalBadDebt, ratio, reserveCoverage, byAsset };
  }, [wallets]);

  const assetBreakdown = useMemo(() => {
    const entries = Object.entries(badDebtMetrics.byAsset).sort((a, b) => b[1] - a[1]);
    const maxVal = entries.length > 0 ? entries[0][1] : 1;
    return entries.map(([asset, amount]) => ({
      asset,
      amount,
      pct: maxVal > 0 ? (amount / maxVal) * 100 : 0,
    }));
  }, [badDebtMetrics.byAsset]);

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-1.5">
          <h2 className={`text-sm font-bold ${c.text1}`}>Bad debt monitor (baseline)</h2>
          <InfoTooltip size="md" text="Baseline bad debt from current positions before any stress simulation. Shows how much debt is already underwater and whether the reserve fund can cover it." />
        </div>
        <p className={`text-xs mt-1 ${c.text3}`}>
          Live margin snapshot (your SmartAccount) — before any stress simulation
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card className="!p-4">
          <div className={`text-[10px] font-semibold uppercase tracking-wide ${c.text3} flex items-center gap-1`}>
            Total bad debt
            <InfoTooltip text="Sum of all debt that exceeds collateral value across underwater positions. This is the protocol's direct exposure." />
          </div>
          <div
            className={cn(
              "text-lg font-bold font-mono mt-1",
              badDebtMetrics.totalBadDebt > 0 ? "text-imperial-400" : "text-electric-500"
            )}
          >
            {formatUsd(badDebtMetrics.totalBadDebt)}
          </div>
        </Card>
        <Card className="!p-4">
          <div className={`text-[10px] font-semibold uppercase tracking-wide ${c.text3} flex items-center gap-1`}>
            Bad debt / debt
            <InfoTooltip text="Bad debt as a percentage of total outstanding debt. Lower is better — a rising ratio signals growing insolvency risk." />
          </div>
          <div className={`text-lg font-bold font-mono mt-1 ${c.text1}`}>
            {formatPercent(badDebtMetrics.ratio)}
          </div>
        </Card>
        <Card className="!p-4">
          <div className={`text-[10px] font-semibold uppercase tracking-wide ${c.text3} flex items-center gap-1`}>
            Reserve fund
            <InfoTooltip text="Protocol's safety buffer to absorb bad debt. If bad debt exceeds the reserve, the shortfall must be socialized across lenders." />
          </div>
          <div className={`text-lg font-bold font-mono mt-1 ${c.text1}`}>
            {formatUsd(RESERVE_FUND_USD)}
          </div>
        </Card>
        <Card className="!p-4">
          <div className={`text-[10px] font-semibold uppercase tracking-wide ${c.text3} flex items-center gap-1`}>
            Reserve coverage
            <InfoTooltip text="How much of the bad debt the reserve fund can cover. Above 100% means fully covered. Below 100% means the protocol has a funding gap." />
          </div>
          <div className={`text-lg font-bold font-mono mt-1 ${c.text1}`}>
            {Number.isFinite(badDebtMetrics.reserveCoverage)
              ? formatPercent(Math.min(badDebtMetrics.reserveCoverage, 999))
              : "\u221E"}
          </div>
        </Card>
      </div>

      <Card className="!p-4">
        <div className="flex items-center gap-1.5 mb-3">
          <h3 className={`text-xs font-bold ${c.text1}`}>Bad debt by asset</h3>
          <InfoTooltip text="Breakdown of bad debt by collateral asset. Helps identify which assets are driving insolvency — useful for adjusting collateral factors or risk parameters." />
        </div>
        {assetBreakdown.length === 0 ? (
          <div className="rounded-lg border border-electric-500/20 bg-electric-500/5 px-4 py-3 text-xs font-semibold text-electric-500">
            No bad debt — all positions solvent (baseline).
          </div>
        ) : (
          <div className="space-y-2">
            {assetBreakdown.map((item) => (
              <div key={item.asset} className="flex items-center gap-3">
                <span className={`text-xs font-semibold w-14 ${c.text2}`}>{item.asset}</span>
                <div className="flex-1 h-2 rounded-full overflow-hidden bg-vgray-100">
                  <div
                    className="h-full rounded-full bg-imperial-500 transition-all"
                    style={{ width: `${Math.max(item.pct, 2)}%` }}
                  />
                </div>
                <span className="text-xs font-bold text-imperial-400 w-20 text-right font-mono">
                  {formatUsd(item.amount)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
