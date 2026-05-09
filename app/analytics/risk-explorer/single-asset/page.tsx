"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { highRiskPositions, hfDistribution } from "@/lib/analytics/data/mock";
import { PageHeader } from "@/components/analytics/PageHeader";
import { formatUsd, formatNumber, cn, hfColor, hfBandColor } from "@/lib/analytics/utils";
import { useChartColors } from "@/lib/analytics/theme";
import CoinIcon from "@/components/analytics/ui/CoinIcon";
import { ACTIVE_ASSETS, FALLBACK_PRICES, syntheticGAccount, shortStellar } from "@/lib/analytics/stellar/canon";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from "recharts";

const INSURANCE_FUND = 5_400_000;
const LIQ_THRESHOLD = 1.1;
const dr = (s: number) => { const x = Math.sin(s * 9301 + 49297) * 233280; return x - Math.floor(x); };

// Extended positions for simulation
const SIM_POSITIONS = Array.from({ length: 28 }, (_, i) => {
  const hf = i < 2 ? 0.96 + i * 0.04 : 1.05 + (i - 2) * 0.1;
  const debt = Math.floor(60_000 + dr(i * 7) * 1_500_000 / 1000) * 1000;
  const marginValue = Math.floor(debt * hf);
  const leverage = Math.min(10, Math.max(1, Math.round(2 + dr(i * 13) * 8)));
  const trackPct = leverage >= 7 ? 0.4 + dr(i * 3) * 0.2 : dr(i * 3) * 0.2;
  const aTokenPct = dr(i * 5) * 0.35;
  const lpTokenPct = dr(i * 11) * 0.25;
  const trackTokens = Math.floor(marginValue * trackPct);
  const aTokens = Math.floor(marginValue * aTokenPct);
  const lpTokens = Math.floor(marginValue * lpTokenPct);
  const cash = Math.max(0, marginValue - trackTokens - aTokens - lpTokens);
  // Stellar-only universe: every synthetic position picks from the live
  // app's ACTIVE_ASSETS (lib/analytics/stellar/canon.ts) and gets a
  // format-correct G-account address.
  const collateralAsset = ACTIVE_ASSETS[Math.floor(dr(i * 17) * ACTIVE_ASSETS.length)];
  const fullAddr = syntheticGAccount(i + 1);
  return {
    id: i,
    address: shortStellar(fullAddr),
    chain: "stellar" as const,
    healthFactor: Math.round(hf * 100) / 100,
    totalDebt: debt,
    marginValue,
    leverage,
    collateralAsset,
    breakdown: { aTokens, lpTokens, trackTokens, cash },
  };
});

// Reference prices from the Reflector fallback table — same numbers the
// app uses when the live oracle hasn't returned yet.
const ASSETS_LIST = ACTIVE_ASSETS.map((symbol) => ({
  symbol,
  price: FALLBACK_PRICES[symbol] ?? 1,
}));

function computeSimulation(positions: typeof SIM_POSITIONS, asset: string, shockPct: number) {
  const shock = shockPct / 100;
  const results = positions.map(pos => {
    const isAffected = pos.collateralAsset === asset;
    const assetShock = isAffected ? shock : 0;
    const newCash = pos.breakdown.cash * (1 + assetShock);
    const newAToken = pos.breakdown.aTokens * (1 + assetShock * 0.3);
    const newLP = pos.breakdown.lpTokens * (1 + assetShock * 0.5);
    const perpMultiplier = pos.leverage >= 7 ? pos.leverage * 0.8 : 1;
    const newTrack = Math.max(0, pos.breakdown.trackTokens * (1 + assetShock * perpMultiplier));
    const newMargin = newCash + newAToken + newLP + newTrack;
    const newHF = newMargin / pos.totalDebt;
    return { ...pos, newHF: Math.round(newHF * 100) / 100, newMargin, isAffected };
  });

  const breaching = results.filter(p => p.newHF < LIQ_THRESHOLD);
  const totalDebtAtRisk = breaching.reduce((a, p) => a + p.totalDebt, 0);
  const grossRecovery = breaching.reduce((a, p) => a + p.newMargin * 0.95, 0);
  const netBadDebt = Math.max(0, totalDebtAtRisk - grossRecovery);
  const coveragePct = netBadDebt > 0 ? Math.min(999, (INSURANCE_FUND / netBadDebt) * 100) : 999;
  const fundRemaining = Math.max(0, INSURANCE_FUND - netBadDebt);

  return { breaching, totalDebtAtRisk, grossRecovery, netBadDebt, coveragePct, fundRemaining, results };
}

