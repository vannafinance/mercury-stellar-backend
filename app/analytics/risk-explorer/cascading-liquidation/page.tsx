"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/analytics/PageHeader";
import { formatUsd, formatNumber, cn, hfColor } from "@/lib/analytics/utils";
import { useChartColors } from "@/lib/analytics/theme";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LineChart, Line, Legend } from "recharts";

const INSURANCE_FUND = 5_400_000;
const LIQ_THRESHOLD = 1.1;
const dr = (s: number) => { const x = Math.sin(s * 9301 + 49297) * 233280; return x - Math.floor(x); };

const BASE_POSITIONS = Array.from({ length: 30 }, (_, i) => {
  const hf = i < 3 ? 0.94 + i * 0.05 : 1.05 + (i - 3) * 0.09;
  const debt = Math.floor(60_000 + dr(i * 7) * 1_500_000 / 1000) * 1000;
  const marginValue = Math.floor(debt * Math.round(hf * 100) / 100);
  const leverage = Math.min(10, Math.max(1, Math.round(2 + dr(i * 13) * 8)));
  const trackTokens = Math.floor(marginValue * (0.1 + dr(i * 3) * 0.4));
  const cash = Math.floor(marginValue * 0.2);
  const aTokens = Math.floor(marginValue * dr(i * 5) * 0.4);
  const lpTokens = Math.max(0, marginValue - trackTokens - cash - aTokens);
  return { id: i, debt, marginValue, hf: Math.round(hf * 100) / 100, leverage, breakdown: { trackTokens, cash, aTokens, lpTokens } };
});

function runCascadeRound(
  positions: typeof BASE_POSITIONS,
  priceImpactBps: number,
  liquidationEfficiency: number,
  accPriceImpact: number
) {
  const tooBig = positions.filter(p => p.hf < LIQ_THRESHOLD);
  const totalSold = tooBig.reduce((a, p) => a + p.marginValue, 0);
  const newImpact = (totalSold / 1_000_000) * priceImpactBps / 10000;
  const totalPriceImpact = accPriceImpact + newImpact;
  const liquidated = tooBig;
  const grossRecovery = liquidated.reduce((a, p) => a + p.marginValue * liquidationEfficiency, 0);
  const debtLiquidated = liquidated.reduce((a, p) => a + p.debt, 0);
  const roundBadDebt = Math.max(0, debtLiquidated - grossRecovery);
  const remaining = positions
    .filter(p => p.hf >= LIQ_THRESHOLD)
    .map(p => {
      const newMargin = p.marginValue * (1 - totalPriceImpact);
      return { ...p, marginValue: newMargin, hf: Math.round((newMargin / p.debt) * 100) / 100 };
    });
  return { liquidated, remaining, roundBadDebt, debtLiquidated, grossRecovery, totalPriceImpact, newImpact };
}

