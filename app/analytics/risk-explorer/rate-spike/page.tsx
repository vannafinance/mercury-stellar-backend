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

// Synthetic Stellar borrower distribution. The rate-spike scenario only
// needs debt + margin breakdown; address shape is for table display.
const BASE_POSITIONS = Array.from({ length: 38 }, (_, i) => {
  const debt = Math.floor(60_000 + dr(i * 7) * 1_500_000 / 1000) * 1000;
  const hf = 1.12 + dr(i * 11) * 1.9;
  const marginValue = Math.floor(debt * hf);
  const leverage = Math.min(10, Math.max(1, Math.round(1.5 + dr(i * 13) * 8.5)));
  const trackTokens = Math.floor(marginValue * (leverage >= 7 ? 0.35 + dr(i * 3) * 0.3 : 0.05 + dr(i * 3) * 0.2));
  const cash = Math.floor(marginValue * (0.1 + dr(i * 5) * 0.2));
  const aTokens = Math.floor(marginValue * dr(i * 7) * 0.35);
  const lpTokens = Math.max(0, marginValue - trackTokens - cash - aTokens);
  const borrowDuration = Math.floor(30 + dr(i * 17) * 335); // days already borrowed (30-365)
  return {
    id: i,
    debt,
    hf: Math.round(hf * 100) / 100,
    leverage,
    marginValue,
    trackTokens,
    cash,
    aTokens,
    lpTokens,
    borrowDuration,
    address: shortStellar(syntheticGAccount(i + 137)),
  };
});

function computeRateImpact(positions: typeof BASE_POSITIONS, newAPR: number, horizon: number) {
  const results = positions.map(pos => {
    // Additional interest accrued over horizon at new APR
    const extraInterest = pos.debt * newAPR * (horizon / 365);
    const newDebt = pos.debt + extraInterest;
    // Margin value doesn't change (price not moving — pure rate shock)
    const newHF = Math.round((pos.marginValue / newDebt) * 100) / 100;
    const liquidated = newHF < LIQ_THRESHOLD;
    const grossRecovery = liquidated ? pos.marginValue * 0.93 : 0;
    const badDebt = liquidated ? Math.max(0, newDebt - grossRecovery) : 0;
    return { ...pos, newDebt, extraInterest, newHF, liquidated, badDebt };
  });
  const liquidated = results.filter(p => p.liquidated);
  const totalBadDebt = liquidated.reduce((a, p) => a + p.badDebt, 0);
  const coverage = totalBadDebt > 0 ? Math.min(999, (INSURANCE_FUND / totalBadDebt) * 100) : 999;
  return { results, liquidated, totalBadDebt, coverage, fundRemaining: Math.max(0, INSURANCE_FUND - totalBadDebt) };
}