export default function SingleAssetSimPage() {
  const cc = useChartColors();
  // Default to XLM — only volatile asset in the Stellar universe.
  const [selectedAsset, setSelectedAsset] = useState<string>(ACTIVE_ASSETS[0]);
  const [shockPct, setShockPct] = useState(-30);
  const [hasRun, setHasRun] = useState(false);

  // Chain filter dropped — protocol only operates on Stellar; leaving it
  // would imply multi-chain support we don't have.
  const filteredPositions = SIM_POSITIONS;

  const sim = useMemo(() => computeSimulation(filteredPositions, selectedAsset, shockPct), [filteredPositions, selectedAsset, shockPct]);

  // Before/After HF distribution
  const hfBands = ["< 1.0", "1.0–1.1", "1.1–1.3", "1.3–1.5", "1.5–2.0", "> 2.0"];
  const getBand = (hf: number) => {
    if (hf < 1.0) return "< 1.0";
    if (hf < 1.1) return "1.0–1.1";
    if (hf < 1.3) return "1.1–1.3";
    if (hf < 1.5) return "1.3–1.5";
    if (hf < 2.0) return "1.5–2.0";
    return "> 2.0";
  };

  const beforeAfterData = hfBands.map(band => {
    const before = filteredPositions.filter(p => getBand(p.healthFactor) === band).reduce((a, p) => a + p.totalDebt, 0);
    const after = sim.results.filter(p => getBand(p.newHF) === band).reduce((a, p) => a + p.totalDebt, 0);
    return { band, before, after };
  });

  // Waterfall
  const waterfallData = [
    { name: "Debt at Risk", value: sim.totalDebtAtRisk, fill: "#FC5457" },
    { name: "Recovery", value: -sim.grossRecovery, fill: "#32EEE2" },
    { name: "Bad Debt", value: sim.netBadDebt, fill: "#FF007A" },
    { name: "Insurance", value: Math.min(sim.netBadDebt, INSURANCE_FUND), fill: "#703AE6" },
  ];

  return (
    <div className="p-6 w-full max-w-[1400px] mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/analytics/overview2" className="flex items-center gap-1.5 text-[11px] text-vgray-400 hover:text-violet-600 transition-colors">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          Risk Command Center
        </Link>
        <span className="text-vgray-200">/</span>
        <span className="text-[11px] text-vgray-600 font-semibold">Single Asset Risk Explorer</span>
      </div>

      <PageHeader title="Single Asset Risk Explorer" subtitle="Simulate how a single asset price shock affects all positions holding that collateral" />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Controls */}
        <div className="space-y-4">
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-5 space-y-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500">Simulation Controls</p>

            {/* Asset Selector */}
            <div className="space-y-2">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Asset</label>
              <div className="grid grid-cols-3 gap-1.5">
                {ASSETS_LIST.map(a => (
                  <button key={a.symbol} onClick={() => setSelectedAsset(a.symbol)}
                    className={cn("flex flex-col items-center gap-0.5 p-2 rounded-r2 border text-[10px] font-semibold transition-all",
                      selectedAsset === a.symbol ? "bg-violet-50 border-violet-300 text-violet-600" : "border-vgray-100 text-vgray-500 hover:border-vgray-200"
                    )}>
                    <CoinIcon symbol={a.symbol} size={20} />
                    <span>{a.symbol}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Price Shock */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Price Shock</label>
                <span className={cn("font-bold font-mono text-sm", shockPct < 0 ? "text-imperial-600" : "text-electric-600")}>{shockPct > 0 ? "+" : ""}{shockPct}%</span>
              </div>
              <input type="range" min={-90} max={20} step={5} value={shockPct}
                onChange={e => setShockPct(Number(e.target.value))}
                className="w-full h-1.5 appearance-none rounded-full bg-vgray-100 accent-imperial-500 cursor-pointer"
              />
              <div className="flex justify-between text-[9px] text-vgray-300">
                <span>-90%</span><span>-50%</span><span>-20%</span><span>0%</span><span>+20%</span>
              </div>
            </div>

            {/* Network indicator (read-only — protocol is Stellar-only) */}
            <div className="space-y-2">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Network</label>
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-r2 border border-vgray-100 bg-vgray-50">
                <span className="w-1.5 h-1.5 rounded-full bg-electric-500" />
                <span className="text-[10px] font-semibold text-vgray-700">Stellar (Soroban testnet)</span>
              </div>
            </div>

            {/* Presets */}
            <div className="space-y-2">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Quick Presets</label>
              <div className="space-y-1">
                {[{ label: "Mild (-15%)", shock: -15 }, { label: "Moderate (-30%)", shock: -30 }, { label: "Severe (-50%)", shock: -50 }, { label: "Extreme (-70%)", shock: -70 }].map(p => (
                  <button key={p.label} onClick={() => setShockPct(p.shock)}
                    className={cn("w-full text-left px-3 py-2 rounded-r2 text-[10px] font-semibold transition-colors border",
                      shockPct === p.shock ? "bg-imperial-50 border-imperial-200 text-imperial-700" : "border-vgray-100 text-vgray-500 hover:border-vgray-200"
                    )}>
                    {p.label} — {selectedAsset} @ ${ASSETS_LIST.find(a => a.symbol === selectedAsset)?.price ? formatNumber(Math.round(ASSETS_LIST.find(a => a.symbol === selectedAsset)!.price * (1 + p.shock / 100))) : "—"}
                  </button>
                ))}
              </div>
            </div>

            <button onClick={() => setHasRun(true)}
              className="w-full py-3 rounded-r3 bg-gradient-to-r from-imperial-500 to-violet-500 text-white text-[11px] font-bold uppercase tracking-wide hover:opacity-90 transition-opacity shadow-vanna">
              Run Simulation
            </button>
          </div>
        </div>

        {/* Results + Charts */}
        <div className="lg:col-span-2 space-y-4">
          {/* Results Panel */}
          <div className={cn("bg-surface rounded-r4 border shadow-vanna p-5 transition-all", hasRun ? "border-violet-200" : "border-vgray-100")}>
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500">Simulation Results</p>
              {!hasRun && <span className="text-[10px] text-vgray-300 italic">Click "Run Simulation" to see results</span>}
              {hasRun && <span className="flex items-center gap-1 text-[10px] font-semibold text-electric-700"><span className="w-1.5 h-1.5 rounded-full bg-electric-500 animate-pulse" />Live Preview</span>}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: "Positions Below HF 1.1", value: String(sim.breaching.length), sub: `${formatUsd(sim.totalDebtAtRisk)} debt at risk`, color: sim.breaching.length > 0 ? "#FC5457" : "#32EEE2" },
                { label: "Estimated Bad Debt", value: formatUsd(sim.netBadDebt), sub: `After ${formatUsd(sim.grossRecovery)} recovery`, color: sim.netBadDebt > 0 ? "#FF007A" : "#32EEE2" },
                { label: "Insurance Fund Coverage", value: sim.netBadDebt > 0 ? `${Math.min(999, sim.coveragePct).toFixed(0)}%` : "∞", sub: `${formatUsd(sim.fundRemaining)} remaining`, color: sim.coveragePct >= 100 ? "#32EEE2" : "#FC5457" },
                { label: "Protocol Solvency", value: sim.coveragePct >= 100 ? "SOLVENT" : "AT RISK", sub: sim.coveragePct >= 100 ? "Fund covers all bad debt" : "Insufficient coverage", color: sim.coveragePct >= 100 ? "#32EEE2" : "#FC5457" },
              ].map(r => (
                <div key={r.label} className="space-y-1 p-3 rounded-r3 bg-vgray-50/60 border border-vgray-100">
                  <p className="text-[9px] font-semibold uppercase tracking-wide text-vgray-400">{r.label}</p>
                  <p className="text-lg font-bold font-mono" style={{ color: r.color }}>{r.value}</p>
                  <p className="text-[9px] text-vgray-400">{r.sub}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">Before vs After — HF Distribution</p>
              <p className="text-[9px] text-vgray-400 mb-3">Debt exposure shift after {shockPct}% {selectedAsset} shock</p>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={beforeAfterData} barSize={12} barGap={2}>
                  <XAxis dataKey="band" tick={{ fontSize: 8, fill: cc.axisText }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 8, fill: cc.axisText }} axisLine={false} tickLine={false} tickFormatter={v => formatUsd(Number(v))} />
                  <Tooltip contentStyle={cc.tooltip} formatter={(v) => [formatUsd(Number(v ?? 0)), ""]} />
                  <Bar dataKey="before" name="Before" radius={[2, 2, 0, 0]}>
                    {beforeAfterData.map((d, i) => <Cell key={i} fill={hfBandColor(d.band)} opacity={0.4} />)}
                  </Bar>
                  <Bar dataKey="after" name="After" radius={[2, 2, 0, 0]}>
                    {beforeAfterData.map((d, i) => <Cell key={i} fill={hfBandColor(d.band)} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">Liquidation Waterfall</p>
              <p className="text-[9px] text-vgray-400 mb-3">Debt at risk → Recovery → Bad debt → Insurance coverage</p>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={waterfallData} barSize={36}>
                  <XAxis dataKey="name" tick={{ fontSize: 8, fill: cc.axisText }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 8, fill: cc.axisText }} axisLine={false} tickLine={false} tickFormatter={v => formatUsd(Math.abs(Number(v)))} />
                  <Tooltip contentStyle={cc.tooltip} formatter={(v) => [formatUsd(Math.abs(Number(v ?? 0))), ""]} />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {waterfallData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Position Impact Table */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna overflow-hidden">
            <div className="px-5 py-3 border-b border-vgray-100 flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500">Position Impact — {sim.results.filter(p => p.newHF < 1.5).length} positions affected</p>
              <span className="text-[9px] text-vgray-400">Showing positions with HF impact. Red = new liquidation.</span>
            </div>
            <div className="overflow-x-auto scrollbar-thin max-h-64">
              <table className="w-full text-[10px] min-w-[600px]">
                <thead className="sticky top-0 bg-vgray-50/90">
                  <tr className="border-b border-vgray-100">
                    <th className="px-3 py-2 text-left font-semibold text-vgray-400">Wallet</th>
                    <th className="px-3 py-2 text-left font-semibold text-vgray-400">Asset</th>
                    <th className="px-3 py-2 text-center font-semibold text-vgray-400">Before HF</th>
                    <th className="px-3 py-2 text-center font-semibold text-vgray-400">After HF</th>
                    <th className="px-3 py-2 text-right font-semibold text-vgray-400">Total Debt</th>
                    <th className="px-3 py-2 text-right font-semibold text-vgray-400">Bad Debt Est.</th>
                    <th className="px-3 py-2 text-center font-semibold text-vgray-400">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {sim.results
                    .filter(p => p.newHF < 2.0 || p.isAffected)
                    .sort((a, b) => a.newHF - b.newHF)
                    .slice(0, 20)
                    .map((pos) => {
                      const wasSafe = pos.healthFactor >= LIQ_THRESHOLD;
                      const nowUnsafe = pos.newHF < LIQ_THRESHOLD;
                      const badDebt = nowUnsafe ? Math.max(0, pos.totalDebt - pos.newMargin * 0.95) : 0;
                      return (
                        <tr key={pos.id} className={cn("border-b border-vgray-100/60", nowUnsafe ? "bg-imperial-50/30" : wasSafe && nowUnsafe ? "bg-amber-50/30" : "")}>
                          <td className="px-3 py-2 font-mono text-vgray-600">{pos.address}</td>
                          <td className="px-3 py-2">
                            <div className={cn("inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full", pos.collateralAsset === selectedAsset ? "bg-imperial-50 text-imperial-600" : "bg-vgray-50 text-vgray-500")}>
                              <CoinIcon symbol={pos.collateralAsset} size={12} />
                              {pos.collateralAsset}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-center font-mono" style={{ color: hfColor(pos.healthFactor) }}>{pos.healthFactor.toFixed(2)}</td>
                          <td className="px-3 py-2 text-center font-mono font-bold" style={{ color: hfColor(pos.newHF) }}>{pos.newHF.toFixed(2)}</td>
                          <td className="px-3 py-2 text-right font-mono text-vgray-600">{formatUsd(pos.totalDebt)}</td>
                          <td className="px-3 py-2 text-right font-mono" style={{ color: badDebt > 0 ? "#FC5457" : "#949494" }}>{badDebt > 0 ? formatUsd(badDebt) : "—"}</td>
                          <td className="px-3 py-2 text-center">
                            {nowUnsafe ? (
                              <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-imperial-100 text-imperial-700">LIQUIDATABLE</span>
                            ) : pos.newHF < 1.3 ? (
                              <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">CRITICAL</span>
                            ) : (
                              <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-electric-50 text-electric-700">OK</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
