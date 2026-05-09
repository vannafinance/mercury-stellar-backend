"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { leverageDistribution } from "@/lib/analytics/data/mock";
import { PageHeader } from "@/components/analytics/PageHeader";
import { formatUsd, formatNumber, cn } from "@/lib/analytics/utils";
import { useChartColors } from "@/lib/analytics/theme";
import { syntheticGAccount, shortStellar } from "@/lib/analytics/stellar/canon";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  LineChart, Line, ReferenceLine, Legend,
} from "recharts";

const INSURANCE_FUND = 5_400_000;
const LIQ_THRESHOLD = 1.1;
const dr = (s: number) => { const x = Math.sin(s * 9301 + 49297) * 233280; return x - Math.floor(x); };

// Generate positions grouped by leverage bucket
const ALL_POSITIONS = Array.from({ length: 40 }, (_, i) => {
  const leverageBuckets = [
    { min: 1, max: 2, prob: 0.15 },
    { min: 2, max: 4, prob: 0.25 },
    { min: 4, max: 6, prob: 0.20 },
    { min: 6, max: 8, prob: 0.22 },
    { min: 8, max: 10, prob: 0.18 },
  ];
  const r = dr(i * 3);
  let cumProb = 0; let bucket = leverageBuckets[0];
  for (const b of leverageBuckets) { cumProb += b.prob; if (r < cumProb) { bucket = b; break; } }
  const leverage = bucket.min + Math.round(dr(i * 7) * (bucket.max - bucket.min) * 10) / 10;
  const ownCollateral = Math.floor(50_000 + dr(i * 11) * 500_000 / 1000) * 1000;
  const debt = Math.floor(ownCollateral * (leverage - 1));
  const totalMargin = ownCollateral + debt;
  const hf = Math.round((totalMargin / debt) * 100) / 100;
  const trackPct = leverage >= 7 ? 0.45 + dr(i * 5) * 0.3 : 0.1 + dr(i * 5) * 0.3;
  const trackTokens = Math.floor(totalMargin * trackPct);
  const aTokens = Math.floor(totalMargin * dr(i * 13) * 0.4);
  const lpTokens = Math.floor(totalMargin * dr(i * 17) * 0.3);
  const cash = Math.max(0, totalMargin - trackTokens - aTokens - lpTokens);
  const breakEvenMove = ((hf - LIQ_THRESHOLD) / hf) * 100;
  return {
    id: i, leverage: Math.round(leverage * 10) / 10,
    bucket: `${Math.floor(leverage)}-${Math.ceil(leverage)}x`,
    ownCollateral, debt, totalMargin, hf,
    trackTokens, aTokens, lpTokens, cash,
    breakEvenMove: Math.round(breakEvenMove * 10) / 10,
    address: shortStellar(syntheticGAccount(i + 167)),
  };
});