export default function RateSpikePage() {
  const cc = useChartColors();
  const [newAPR, setNewAPR] = useState(35);
  const [horizon, setHorizon] = useState(30);
  const [hasRun, setHasRun] = useState(false);

  const sim = useMemo(() => {
    return computeRateImpact(BASE_POSITIONS, newAPR / 100, horizon);
  }, [newAPR, horizon]);

  const BASE_APR = 0.08;

  // HF distribution before / after
  const hfBuckets = ["<1.1", "1.1-1.3", "1.3-1.5", "1.5-1.8", ">1.8"];
  const hfDist = hfBuckets.map((b, idx) => {
    const lows = [0, 1.1, 1.3, 1.5, 1.8];
    const highs = [1.1, 1.3, 1.5, 1.8, Infinity];
    return {
      bucket: b,
      before: BASE_POSITIONS.filter(p => p.hf >= lows[idx] && p.hf < highs[idx]).length,
      after: sim.results.filter(p => p.newHF >= lows[idx] && p.newHF < highs[idx]).length,
    };
  });

  // APR sensitivity sweep
  const aprSweep = [10, 15, 20, 25, 30, 40, 50, 75, 100].map(apr => {
    const r = computeRateImpact(BASE_POSITIONS, apr / 100, horizon);
    return { apr: `${apr}%`, liquidations: r.liquidated.length, badDebt: Math.round(r.totalBadDebt / 1000) };
  });

  // Horizon sensitivity
  const horizonSweep = [7, 14, 30, 60, 90, 180, 365].map(d => {
    const r = computeRateImpact(BASE_POSITIONS, newAPR / 100, d);
    return { days: `${d}d`, liquidations: r.liquidated.length };
  });

  // APR timeline — how APR compounds HF over time for a typical position
  const typicalPos = BASE_POSITIONS[5]; // median-ish position
  const aprTimeline = [0, 7, 14, 30, 60, 90, 180, 365].map(d => {
    const extraDebt = typicalPos.debt * (newAPR / 100) * (d / 365);
    const newHF = (typicalPos.marginValue / (typicalPos.debt + extraDebt));
    return { day: `D${d}`, hf: Math.round(newHF * 100) / 100 };
  });

  return (
    <div className="p-6 w-full max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/analytics/overview2" className="flex items-center gap-1.5 text-[11px] text-vgray-400 hover:text-violet-600 transition-colors">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          Risk Command Center
        </Link>
        <span className="text-vgray-200">/</span>
        <span className="text-[11px] text-vgray-600 font-semibold">Interest Rate Spike</span>
      </div>
      <PageHeader title="Interest Rate Spike" subtitle="Model a sudden borrow APR surge — elevated rates compound debt faster than margin grows, gradually pushing positions into liquidation territory" />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Controls */}
        <div className="space-y-4">
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-5 space-y-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500">Rate Controls</p>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">New Borrow APR</label>
                <span className="font-bold font-mono text-sm text-imperial-600">{newAPR}%</span>
              </div>
              <input type="range" min={10} max={150} step={5} value={newAPR}
                onChange={e => setNewAPR(Number(e.target.value))}
                className="w-full h-1.5 appearance-none rounded-full bg-vgray-100 accent-imperial-500 cursor-pointer"
              />
              <div className="flex justify-between text-[9px] text-vgray-300"><span>10%</span><span>75%</span><span>150%</span></div>
              <p className="text-[9px] text-vgray-400">Baseline APR is 8% — utilization crunch or governance spike can push this to 30-100%+</p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Elevated APR Duration</label>
                <span className="font-bold font-mono text-sm text-violet-600">{horizon} days</span>
              </div>
              <input type="range" min={1} max={180} step={1} value={horizon}
                onChange={e => setHorizon(Number(e.target.value))}
                className="w-full h-1.5 appearance-none rounded-full bg-vgray-100 accent-violet-500 cursor-pointer"
              />
              <div className="flex justify-between text-[9px] text-vgray-300"><span>1d</span><span>90d</span><span>180d</span></div>
            </div>

            {/* Key stats */}
            <div className="space-y-2 p-3 bg-vgray-50 rounded-r2 border border-vgray-100">
              <p className="text-[9px] font-bold uppercase tracking-wide text-vgray-400">Rate Impact Summary</p>
              {[
                { label: "APR increase", val: `+${newAPR - Math.round(BASE_APR * 100)}%` },
                { label: "Extra cost / $1M debt", val: formatUsd(1_000_000 * (newAPR / 100 - BASE_APR) * (horizon / 365)) },
                { label: "Total extra debt (all positions)", val: formatUsd(BASE_POSITIONS.reduce((a, p) => a + p.debt * (newAPR / 100 - BASE_APR) * (horizon / 365), 0)) },
                { label: "Positions at risk", val: String(sim.liquidated.length) },
              ].map(s => (
                <div key={s.label} className="flex justify-between">
                  <span className="text-[9px] text-vgray-400">{s.label}</span>
                  <span className="text-[9px] font-mono font-semibold text-vgray-700">{s.val}</span>
                </div>
              ))}
            </div>

            <button onClick={() => setHasRun(true)}
              className="w-full py-3 rounded-r3 bg-gradient-to-r from-imperial-500 to-violet-500 text-white text-[11px] font-bold uppercase tracking-wide hover:opacity-90 transition-opacity shadow-vanna">
              Simulate Rate Spike
            </button>
          </div>
        </div>

        {/* Results */}
        <div className="lg:col-span-2 space-y-4">
          {/* Core Metrics */}
          <div className={cn("bg-surface rounded-r4 border shadow-vanna p-5", hasRun ? "border-violet-200" : "border-vgray-100")}>
            <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500 mb-4">Impact at {newAPR}% APR over {horizon} Days</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: "Positions Below HF 1.1", value: String(sim.liquidated.length), sub: `of ${BASE_POSITIONS.length} borrowers`, color: sim.liquidated.length > 0 ? "#FC5457" : "#32EEE2" },
                { label: "Total Extra Debt Accrued", value: formatUsd(sim.results.reduce((a, p) => a + p.extraInterest, 0)), sub: `At ${newAPR}% APR for ${horizon}d`, color: "#F59E0B" },
                { label: "Net Bad Debt", value: formatUsd(sim.totalBadDebt), sub: "After liquidation recovery", color: sim.totalBadDebt > 0 ? "#FC5457" : "#32EEE2" },
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

          {/* HF Erosion over time */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">HF Erosion Over Time (Median Position)</p>
            <p className="text-[9px] text-vgray-400 mb-3">As debt compounds at elevated APR, HF gradually decays — crossing 1.1 triggers liquidation</p>
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={aprTimeline}>
                <XAxis dataKey="day" tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} domain={['auto', 'auto']} />
                <Tooltip contentStyle={cc.tooltip} formatter={(v) => [Number(v).toFixed(2), "Health Factor"]} />
                <ReferenceLine y={1.1} stroke="#FC5457" strokeDasharray="3 3" label={{ value: "Liq. Threshold 1.1", fill: "#FC5457", fontSize: 9, position: "right" }} />
                <Line type="monotone" dataKey="hf" stroke="#9F7BEE" strokeWidth={2} dot={{ r: 3, fill: "#9F7BEE" }} name="HF" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* APR sweep */}
            <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">Liquidations vs. APR Level</p>
              <p className="text-[9px] text-vgray-400 mb-3">At fixed {horizon}-day horizon</p>
              <ResponsiveContainer width="100%" height={140}>
                <BarChart data={aprSweep} barSize={18}>
                  <XAxis dataKey="apr" tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={cc.tooltip} formatter={(v) => [`${v} positions`, "Liquidated"]} />
                  <Bar dataKey="liquidations" name="liquidations" radius={[3, 3, 0, 0]}>
                    {aprSweep.map((d, i) => <Cell key={i} fill={d.liquidations > 10 ? "#FC5457" : d.liquidations > 3 ? "#FF007A" : "#F59E0B"} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* HF Distribution */}
            <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">HF Distribution Shift</p>
              <p className="text-[9px] text-vgray-400 mb-3">Before vs. after rate spike</p>
              <ResponsiveContainer width="100%" height={140}>
                <BarChart data={hfDist} barSize={16}>
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

          {/* Position table */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-3">Borrower Impact — Debt Compounding</p>
            <div className="overflow-x-auto scrollbar-thin max-h-48 overflow-y-auto">
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
                  {sim.results.sort((a, b) => a.newHF - b.newHF).slice(0, 20).map(p => (
                    <tr key={p.id} className={cn("border-b border-vgray-100/60", p.liquidated ? "bg-imperial-50/20" : "")}>
                      <td className="px-3 py-2 font-mono text-vgray-600">{p.address}</td>
                      <td className="px-3 py-2 text-right font-mono text-vgray-600">{formatUsd(p.debt)}</td>
                      <td className="px-3 py-2 text-right font-mono text-amber-600">+{formatUsd(p.extraInterest)}</td>
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
