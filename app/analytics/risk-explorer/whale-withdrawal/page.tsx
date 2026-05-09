"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/analytics/PageHeader";
import { formatUsd, formatNumber, cn } from "@/lib/analytics/utils";
import { useChartColors } from "@/lib/analytics/theme";
import { syntheticGAccount, shortStellar } from "@/lib/analytics/stellar/canon";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LineChart, Line, ReferenceLine, Legend } from "recharts";

const INSURANCE_FUND = 5_400_000;
const LIQ_THRESHOLD = 1.1;
const dr = (s: number) => { const x = Math.sin(s * 9301 + 49297) * 233280; return x - Math.floor(x); };

// Simulate lending pool state
const TOTAL_POOL = 28_000_000;
const BASE_APR = 0.08; // 8% base borrow APR
const BASE_UTILIZATION = 0.72;

// Generate borrower positions
const BORROWERS = Array.from({ length: 35 }, (_, i) => {
  const debt = Math.floor(50_000 + dr(i * 7) * 1_800_000 / 1000) * 1000;
  const hf = 1.12 + dr(i * 11) * 1.8;
  const marginValue = Math.floor(debt * hf);
  const leverage = Math.min(10, Math.max(1, Math.round(1.5 + dr(i * 13) * 8.5)));
  const trackTokens = Math.floor(marginValue * (0.1 + dr(i * 3) * 0.45));
  const cash = Math.floor(marginValue * (0.1 + dr(i * 5) * 0.2));
  const aTokens = Math.floor(marginValue * dr(i * 7) * 0.35);
  const lpTokens = Math.max(0, marginValue - trackTokens - cash - aTokens);
  return {
    id: i,
    debt,
    marginValue,
    hf: Math.round(hf * 100) / 100,
    leverage,
    address: shortStellar(syntheticGAccount(i + 113)),
    breakdown: { trackTokens, cash, aTokens, lpTokens },
  };
});

const TOTAL_DEBT = BORROWERS.reduce((a, p) => a + p.debt, 0);

// Kink utilization model
function getAPR(utilization: number) {
  const kink = 0.8;
  if (utilization <= kink) return BASE_APR + (utilization / kink) * 0.05;
  return (BASE_APR + 0.05) + ((utilization - kink) / (1 - kink)) * 0.45;
}