export default function CascadingLiquidationPage() {
  const cc = useChartColors();
  const [impactBps, setImpactBps] = useState(50);
  const [maxRounds, setMaxRounds] = useState(3);
  const [liqEfficiency, setLiqEfficiency] = useState(0.9);
  const [hasRun, setHasRun] = useState(false);

  const cascadeResult = useMemo(() => {
    const rounds: Array<{ round: number; liquidated: number; debtLiquidated: number; badDebt: number; priceImpact: number; positions: number }> = [];
    let remaining = [...BASE_POSITIONS];
    let totalBadDebt = 0;
    let accPriceImpact = 0;

    for (let round = 1; round <= maxRounds; round++) {
      const r = runCascadeRound(remaining, impactBps, liqEfficiency, accPriceImpact);
      if (r.liquidated.length === 0) break;
      totalBadDebt += r.roundBadDebt;
      accPriceImpact = r.totalPriceImpact;
      rounds.push({
        round,
        liquidated: r.liquidated.length,
        debtLiquidated: r.debtLiquidated,
        badDebt: r.roundBadDebt,
        priceImpact: Math.round(r.totalPriceImpact * 100 * 100) / 100,
        positions: remaining.length - r.liquidated.length,
      });
      remaining = r.remaining;
    }

    const totalLiquidated = rounds.reduce((a, r) => a + r.liquidated, 0);
    const totalDebtLiquidated = rounds.reduce((a, r) => a + r.debtLiquidated, 0);
    const coverage = totalBadDebt > 0 ? Math.min(999, (INSURANCE_FUND / totalBadDebt) * 100) : 999;
    return { rounds, totalBadDebt, totalLiquidated, totalDebtLiquidated, coverage, fundRemaining: Math.max(0, INSURANCE_FUND - totalBadDebt), finalPositions: remaining.length };
  }, [impactBps, maxRounds, liqEfficiency]);

  return (
    <div className="p-6 w-full max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/analytics/overview2" className="flex items-center gap-1.5 text-[11px] text-vgray-400 hover:text-violet-600 transition-colors">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          Risk Command Center
        </Link>
        <span className="text-vgray-200">/</span>
        <span className="text-[11px] text-vgray-600 font-semibold">Cascading Liquidation Scenario</span>
      </div>
      <PageHeader title="Cascading Liquidation Scenario" subtitle="Model the liquidation spiral — first-wave selloff drives prices down, triggering second and third waves" />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="space-y-4">
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-5 space-y-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500">Cascade Controls</p>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Market Impact</label>
                <span className="font-bold font-mono text-sm text-violet-600">{impactBps} bps / $1M</span>
              </div>
              <input type="range" min={10} max={200} step={10} value={impactBps}
                onChange={e => setImpactBps(Number(e.target.value))}
                className="w-full h-1.5 appearance-none rounded-full bg-vgray-100 accent-violet-500 cursor-pointer"
              />
              <p className="text-[9px] text-vgray-400">Basis points of price drop per $1M of collateral sold</p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Max Cascade Rounds</label>
                <span className="font-bold font-mono text-sm text-violet-600">{maxRounds}</span>
              </div>
              <div className="flex gap-2">
                {[1, 2, 3, 5].map(r => (
                  <button key={r} onClick={() => setMaxRounds(r)}
                    className={cn("flex-1 py-1.5 rounded-r2 border text-[10px] font-bold transition-all",
                      maxRounds === r ? "bg-violet-50 border-violet-300 text-violet-700" : "border-vgray-100 text-vgray-400"
                    )}>{r}</button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Liquidation Efficiency</label>
                <span className="font-bold font-mono text-sm text-violet-600">{Math.round(liqEfficiency * 100)}%</span>
              </div>
              <input type="range" min={0.7} max={1.0} step={0.05} value={liqEfficiency}
                onChange={e => setLiqEfficiency(Number(e.target.value))}
                className="w-full h-1.5 appearance-none rounded-full bg-vgray-100 accent-violet-500 cursor-pointer"
              />
              <p className="text-[9px] text-vgray-400">% of debt recovered per liquidation (lower in stressed markets)</p>
            </div>

            <button onClick={() => setHasRun(true)}
              className="w-full py-3 rounded-r3 bg-gradient-to-r from-imperial-500 to-violet-500 text-white text-[11px] font-bold uppercase tracking-wide hover:opacity-90 transition-opacity shadow-vanna">
              Run Cascade Simulation
            </button>
          </div>
        </div>

        <div className="lg:col-span-2 space-y-4">
          {/* Core Metrics */}
          <div className={cn("bg-surface rounded-r4 border shadow-vanna p-5", hasRun ? "border-violet-200" : "border-vgray-100")}>
            <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500 mb-4">Cascade Results — {cascadeResult.rounds.length} rounds</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: "Total Positions Liquidated", value: String(cascadeResult.totalLiquidated), sub: `${cascadeResult.finalPositions} positions survive`, color: cascadeResult.totalLiquidated > 0 ? "#FC5457" : "#32EEE2" },
                { label: "Total Debt Liquidated", value: formatUsd(cascadeResult.totalDebtLiquidated), sub: `Across ${cascadeResult.rounds.length} rounds`, color: "#FF007A" },
                { label: "Net Bad Debt", value: formatUsd(cascadeResult.totalBadDebt), sub: "After all liquidations", color: cascadeResult.totalBadDebt > 0 ? "#FC5457" : "#32EEE2" },
                { label: "Insurance Coverage", value: `${Math.min(999, cascadeResult.coverage).toFixed(0)}%`, sub: `${formatUsd(cascadeResult.fundRemaining)} remaining`, color: cascadeResult.coverage >= 100 ? "#32EEE2" : "#FC5457" },
              ].map(r => (
                <div key={r.label} className="p-3 rounded-r3 bg-vgray-50/60 border border-vgray-100 space-y-1">
                  <p className="text-[9px] font-semibold uppercase tracking-wide text-vgray-400">{r.label}</p>
                  <p className="text-xl font-bold font-mono" style={{ color: r.color }}>{r.value}</p>
                  <p className="text-[9px] text-vgray-400">{r.sub}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Round-by-round */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-3">Round-by-Round Cascade Progress</p>
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="border-b border-vgray-100 text-vgray-400">
                    <th className="px-3 py-2 text-center font-semibold">Round</th>
                    <th className="px-3 py-2 text-center font-semibold">Liquidated</th>
                    <th className="px-3 py-2 text-right font-semibold">Debt Liquidated</th>
                    <th className="px-3 py-2 text-right font-semibold">Round Bad Debt</th>
                    <th className="px-3 py-2 text-right font-semibold">Cum. Price Impact</th>
                    <th className="px-3 py-2 text-center font-semibold">Surviving</th>
                  </tr>
                </thead>
                <tbody>
                  {cascadeResult.rounds.map(r => (
                    <tr key={r.round} className={cn("border-b border-vgray-100/60", r.badDebt > 0 ? "bg-imperial-50/20" : "")}>
                      <td className="px-3 py-2 text-center font-bold font-mono text-violet-600">R{r.round}</td>
                      <td className="px-3 py-2 text-center font-mono font-semibold text-imperial-600">{r.liquidated}</td>
                      <td className="px-3 py-2 text-right font-mono text-vgray-600">{formatUsd(r.debtLiquidated)}</td>
                      <td className="px-3 py-2 text-right font-mono" style={{ color: r.badDebt > 0 ? "#FC5457" : "#949494" }}>{r.badDebt > 0 ? formatUsd(r.badDebt) : "—"}</td>
                      <td className="px-3 py-2 text-right font-mono text-amber-600">-{r.priceImpact}%</td>
                      <td className="px-3 py-2 text-center font-mono text-electric-600">{r.positions}</td>
                    </tr>
                  ))}
                  {cascadeResult.rounds.length === 0 && (
                    <tr><td colSpan={6} className="px-3 py-4 text-center text-[10px] text-vgray-400">No positions triggered — cascade did not start</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Cascade chart */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-3">Cascade Flow — Liquidations per Round</p>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={cascadeResult.rounds} barSize={40}>
                <XAxis dataKey="round" tickFormatter={r => `Round ${r}`} tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={cc.tooltip} formatter={(v, name) => [name === "liquidated" ? `${v} positions` : formatUsd(Number(v ?? 0)), name === "liquidated" ? "Liquidated" : "Bad Debt"]} />
                <Bar dataKey="liquidated" name="liquidated" radius={[4, 4, 0, 0]}>
                  {cascadeResult.rounds.map((r, i) => <Cell key={i} fill={i === 0 ? "#FC5457" : i === 1 ? "#FF007A" : "#F59E0B"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
