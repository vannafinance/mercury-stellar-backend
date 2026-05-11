"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { hfDistribution } from "@/lib/analytics/data/mock";
import { PageHeader } from "@/components/analytics/PageHeader";
import { formatUsd, formatNumber, cn, hfColor, hfBandColor } from "@/lib/analytics/utils";
import { useChartColors } from "@/lib/analytics/theme";
import CoinIcon from "@/components/analytics/ui/CoinIcon";
import { ACTIVE_ASSETS, syntheticGAccount, shortStellar, type StellarAsset } from "@/lib/analytics/stellar/canon";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

const INSURANCE_FUND = 5_400_000;
const LIQ_THRESHOLD = 1.1;
const dr = (s: number) => { const x = Math.sin(s * 9301 + 49297) * 233280; return x - Math.floor(x); };

// Stellar-native multi-asset shocks. XLM is the only volatile asset in
// the universe; the three USDC variants depeg independently per pool
// (Blend / Aquarius / Soroswap). Presets reflect events that could
// realistically affect this protocol.
const PRESETS = [
  {
    id: "xlm-deep-bear",
    label: "XLM Deep Bear",
    shocks: { XLM: -50, BLUSDC: 0, AQUSDC: 0, SOUSDC: 0, EURC: 0 },
    desc: "XLM -50% over multi-week drawdown — stables hold their peg",
  },
  {
    id: "stellar-flash-crash",
    label: "Stellar Flash Crash",
    shocks: { XLM: -35, BLUSDC: -2, AQUSDC: -3, SOUSDC: -2, EURC: 0 },
    desc: "XLM -35% in 1h with mild stable wobble across all pools",
  },
  {
    id: "stable-contagion",
    label: "Stable Pool Contagion",
    shocks: { XLM: -10, BLUSDC: -8, AQUSDC: -7, SOUSDC: -6, EURC: 0 },
    desc: "Cross-pool USDC depeg (~7%) with XLM partially affected",
  },
  {
    id: "reflector-failure-proxy",
    label: "Reflector Oracle Failure",
    shocks: { XLM: -20, BLUSDC: -3, AQUSDC: -3, SOUSDC: -3, EURC: 0 },
    desc: "Stale/incorrect oracle prints — stress proxy across the board",
  },
  {
    id: "custom",
    label: "Custom",
    shocks: { XLM: -30, BLUSDC: 0, AQUSDC: 0, SOUSDC: 0, EURC: 0 },
    desc: "Set your own per-asset shocks",
  },
];

const ASSETS = ACTIVE_ASSETS;
type Asset = StellarAsset;

const SIM_POSITIONS = Array.from({ length: 30 }, (_, i) => {
  const hf = i < 2 ? 0.96 + i * 0.05 : 1.05 + (i - 2) * 0.1;
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
  const assetIdx = Math.floor(dr(i * 17) * ASSETS.length);
  return {
    id: i,
    address: shortStellar(syntheticGAccount(i + 11)),
    chain: "stellar" as const,
    healthFactor: Math.round(hf * 100) / 100,
    totalDebt: debt,
    marginValue,
    leverage,
    collateralAsset: ASSETS[assetIdx],
    breakdown: { aTokens, lpTokens, trackTokens, cash },
  };
});