export default function WhaleWithdrawalPage() {
  const cc = useChartColors();
  const [withdrawalPct, setWithdrawalPct] = useState(30);
  const [horizon, setHorizon] = useState<7 | 30 | 90>(30);
  const [hasRun, setHasRun] = useState(false);

  const sim = useMemo(() => {
    const withdrawn = (withdrawalPct / 100) * TOTAL_POOL;
    const newPool = TOTAL_POOL - withdrawn;
    const newUtilization = Math.min(0.999, TOTAL_DEBT / newPool);
    const newAPR = getAPR(newUtilization);
    const baseAPR = getAPR(BASE_UTILIZATION);

    // Additional interest cost per position over horizon
    const extraAPR = newAPR - baseAPR;
    const horizonFraction = horizon / 365;

    const results = BORROWERS.map(pos => {
      const extraDebt = pos.debt * extraAPR * horizonFraction;
      const newDebt = pos.debt + extraDebt;
      const newHF = Math.round((pos.marginValue / newDebt) * 100) / 100;
      const liquidated = newHF < LIQ_THRESHOLD;
      const grossRecovery = liquidated ? pos.marginValue * 0.93 : 0;
      const badDebt = liquidated ? Math.max(0, newDebt - grossRecovery) : 0;
      return { ...pos, newDebt, newHF, liquidated, badDebt };
    });

    const liquidated = results.filter(p => p.liquidated);
    const totalBadDebt = liquidated.reduce((a, p) => a + p.badDebt, 0);
    const coverage = totalBadDebt > 0 ? Math.min(999, (INSURANCE_FUND / totalBadDebt) * 100) : 999;

    return {
      results,
      liquidated,
      totalBadDebt,
      coverage,
      newUtilization,
      newAPR,
      baseAPR,
      extraAPR,
      withdrawn,
      fundRemaining: Math.max(0, INSURANCE_FUND - totalBadDebt),
    };
  }, [withdrawalPct, horizon]);

  // APR curve data
  const aprCurve = Array.from({ length: 21 }, (_, i) => {
    const util = i * 0.05;
    return { util: `${Math.round(util * 100)}%`, apr: Math.round(getAPR(util) * 10000) / 100 };
  });

  // Horizon sensitivity — how many liquidations at each horizon
  const horizonData = [7, 14, 30, 60, 90, 180].map(days => {
    const extraAPR = sim.extraAPR;
    const hf = days / 365;
    const liq = BORROWERS.filter(p => {
      const newDebt = p.debt * (1 + extraAPR * hf);
      return (p.marginValue / newDebt) < LIQ_THRESHOLD;
    });
    const bd = liq.reduce((a, p) => {
      const newDebt = p.debt * (1 + extraAPR * hf);
      return a + Math.max(0, newDebt - p.marginValue * 0.93);
    }, 0);
    return { days: `${days}d`, liquidations: liq.length, badDebt: Math.round(bd / 1000) };
  });

  // Before/after HF distribution
  const hfBuckets = ["<1.1", "1.1-1.3", "1.3-1.5", "1.5-1.8", ">1.8"];
  const hfDistBefore = hfBuckets.map(b => ({ bucket: b, count: 0 }));
  const hfDistAfter = hfBuckets.map(b => ({ bucket: b, count: 0 }));
  BORROWERS.forEach(p => {
    const idx = p.hf < 1.1 ? 0 : p.hf < 1.3 ? 1 : p.hf < 1.5 ? 2 : p.hf < 1.8 ? 3 : 4;
    hfDistBefore[idx].count++;
  });
  sim.results.forEach(p => {
    const idx = p.newHF < 1.1 ? 0 : p.newHF < 1.3 ? 1 : p.newHF < 1.5 ? 2 : p.newHF < 1.8 ? 3 : 4;
    hfDistAfter[idx].count++;
  });
  const hfDist = hfBuckets.map((b, i) => ({ bucket: b, before: hfDistBefore[i].count, after: hfDistAfter[i].count }));

  return (
    <div className="p-6 w-full max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/analytics/overview2" className="flex items-center gap-1.5 text-[11px] text-vgray-400 hover:text-violet-600 transition-colors">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          Risk Command Center
        </Link>
        <span className="text-vgray-200">/</span>
        <span className="text-[11px] text-vgray-600 font-semibold">Whale Withdrawal Risk</span>
      </div>
      <PageHeader title="Whale Withdrawal Risk" subtitle="Model a large LP exit from the lending pool — utilization spikes, APR surges, and borrowers' debt compounds faster than their margins grow" />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Controls */}
        <div className="space-y-4">
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-5 space-y-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500">Withdrawal Controls</p>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">LP Withdrawal Size</label>
                <span className="font-bold font-mono text-sm text-imperial-600">{withdrawalPct}%</span>
              </div>
              <input type="range" min={5} max={80} step={5} value={withdrawalPct}
                onChange={e => setWithdrawalPct(Number(e.target.value))}
                className="w-full h-1.5 appearance-none rounded-full bg-vgray-100 accent-imperial-500 cursor-pointer"
              />
              <div className="flex justify-between text-[9px] text-vgray-300"><span>5%</span><span>40%</span><span>80%</span></div>
              <p className="text-[9px] text-vgray-400">Fraction of total lending pool ({formatUsd(TOTAL_POOL)}) withdrawn by whale LP</p>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Time Horizon</label>
              <div className="flex gap-2">
                {([7, 30, 90] as const).map(h => (
                  <button key={h} onClick={() => setHorizon(h)}
                    className={cn("flex-1 py-1.5 rounded-r2 border text-[10px] font-bold transition-all",
                      horizon === h ? "bg-violet-50 border-violet-300 text-violet-700" : "border-vgray-100 text-vgray-400"
                    )}>{h}d</button>
                ))}
              </div>
              <p className="text-[9px] text-vgray-400">Duration of elevated APR before pool rebalances</p>
            </div>

            {/* Pool Stats */}
            <div className="space-y-2 p-3 bg-vgray-50 rounded-r2 border border-vgray-100">
              <p className="text-[9px] font-bold uppercase tracking-wide text-vgray-400">Pool Impact</p>
              {[
                { label: "Withdrawn liquidity", val: formatUsd(sim.withdrawn) },
                { label: "Utilization before", val: `${Math.round(BASE_UTILIZATION * 100)}%` },
                { label: "Utilization after", val: <span style={{ color: sim.newUtilization > 0.9 ? "#FC5457" : "#F59E0B" }}>{Math.round(sim.newUtilization * 100)}%</span> },
                { label: "APR before", val: `${(sim.baseAPR * 100).toFixed(1)}%` },
                { label: "APR after", val: <span style={{ color: sim.newAPR > 0.2 ? "#FC5457" : "#F59E0B" }}>{(sim.newAPR * 100).toFixed(1)}%</span> },
                { label: "Extra APR cost", val: `+${(sim.extraAPR * 100).toFixed(1)}%` },
              ].map(s => (
                <div key={s.label} className="flex justify-between">
                  <span className="text-[9px] text-vgray-400">{s.label}</span>
                  <span className="text-[9px] font-mono font-semibold text-vgray-700">{s.val}</span>
                </div>
              ))}
            </div>

            <button onClick={() => setHasRun(true)}
              className="w-full py-3 rounded-r3 bg-gradient-to-r from-imperial-500 to-violet-500 text-white text-[11px] font-bold uppercase tracking-wide hover:opacity-90 transition-opacity shadow-vanna">
              Simulate Whale Exit
            </button>
          </div>
        </div>

        {/* Results */}
        <div className="lg:col-span-2 space-y-4">
          {/* Core Metrics */}
          <div className={cn("bg-surface rounded-r4 border shadow-vanna p-5", hasRun ? "border-violet-200" : "border-vgray-100")}>
            <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500 mb-4">Impact After {horizon}-Day Elevated APR</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: "Positions Below HF 1.1", value: String(sim.liquidated.length), sub: `of ${BORROWERS.length} borrowers`, color: sim.liquidated.length > 0 ? "#FC5457" : "#32EEE2" },
                { label: "New Borrow APR", value: `${(sim.newAPR * 100).toFixed(1)}%`, sub: `+${(sim.extraAPR * 100).toFixed(1)}% above base`, color: sim.newAPR > 0.2 ? "#FC5457" : "#F59E0B" },
                { label: "Net Bad Debt", value: formatUsd(sim.totalBadDebt), sub: "From forced liquidations", color: sim.totalBadDebt > 0 ? "#FC5457" : "#32EEE2" },
                { label: "Insurance Coverage", value: `${Math.min(999, sim.coverage).toFixed(0)}%`, sub: `${formatUsd(sim.fundRemaining)} remaining`, color: sim.coverage >= 100 ? "#32EEE2" : "#FC5457" },
              ].map(r => (
                <div key={r.label} className="p-3 rounded-r3 bg-vgray-50/60 border border-vgray-100 space-y-1">
                  <p className="text-[9px] font-semibold uppercase tracking-wide text-vgray-400">{r.label}</p>
                  <p className="text-xl font-bold font-mono" style={{ color: r.color }}>{r.value}</p>
                  <p className="text-[9px] text-vgray-400">{r.sub}</p>
                </div>
              ))}
            </div>
          </div>

          {/* APR Utilization Curve */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">APR Utilization Kink Curve</p>
            <p className="text-[9px] text-vgray-400 mb-3">Borrow APR jumps sharply past 80% utilization — whale exit can push protocol into the "kink zone"</p>
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={aprCurve}>
                <XAxis dataKey="util" tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} interval={3} />
                <YAxis tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} tickFormatter={v => `${v}%`} />
                <Tooltip contentStyle={cc.tooltip} formatter={(v) => [`${v}%`, "Borrow APR"]} />
                <ReferenceLine x={`${Math.round(sim.newUtilization * 100)}%`} stroke="#FC5457" strokeDasharray="3 3" label={{ value: "After", fill: "#FC5457", fontSize: 9, position: "top" }} />
                <ReferenceLine x={`${Math.round(BASE_UTILIZATION * 100)}%`} stroke="#32EEE2" strokeDasharray="3 3" label={{ value: "Before", fill: "#32EEE2", fontSize: 9, position: "top" }} />
                <Line type="monotone" dataKey="apr" stroke="#9F7BEE" strokeWidth={2} dot={false} name="APR (%)" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Horizon Sensitivity */}
            <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">Liquidations Over Time</p>
              <p className="text-[9px] text-vgray-400 mb-3">As debt compounds at elevated APR, more borrowers breach HF 1.1</p>
              <ResponsiveContainer width="100%" height={140}>
                <BarChart data={horizonData} barSize={18}>
                  <XAxis dataKey="days" tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={cc.tooltip} formatter={(v, name) => [name === "liquidations" ? `${v} positions` : `$${v}K bad debt`, name]} />
                  <Bar dataKey="liquidations" name="liquidations" fill="#FC5457" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* HF Distribution before/after */}
            <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">HF Distribution Shift</p>
              <p className="text-[9px] text-vgray-400 mb-3">Debt compounding pushes low-HF positions below liquidation threshold</p>
              <ResponsiveContainer width="100%" height={140}>
                <BarChart data={hfDist} barSize={14}>
                  <XAxis dataKey="bucket" tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={cc.tooltip} />
                  <Legend wrapperStyle={{ fontSize: 10, color: cc.legendColor }} />
                  <Bar dataKey="before" name="Before" fill="#32EEE2" opacity={0.5} radius={[2, 2, 0, 0]} />
                  <Bar dataKey="after" name="After" fill="#FC5457" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Position Impact Table */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-3">Borrower Impact — Debt Compounding</p>
            <div className="overflow-x-auto scrollbar-thin max-h-52 overflow-y-auto">
              <table className="w-full text-[10px]">
                <thead className="sticky top-0 bg-surface">
                  <tr className="border-b border-vgray-100 text-vgray-400">
                    <th className="px-3 py-2 text-left font-semibold">Position</th>
                    <th className="px-3 py-2 text-right font-semibold">Debt</th>
                    <th className="px-3 py-2 text-right font-semibold">Extra Interest</th>
                    <th className="px-3 py-2 text-center font-semibold">HF Before</th>
                    <th className="px-3 py-2 text-center font-semibold">HF After</th>
                    <th className="px-3 py-2 text-center font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sim.results.sort((a, b) => a.newHF - b.newHF).map(p => (
                    <tr key={p.id} className={cn("border-b border-vgray-100/60", p.liquidated ? "bg-imperial-50/20" : "")}>
                      <td className="px-3 py-2 font-mono text-vgray-600">{p.address}</td>
                      <td className="px-3 py-2 text-right font-mono text-vgray-600">{formatUsd(p.debt)}</td>
                      <td className="px-3 py-2 text-right font-mono text-amber-600">+{formatUsd(p.newDebt - p.debt)}</td>
                      <td className="px-3 py-2 text-center font-mono text-violet-600">{p.hf.toFixed(2)}</td>
                      <td className="px-3 py-2 text-center font-mono" style={{ color: p.newHF < LIQ_THRESHOLD ? "#FC5457" : p.newHF < 1.3 ? "#F59E0B" : "#32EEE2" }}>{p.newHF.toFixed(2)}</td>
                      <td className="px-3 py-2 text-center">
                        {p.liquidated
                          ? <span className="px-1.5 py-0.5 rounded bg-imperial-50 text-imperial-600 text-[8px] font-bold">LIQUIDATED</span>
                          : <span className="px-1.5 py-0.5 rounded bg-electric-50 text-electric-600 text-[8px] font-bold">SAFE</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