export default function LeverageConcentrationPage() {
  const cc = useChartColors();
  const [priceDrop, setPriceDrop] = useState(-10);
  const [leverageThreshold, setLeverageThreshold] = useState(5);
  const [hasRun, setHasRun] = useState(false);

  const sim = useMemo(() => {
    const shock = priceDrop / 100;
    const results = ALL_POSITIONS.map(pos => {
      const trackShock = pos.leverage >= 7 ? shock * pos.leverage * 0.8 : shock;
      const newTrack = Math.max(0, pos.trackTokens * (1 + trackShock));
      const newCash = pos.cash * (1 + shock);
      const newAToken = pos.aTokens * (1 + shock * 0.3);
      const newLP = pos.lpTokens * (1 + shock * 0.5);
      const newMargin = newCash + newAToken + newLP + newTrack;
      const newHF = Math.round((newMargin / pos.debt) * 100) / 100;
      return { ...pos, newHF, newMargin };
    });
    const highLev = results.filter(p => p.leverage >= leverageThreshold);
    const breaching = results.filter(p => p.newHF < LIQ_THRESHOLD);
    const highLevBreaching = highLev.filter(p => p.newHF < LIQ_THRESHOLD);
    const debtAtRisk = breaching.reduce((a, p) => a + p.debt, 0);
    const grossRec = breaching.reduce((a, p) => a + p.newMargin * 0.93, 0);
    const netBadDebt = Math.max(0, debtAtRisk - grossRec);
    const coverage = netBadDebt > 0 ? Math.min(999, (INSURANCE_FUND / netBadDebt) * 100) : 999;
    return { results, breaching, highLevBreaching, highLev, debtAtRisk, grossRec, netBadDebt, coverage, fundRemaining: Math.max(0, INSURANCE_FUND - netBadDebt) };
  }, [priceDrop, leverageThreshold]);

  // Cliff chart — positions liquidated at each price drop increment
  const cliffData = [1, 2, 3, 5, 7, 10, 15, 20].map(drop => {
    const shock = -drop / 100;
    const liq = ALL_POSITIONS.filter(pos => {
      const trackShock = pos.leverage >= 7 ? shock * pos.leverage * 0.8 : shock;
      const newTrack = Math.max(0, pos.trackTokens * (1 + trackShock));
      const newMargin = pos.cash * (1 + shock) + pos.aTokens * 0.9 + pos.lpTokens * 0.8 + newTrack;
      return (newMargin / pos.debt) < LIQ_THRESHOLD;
    });
    const debtLiq = liq.reduce((a, p) => a + p.debt, 0);
    const grossR = liq.reduce((a, p) => {
      const trackShock = p.leverage >= 7 ? shock * p.leverage * 0.8 : shock;
      const newTrack = Math.max(0, p.trackTokens * (1 + trackShock));
      const newM = p.cash * (1 + shock) + p.aTokens * 0.9 + p.lpTokens * 0.8 + newTrack;
      return a + newM * 0.93;
    }, 0);
    const badDebt = Math.max(0, debtLiq - grossR);
    return { drop: `-${drop}%`, positions: liq.length, badDebt: Math.round(badDebt / 1000), insuranceRunOut: badDebt > INSURANCE_FUND };
  });

  // Leverage distribution data enhanced
  const leverageData = leverageDistribution.map(b => ({
    ...b,
    atRisk: Math.round(b.count * (priceDrop < -15 && parseInt(b.range) >= 8 ? 0.9 : priceDrop < -10 && parseInt(b.range) >= 6 ? 0.7 : priceDrop < -5 && parseInt(b.range) >= 8 ? 0.5 : 0.1)),
  }));

  const leverageColor = (range: string) => {
    const n = parseInt(range);
    if (n >= 9) return "#FC5457";
    if (n >= 7) return "#FF007A";
    if (n >= 5) return "#F59E0B";
    if (n >= 3) return "#9F7BEE";
    return "#32EEE2";
  };

  return (
    <div className="p-6 w-full max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/analytics/overview2" className="flex items-center gap-1.5 text-[11px] text-vgray-400 hover:text-violet-600 transition-colors">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          Risk Command Center
        </Link>
        <span className="text-vgray-200">/</span>
        <span className="text-[11px] text-vgray-600 font-semibold">High-Leverage Concentration Risk</span>
      </div>
      <PageHeader title="High-Leverage Concentration Risk" subtitle="Map protocol-wide leverage concentration and find the liquidation cliff — the price drop that causes systemic bad debt" />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Controls */}
        <div className="space-y-4">
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-5 space-y-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500">Analysis Controls</p>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Price Drop to Simulate</label>
                <span className="font-bold font-mono text-sm text-imperial-600">{priceDrop}%</span>
              </div>
              <input type="range" min={-50} max={-1} step={1} value={priceDrop}
                onChange={e => setPriceDrop(Number(e.target.value))}
                className="w-full h-1.5 appearance-none rounded-full bg-vgray-100 accent-imperial-500 cursor-pointer"
              />
              <div className="flex justify-between text-[9px] text-vgray-300"><span>-50%</span><span>-25%</span><span>-1%</span></div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">High-Leverage Threshold</label>
                <span className="font-bold font-mono text-sm text-violet-600">{leverageThreshold}x</span>
              </div>
              <input type="range" min={3} max={9} step={1} value={leverageThreshold}
                onChange={e => setLeverageThreshold(Number(e.target.value))}
                className="w-full h-1.5 appearance-none rounded-full bg-vgray-100 accent-violet-500 cursor-pointer"
              />
              <p className="text-[9px] text-vgray-400">Positions above this leverage are "high-leverage"</p>
            </div>

            {/* Protocol Stats */}
            <div className="space-y-2 p-3 bg-vgray-50 rounded-r2 border border-vgray-100">
              <p className="text-[9px] font-bold uppercase tracking-wide text-vgray-400">Protocol Leverage Stats</p>
              {[
                { label: "High-leverage positions", val: formatNumber(sim.highLev.length) },
                { label: "High-lev debt total", val: formatUsd(sim.highLev.reduce((a, p) => a + p.debt, 0)) },
                { label: "Avg break-even move", val: `${(sim.highLev.reduce((a, p) => a + p.breakEvenMove, 0) / Math.max(1, sim.highLev.length)).toFixed(1)}%` },
              ].map(s => (
                <div key={s.label} className="flex justify-between">
                  <span className="text-[9px] text-vgray-400">{s.label}</span>
                  <span className="text-[9px] font-mono font-semibold text-vgray-700">{s.val}</span>
                </div>
              ))}
            </div>

            <button onClick={() => setHasRun(true)}
              className="w-full py-3 rounded-r3 bg-gradient-to-r from-imperial-500 to-violet-500 text-white text-[11px] font-bold uppercase tracking-wide hover:opacity-90 transition-opacity shadow-vanna">
              Analyze Concentration Risk
            </button>
          </div>
        </div>

        {/* Results */}
        <div className="lg:col-span-2 space-y-4">
          {/* Core Metrics */}
          <div className={cn("bg-surface rounded-r4 border shadow-vanna p-5", hasRun ? "border-violet-200" : "border-vgray-100")}>
            <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500 mb-4">Simulation Results at {priceDrop}% Drop</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: "Positions Below HF 1.1", value: String(sim.breaching.length), sub: `${formatUsd(sim.debtAtRisk)} at risk`, color: sim.breaching.length > 0 ? "#FC5457" : "#32EEE2" },
                { label: `High-Lev (>${leverageThreshold}x) Liquidated`, value: String(sim.highLevBreaching.length), sub: `of ${sim.highLev.length} high-lev positions`, color: sim.highLevBreaching.length > 0 ? "#FF007A" : "#949494" },
                { label: "Estimated Bad Debt", value: formatUsd(sim.netBadDebt), sub: `${formatUsd(INSURANCE_FUND - sim.netBadDebt > 0 ? INSURANCE_FUND - sim.netBadDebt : 0)} fund remaining`, color: sim.netBadDebt > 0 ? "#FF007A" : "#32EEE2" },
                { label: "Protocol Solvency", value: sim.coverage >= 100 ? "SOLVENT" : "AT RISK", sub: `${Math.min(999, sim.coverage).toFixed(0)}% coverage`, color: sim.coverage >= 100 ? "#32EEE2" : "#FC5457" },
              ].map(r => (
                <div key={r.label} className="p-3 rounded-r3 bg-vgray-50/60 border border-vgray-100 space-y-1">
                  <p className="text-[9px] font-semibold uppercase tracking-wide text-vgray-400">{r.label}</p>
                  <p className="text-xl font-bold font-mono" style={{ color: r.color }}>{r.value}</p>
                  <p className="text-[9px] text-vgray-400">{r.sub}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Liquidation Cliff Chart */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">Liquidation Cliff Chart</p>
            <p className="text-[9px] text-vgray-400 mb-3">Positions liquidated + bad debt ($K) at each price drop — watch for the "cliff" where bad debt spikes</p>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={cliffData} barSize={22}>
                <XAxis dataKey="drop" tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                <YAxis yAxisId="left" tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}K`} />
                <Tooltip contentStyle={cc.tooltip} formatter={(v, name) => [name === "positions" ? `${v} positions` : `$${v}K bad debt`, name]} />
                <Legend wrapperStyle={{ fontSize: 10, color: cc.legendColor }} />
                <Bar yAxisId="left" dataKey="positions" name="Positions Liquidated" radius={[3, 3, 0, 0]}>
                  {cliffData.map((d, i) => <Cell key={i} fill={d.insuranceRunOut ? "#FC5457" : d.positions > 10 ? "#FF007A" : "#F59E0B"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Leverage Distribution */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">Leverage Concentration — Protocol-Wide</p>
            <p className="text-[9px] text-vgray-400 mb-3">Position count by leverage bucket — high concentration at 8-10x is systemic risk</p>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={leverageData} barSize={26}>
                <XAxis dataKey="range" tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={cc.tooltip} formatter={(v, name) => [formatNumber(Number(v ?? 0)), name === "count" ? "Positions" : "At Risk"]} />
                <Bar dataKey="count" name="Total Positions" radius={[3, 3, 0, 0]}>
                  {leverageData.map((d, i) => <Cell key={i} fill={leverageColor(d.range)} opacity={0.4} />)}
                </Bar>
                <Bar dataKey="atRisk" name="Liquidated at Current Drop" radius={[3, 3, 0, 0]}>
                  {leverageData.map((d, i) => <Cell key={i} fill={leverageColor(d.range)} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