export default function MultiAssetCrashPage() {
  const cc = useChartColors();
  const [activePreset, setActivePreset] = useState("xlm-deep-bear");
  const [shocks, setShocks] = useState<Record<Asset, number>>({ XLM: -50, BLUSDC: 0, AQUSDC: 0, SOUSDC: 0, EURC: 0 });
  const [hasRun, setHasRun] = useState(false);

  const applyPreset = (presetId: string) => {
    const preset = PRESETS.find(p => p.id === presetId);
    if (preset) { setShocks(preset.shocks as Record<Asset, number>); setActivePreset(presetId); }
  };

  const sim = useMemo(() => {
    const results = SIM_POSITIONS.map(pos => {
      const assetShock = (shocks[pos.collateralAsset as Asset] ?? 0) / 100;
      const perpMulti = pos.leverage >= 7 ? pos.leverage * 0.8 : 1;
      const newTrack = Math.max(0, pos.breakdown.trackTokens * (1 + assetShock * perpMulti));
      const newLP = pos.breakdown.lpTokens * (1 + assetShock * 0.5);
      const newAToken = pos.breakdown.aTokens * (1 + assetShock * 0.3);
      const newCash = pos.breakdown.cash * (1 + assetShock);
      const newMargin = newCash + newAToken + newLP + newTrack;
      const newHF = Math.round((newMargin / pos.totalDebt) * 100) / 100;
      return { ...pos, newHF, newMargin };
    });
    const breaching = results.filter(p => p.newHF < LIQ_THRESHOLD);
    const totalDebtAtRisk = breaching.reduce((a, p) => a + p.totalDebt, 0);
    const grossRecovery = breaching.reduce((a, p) => a + p.newMargin * 0.95, 0);
    const netBadDebt = Math.max(0, totalDebtAtRisk - grossRecovery);
    const coveragePct = netBadDebt > 0 ? Math.min(999, (INSURANCE_FUND / netBadDebt) * 100) : 999;
    return { results, breaching, totalDebtAtRisk, grossRecovery, netBadDebt, coveragePct, fundRemaining: Math.max(0, INSURANCE_FUND - netBadDebt) };
  }, [shocks]);

  // Per-asset impact
  const assetImpact = ASSETS.map(asset => {
    const affected = sim.results.filter(p => p.collateralAsset === asset && p.newHF < LIQ_THRESHOLD);
    return { asset, positions: affected.length, debt: affected.reduce((a, p) => a + p.totalDebt, 0), shock: shocks[asset] };
  });

  const hfBands = ["< 1.0", "1.0–1.1", "1.1–1.3", "1.3–1.5", "1.5–2.0", "> 2.0"];
  const getBand = (hf: number) => { if (hf < 1.0) return "< 1.0"; if (hf < 1.1) return "1.0–1.1"; if (hf < 1.3) return "1.1–1.3"; if (hf < 1.5) return "1.3–1.5"; if (hf < 2.0) return "1.5–2.0"; return "> 2.0"; };
  const distData = hfBands.map(band => ({
    band,
    before: SIM_POSITIONS.filter(p => getBand(p.healthFactor) === band).reduce((a, p) => a + p.totalDebt, 0),
    after: sim.results.filter(p => getBand(p.newHF) === band).reduce((a, p) => a + p.totalDebt, 0),
  }));

  return (
    <div className="p-6 w-full max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/analytics/overview2" className="flex items-center gap-1.5 text-[11px] text-vgray-400 hover:text-violet-600 transition-colors">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          Risk Command Center
        </Link>
        <span className="text-vgray-200">/</span>
        <span className="text-[11px] text-vgray-600 font-semibold">Multi-Asset Correlated Crash</span>
      </div>
      <PageHeader title="Multi-Asset Correlated Crash Simulation" subtitle="Simulate simultaneous price drops across multiple assets with correlation effects" />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Controls */}
        <div className="space-y-4">
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-5 space-y-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500">Scenario Controls</p>
            {/* Presets */}
            <div className="space-y-2">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Preset Scenarios</label>
              <div className="space-y-1.5">
                {PRESETS.map(p => (
                  <button key={p.id} onClick={() => applyPreset(p.id)}
                    className={cn("w-full text-left px-3 py-2.5 rounded-r2 border transition-all",
                      activePreset === p.id ? "bg-violet-50 border-violet-300 text-violet-700" : "border-vgray-100 text-vgray-500 hover:border-vgray-200"
                    )}>
                    <p className="text-[11px] font-semibold">{p.label}</p>
                    <p className="text-[9px] text-vgray-400 mt-0.5">{p.desc}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Per-asset sliders */}
            <div className="space-y-3">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Asset Price Shocks</label>
              {ASSETS.map(asset => (
                <div key={asset}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-1.5">
                      <CoinIcon symbol={asset} size={16} />
                      <span className="text-[10px] font-semibold text-vgray-600">{asset}</span>
                    </div>
                    <span className={cn("font-mono text-[10px] font-bold", shocks[asset] < 0 ? "text-imperial-600" : "text-electric-600")}>{shocks[asset] > 0 ? "+" : ""}{shocks[asset]}%</span>
                  </div>
                  <input type="range" min={-90} max={10} step={5} value={shocks[asset]}
                    onChange={e => { setActivePreset("custom"); setShocks(prev => ({ ...prev, [asset]: Number(e.target.value) })); }}
                    className="w-full h-1 appearance-none rounded-full bg-vgray-100 accent-imperial-500 cursor-pointer"
                  />
                </div>
              ))}
            </div>

            <button onClick={() => setHasRun(true)}
              className="w-full py-3 rounded-r3 bg-gradient-to-r from-imperial-500 to-violet-500 text-white text-[11px] font-bold uppercase tracking-wide hover:opacity-90 transition-opacity shadow-vanna">
              Run Crash Simulation
            </button>
          </div>
        </div>

        {/* Results */}
        <div className="lg:col-span-2 space-y-4">
          {/* Core 4 metrics */}
          <div className={cn("bg-surface rounded-r4 border shadow-vanna p-5", hasRun ? "border-violet-200" : "border-vgray-100")}>
            <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500 mb-4">Simulation Results</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: "Positions Below HF 1.1", value: String(sim.breaching.length), sub: `${formatUsd(sim.totalDebtAtRisk)} at risk`, color: sim.breaching.length > 0 ? "#FC5457" : "#32EEE2" },
                { label: "Estimated Bad Debt", value: formatUsd(sim.netBadDebt), sub: `${formatUsd(sim.grossRecovery)} gross recovery`, color: sim.netBadDebt > 0 ? "#FF007A" : "#32EEE2" },
                { label: "Insurance Coverage", value: sim.netBadDebt > 0 ? `${Math.min(999, sim.coveragePct).toFixed(0)}%` : "Full", sub: `${formatUsd(sim.fundRemaining)} remaining`, color: sim.coveragePct >= 100 ? "#32EEE2" : "#FC5457" },
                { label: "Protocol Solvency", value: sim.coveragePct >= 100 ? "SOLVENT" : "INSOLVENT", sub: `Fund: ${formatUsd(INSURANCE_FUND)}`, color: sim.coveragePct >= 100 ? "#32EEE2" : "#FC5457" },
              ].map(r => (
                <div key={r.label} className="p-3 rounded-r3 bg-vgray-50/60 border border-vgray-100 space-y-1">
                  <p className="text-[9px] font-semibold uppercase tracking-wide text-vgray-400">{r.label}</p>
                  <p className="text-xl font-bold font-mono" style={{ color: r.color }}>{r.value}</p>
                  <p className="text-[9px] text-vgray-400">{r.sub}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Per-asset impact */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-3">Per-Asset Impact Breakdown</p>
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="border-b border-vgray-100 text-vgray-400">
                    <th className="px-3 py-2 text-left font-semibold">Asset</th>
                    <th className="px-3 py-2 text-center font-semibold">Shock Applied</th>
                    <th className="px-3 py-2 text-center font-semibold">Positions Affected</th>
                    <th className="px-3 py-2 text-right font-semibold">Debt at Risk</th>
                    <th className="px-3 py-2 text-center font-semibold">Risk Level</th>
                  </tr>
                </thead>
                <tbody>
                  {assetImpact.map(a => (
                    <tr key={a.asset} className="border-b border-vgray-100/60">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <CoinIcon symbol={a.asset} size={16} />
                          <span className="font-semibold text-vgray-700">{a.asset}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-center font-mono font-bold" style={{ color: a.shock < 0 ? "#FC5457" : "#32EEE2" }}>{a.shock > 0 ? "+" : ""}{a.shock}%</td>
                      <td className="px-3 py-2 text-center font-mono">{a.positions}</td>
                      <td className="px-3 py-2 text-right font-mono text-vgray-600">{a.debt > 0 ? formatUsd(a.debt) : "—"}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={cn("text-[8px] font-bold px-1.5 py-0.5 rounded-full",
                          a.shock < -50 ? "bg-imperial-100 text-imperial-700" :
                          a.shock < -25 ? "bg-amber-100 text-amber-700" :
                          a.shock < 0 ? "bg-violet-50 text-violet-600" : "bg-electric-50 text-electric-700"
                        )}>
                          {a.shock < -50 ? "EXTREME" : a.shock < -25 ? "SEVERE" : a.shock < 0 ? "MODERATE" : "SAFE"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* HF distribution before/after */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">HF Distribution — Before vs After Crash</p>
            <p className="text-[9px] text-vgray-400 mb-3">Faded = before shock · Solid = after shock</p>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={distData} barSize={14} barGap={2}>
                <XAxis dataKey="band" tick={{ fontSize: 8, fill: cc.axisText }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 8, fill: cc.axisText }} axisLine={false} tickLine={false} tickFormatter={v => formatUsd(Number(v))} />
                <Tooltip contentStyle={cc.tooltip} formatter={(v) => [formatUsd(Number(v ?? 0)), ""]} />
                <Bar dataKey="before" name="Before" radius={[2, 2, 0, 0]}>
                  {distData.map((d, i) => <Cell key={i} fill={hfBandColor(d.band)} opacity={0.35} />)}
                </Bar>
                <Bar dataKey="after" name="After" radius={[2, 2, 0, 0]}>
                  {distData.map((d, i) => <Cell key={i} fill={hfBandColor(d.band)} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Position Impact Table */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500">Position Impact — All {SIM_POSITIONS.length} Positions</p>
                <p className="text-[9px] text-vgray-400 mt-0.5">Sorted by post-crash HF · Lowest first — shows exact positions affected by this scenario</p>
              </div>
              <div className="flex items-center gap-3 text-[9px]">
                <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-imperial-500 inline-block" />Liquidated</div>
                <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />Critical</div>
                <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-electric-500 inline-block" />Safe</div>
              </div>
            </div>
            <div className="overflow-x-auto scrollbar-thin max-h-72 overflow-y-auto">
              <table className="w-full text-[10px]">
                <thead className="sticky top-0 bg-surface z-10">
                  <tr className="border-b border-vgray-100 text-vgray-400">
                    <th className="px-3 py-2 text-left font-semibold w-7">#</th>
                    <th className="px-3 py-2 text-left font-semibold">Wallet</th>
                    <th className="px-3 py-2 text-center font-semibold">Collateral</th>
                    <th className="px-3 py-2 text-center font-semibold">Shock</th>
                    <th className="px-3 py-2 text-center font-semibold">HF Before</th>
                    <th className="px-3 py-2 text-center font-semibold">HF After</th>
                    <th className="px-3 py-2 text-center font-semibold">Leverage</th>
                    <th className="px-3 py-2 text-right font-semibold">Total Debt</th>
                    <th className="px-3 py-2 text-right font-semibold">Bad Debt Est.</th>
                    <th className="px-3 py-2 text-center font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {[...sim.results]
                    .sort((a, b) => a.newHF - b.newHF)
                    .map((pos, idx) => {
                      const liquidated = pos.newHF < LIQ_THRESHOLD;
                      const critical = pos.newHF < 1.3 && !liquidated;
                      const shock = shocks[pos.collateralAsset as Asset] ?? 0;
                      const badDebt = liquidated ? Math.max(0, pos.totalDebt - pos.newMargin * 0.95) : 0;
                      return (
                        <tr key={pos.id}
                          className={cn(
                            "border-b border-vgray-100/60 transition-colors",
                            liquidated ? "bg-imperial-50/30" : critical ? "bg-amber-50/20" : "hover:bg-vgray-50/40"
                          )}>
                          <td className="px-3 py-2 text-vgray-400 font-mono">{idx + 1}</td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-vgray-600">{pos.address}</span>
                              <span className="text-[8px] font-bold px-1 py-0.5 rounded-full bg-electric-50 text-electric-700">STELLAR</span>
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center justify-center gap-1">
                              <CoinIcon symbol={pos.collateralAsset} size={14} />
                              <span className="font-semibold text-vgray-600">{pos.collateralAsset}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-center font-mono font-bold"
                            style={{ color: shock < -30 ? "#FC5457" : shock < 0 ? "#F59E0B" : "#32EEE2" }}>
                            {shock > 0 ? "+" : ""}{shock}%
                          </td>
                          <td className="px-3 py-2 text-center font-mono text-violet-600">{pos.healthFactor.toFixed(2)}</td>
                          <td className="px-3 py-2 text-center font-mono font-bold"
                            style={{ color: pos.newHF < LIQ_THRESHOLD ? "#FC5457" : pos.newHF < 1.3 ? "#F59E0B" : "#32EEE2" }}>
                            {pos.newHF.toFixed(2)}
                          </td>
                          <td className="px-3 py-2 text-center">
                            <span className="font-mono font-bold text-[10px] px-1.5 py-0.5 rounded"
                              style={{ background: pos.leverage >= 7 ? "#FC545718" : "#9F7BEE18", color: pos.leverage >= 7 ? "#FC5457" : "#9F7BEE" }}>
                              {pos.leverage}×
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-vgray-600">{formatUsd(pos.totalDebt)}</td>
                          <td className="px-3 py-2 text-right font-mono">
                            {badDebt > 0
                              ? <span className="text-imperial-600 font-bold">{formatUsd(badDebt)}</span>
                              : <span className="text-vgray-300">—</span>}
                          </td>
                          <td className="px-3 py-2 text-center">
                            {liquidated
                              ? <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-imperial-100 text-imperial-700 border border-imperial-300">LIQUIDATED</span>
                              : critical
                                ? <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-300">CRITICAL</span>
                                : <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-electric-50 text-electric-700 border border-electric-200">SAFE</span>}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>

            {/* Summary row */}
            <div className="mt-3 pt-3 border-t border-vgray-100 grid grid-cols-3 gap-3">
              {[
                { label: "Total liquidated", value: `${sim.breaching.length} positions`, color: "#FC5457" },
                { label: "Total bad debt", value: formatUsd(sim.netBadDebt), color: sim.netBadDebt > 0 ? "#FC5457" : "#32EEE2" },
                { label: "Insurance fund left", value: formatUsd(sim.fundRemaining), color: sim.fundRemaining > 0 ? "#32EEE2" : "#FC5457" },
              ].map(s => (
                <div key={s.label} className="text-center p-2 rounded-r2 bg-vgray-50/60 border border-vgray-100">
                  <p className="text-[8px] uppercase tracking-wide text-vgray-400 mb-1">{s.label}</p>
                  <p className="text-[11px] font-bold font-mono" style={{ color: s.color }}>{s.value}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
