"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/analytics/PageHeader";
import { formatUsd, formatNumber, cn, hfColor } from "@/lib/analytics/utils";
import { useChartColors } from "@/lib/analytics/theme";
import { ACTIVE_ASSETS, syntheticGAccount, shortStellar } from "@/lib/analytics/stellar/canon";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LineChart, Line } from "recharts";

const INSURANCE_FUND = 5_400_000;
const LIQ_THRESHOLD = 1.1;
const dr = (s: number) => { const x = Math.sin(s * 9301 + 49297) * 233280; return x - Math.floor(x); };

// On Stellar there are no permissionless perp venues integrated by Vanna.
// What composes here is borrowed funds deployed into external Soroban
// protocols (Blend / Aquarius / Soroswap) that already deliver effective
// leverage via LP rebalancing or pool insolvency. We model the same
// "amplified loss" mechanic but route it through Stellar primitives.
const PROTOCOLS = ["Blend pool", "Aquarius LP", "Soroswap LP", "All external pools"] as const;
type Protocol = typeof PROTOCOLS[number];

// Generate positions that have significant track token exposure (perp positions)
const PERP_POSITIONS = Array.from({ length: 24 }, (_, i) => {
  const vannaLev = Math.min(10, Math.max(5, Math.round(5 + dr(i * 7) * 5)));
  const extLev = Math.min(10, Math.max(1, Math.round(1 + dr(i * 11) * 9)));
  const effectiveLev = vannaLev * extLev;
  const debt = Math.floor(80_000 + dr(i * 5) * 1_200_000 / 1000) * 1000;
  const ownCollateral = Math.floor(debt / vannaLev);
  const marginValue = ownCollateral + debt;
  const hf = marginValue / debt;
  const trackTokens = Math.floor(marginValue * (0.45 + dr(i * 3) * 0.35));
  const cash = Math.floor(ownCollateral * 0.8);
  const aTokens = Math.floor((marginValue - trackTokens - cash) * 0.6);
  const lpTokens = marginValue - trackTokens - cash - aTokens;
  const directions = ["long", "short"] as const;
  const protoIdx = Math.floor(dr(i * 13) * 3);
  return {
    id: i,
    address: shortStellar(syntheticGAccount(i + 67)),
    chain: "stellar" as const,
    healthFactor: Math.round(hf * 100) / 100,
    totalDebt: debt,
    marginValue,
    ownCollateral,
    vannaLeverage: vannaLev,
    externalLeverage: extLev,
    effectiveLeverage: effectiveLev,
    protocol: PROTOCOLS[protoIdx],
    underlyingAsset: ACTIVE_ASSETS[Math.floor(dr(i * 17) * ACTIVE_ASSETS.length)],
    direction: directions[i % 2],
    breakdown: { trackTokens, cash, aTokens, lpTokens: Math.max(0, lpTokens) },
  };
});

export default function LeveragedPerpShockPage() {
  const cc = useChartColors();
  const [assetShock, setAssetShock] = useState(-15);
  const [extLev, setExtLev] = useState(5);
  const [protocol, setProtocol] = useState<Protocol>("All external pools");
  const [assumeExtLiq, setAssumeExtLiq] = useState(true);
  const [hasRun, setHasRun] = useState(false);

  const filteredPos = useMemo(() =>
    PERP_POSITIONS.filter(p => protocol === "All external pools" || p.protocol === protocol),
    [protocol]
  );

  const sim = useMemo(() => {
    const shock = assetShock / 100;
    const results = filteredPos.map(pos => {
      const perpPnL = shock * extLev;
      let newTrackToken: number;
      if (assumeExtLiq && (pos.breakdown.trackTokens * (1 + perpPnL)) <= 0) {
        newTrackToken = 0; // External protocol liquidated, track token → $0
      } else {
        newTrackToken = Math.max(0, pos.breakdown.trackTokens * (1 + perpPnL));
      }
      const newCash = pos.breakdown.cash * (1 + shock);
      const newAToken = pos.breakdown.aTokens * (1 + shock * 0.2);
      const newLP = pos.breakdown.lpTokens * (1 + shock * 0.4);
      const newMargin = newCash + newAToken + newLP + newTrackToken;
      const newHF = Math.round((newMargin / pos.totalDebt) * 100) / 100;
      const externallyLiquidated = assumeExtLiq && newTrackToken === 0;
      return { ...pos, newHF, newMargin, newTrackToken, externallyLiquidated };
    });
    const breaching = results.filter(p => p.newHF < LIQ_THRESHOLD);
    const doubleLiq = results.filter(p => p.externallyLiquidated && p.newHF < LIQ_THRESHOLD);
    const debtAtRisk = breaching.reduce((a, p) => a + p.totalDebt, 0);
    const grossRecovery = breaching.reduce((a, p) => a + p.newMargin * 0.92, 0);
    const netBadDebt = Math.max(0, debtAtRisk - grossRecovery);
    const coverage = netBadDebt > 0 ? Math.min(999, (INSURANCE_FUND / netBadDebt) * 100) : 999;
    return { results, breaching, doubleLiq, debtAtRisk, grossRecovery, netBadDebt, coverage, fundRemaining: Math.max(0, INSURANCE_FUND - netBadDebt) };
  }, [filteredPos, assetShock, extLev, assumeExtLiq]);

  // Leverage amplification funnel data
  const funnelData = [
    { stage: "Asset Move", value: Math.abs(assetShock), color: "#703AE6" },
    { stage: `Pool PnL (${extLev}x)`, value: Math.abs(assetShock) * extLev, color: "#F59E0B" },
    { stage: "Track Token Loss", value: Math.min(100, Math.abs(assetShock) * extLev), color: "#FF007A" },
    { stage: "Portfolio HF Drop", value: Math.min(100, Math.abs(assetShock) * extLev * 0.8), color: "#FC5457" },
  ];

  // HF sensitivity by price move
  const sensitivityData = [-5, -10, -15, -20, -25, -30, -40, -50].map(shock => {
    const perpPnL = (shock / 100) * extLev;
    const atRisk = filteredPos.filter(pos => {
      const newTrack = Math.max(0, pos.breakdown.trackTokens * (1 + perpPnL));
      const newMargin = pos.breakdown.cash * (1 + shock / 100) + pos.breakdown.aTokens * 0.9 + pos.breakdown.lpTokens * 0.8 + newTrack;
      return (newMargin / pos.totalDebt) < LIQ_THRESHOLD;
    }).length;
    return { shock: `${shock}%`, positions: atRisk };
  });

  return (
    <div className="p-6 w-full max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/analytics/overview2" className="flex items-center gap-1.5 text-[11px] text-vgray-400 hover:text-violet-600 transition-colors">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          Risk Command Center
        </Link>
        <span className="text-vgray-200">/</span>
        <span className="text-[11px] text-vgray-600 font-semibold">Leveraged External-Pool Shock</span>
      </div>
      <PageHeader
        title="Leveraged External-Pool Shock"
        subtitle="Composable Stellar leverage: borrowed Vanna credit deployed into Blend / Aquarius / Soroswap. Adverse moves on those pools cascade back through the SmartAccount's tracking-token collateral."
      />

      {/* Explainer Banner */}
      <div className="bg-imperial-50/60 border border-imperial-200 rounded-r3 p-4">
        <p className="text-[11px] text-imperial-700 font-semibold mb-1">Why this simulation matters</p>
        <p className="text-[10px] text-imperial-600 leading-relaxed">
          Users who borrow 9× from Vanna and deploy into Aquarius/Soroswap LPs (or stake b-tokens in Blend) get
          an effective <strong>9× × LP-leverage</strong> exposure to XLM. A sharp XLM move (or pool insolvency) collapses the
          tracking-token side of their SmartAccount collateral; the Risk Engine sees gross collateral fall and HF can
          drop below the 1.1 threshold faster than the underlying spot move would suggest.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Controls */}
        <div className="space-y-4">
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-5 space-y-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500">Simulation Controls</p>

            <div className="space-y-2">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Target Protocol</label>
              <div className="space-y-1">
                {PROTOCOLS.map(p => (
                  <button key={p} onClick={() => setProtocol(p)}
                    className={cn("w-full text-left px-3 py-2 rounded-r2 border text-[10px] font-semibold transition-all",
                      protocol === p ? "bg-violet-50 border-violet-300 text-violet-700" : "border-vgray-100 text-vgray-500 hover:border-vgray-200"
                    )}>{p}</button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Underlying Asset Move</label>
                <span className="font-bold font-mono text-sm text-imperial-600">{assetShock}%</span>
              </div>
              <input type="range" min={-80} max={10} step={5} value={assetShock}
                onChange={e => setAssetShock(Number(e.target.value))}
                className="w-full h-1.5 appearance-none rounded-full bg-vgray-100 accent-imperial-500 cursor-pointer"
              />
              <p className="text-[9px] text-vgray-400">Even -5% can liquidate positions at 9x leverage</p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">External Protocol Leverage</label>
                <span className="font-bold font-mono text-sm text-violet-600">{extLev}x</span>
              </div>
              <input type="range" min={1} max={20} step={1} value={extLev}
                onChange={e => setExtLev(Number(e.target.value))}
                className="w-full h-1.5 appearance-none rounded-full bg-vgray-100 accent-violet-500 cursor-pointer"
              />
              <p className="text-[9px] text-vgray-400">Effective leverage from the external Stellar pool (LP rebalance / pool insolvency factor)</p>
            </div>

            <div className="flex items-center justify-between p-3 bg-vgray-50 rounded-r2 border border-vgray-100">
              <div>
                <p className="text-[10px] font-semibold text-vgray-600">Assume External Pool Wipes First</p>
                <p className="text-[9px] text-vgray-400">Tracking-token collateral → $0 when the Blend/Aquarius/Soroswap position is wiped out</p>
              </div>
              <button onClick={() => setAssumeExtLiq(!assumeExtLiq)}
                className={cn("w-10 h-5 rounded-full transition-colors relative flex-shrink-0", assumeExtLiq ? "bg-imperial-500" : "bg-vgray-200")}>
                <span className={cn("w-4 h-4 bg-white rounded-full shadow absolute top-0.5 transition-transform", assumeExtLiq ? "translate-x-5" : "translate-x-0.5")} />
              </button>
            </div>

            {/* Leverage Amplification Display */}
            <div className="p-3 bg-imperial-50/50 rounded-r2 border border-imperial-200 space-y-1.5">
              <p className="text-[9px] font-bold uppercase tracking-wide text-imperial-600">Combined Leverage Effect</p>
              <div className="text-center">
                <p className="text-2xl font-bold font-mono text-imperial-600">{Math.round(8 * extLev)}x</p>
                <p className="text-[9px] text-imperial-500">Avg Vanna (8x) × External ({extLev}x)</p>
              </div>
              <div className="text-[9px] text-imperial-600 space-y-0.5">
                <p>→ XLM moves {Math.abs(assetShock)}% → external pool position loses {Math.min(100, Math.abs(assetShock) * extLev).toFixed(0)}%</p>
                <p>→ At avg 8× Vanna: {Math.min(100, Math.abs(assetShock) * extLev * 8 / 8).toFixed(0)}% of margin lost</p>
              </div>
            </div>

            <button onClick={() => setHasRun(true)}
              className="w-full py-3 rounded-r3 bg-gradient-to-r from-imperial-500 to-violet-500 text-white text-[11px] font-bold uppercase tracking-wide hover:opacity-90 transition-opacity shadow-vanna">
              Run External-Pool Shock Simulation
            </button>
          </div>
        </div>

        {/* Results */}
        <div className="lg:col-span-2 space-y-4">
          {/* Core Results */}
          <div className={cn("bg-surface rounded-r4 border shadow-vanna p-5", hasRun ? "border-violet-200" : "border-vgray-100")}>
            <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500 mb-4">Simulation Results</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: "Positions Below HF 1.1", value: String(sim.breaching.length), sub: `${formatUsd(sim.debtAtRisk)} debt at risk`, color: sim.breaching.length > 0 ? "#FC5457" : "#32EEE2" },
                { label: "Double Liquidations", value: String(sim.doubleLiq.length), sub: "External pool wipe + Vanna HF<1.1", color: sim.doubleLiq.length > 0 ? "#FF007A" : "#949494" },
                { label: "Estimated Bad Debt", value: formatUsd(sim.netBadDebt), sub: `${formatUsd(sim.grossRecovery)} recovery`, color: sim.netBadDebt > 0 ? "#FF007A" : "#32EEE2" },
                { label: "Insurance Coverage", value: sim.netBadDebt > 0 ? `${Math.min(999, sim.coverage).toFixed(0)}%` : "Full", sub: `${formatUsd(sim.fundRemaining)} remaining`, color: sim.coverage >= 100 ? "#32EEE2" : "#FC5457" },
              ].map(r => (
                <div key={r.label} className="p-3 rounded-r3 bg-vgray-50/60 border border-vgray-100 space-y-1">
                  <p className="text-[9px] font-semibold uppercase tracking-wide text-vgray-400">{r.label}</p>
                  <p className="text-xl font-bold font-mono" style={{ color: r.color }}>{r.value}</p>
                  <p className="text-[9px] text-vgray-400">{r.sub}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">Leverage Amplification Funnel</p>
              <p className="text-[9px] text-vgray-400 mb-3">How a {assetShock}% move amplifies through layers</p>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={funnelData} layout="vertical" barSize={20}>
                  <XAxis type="number" tick={{ fontSize: 8, fill: cc.axisText }} axisLine={false} tickLine={false} tickFormatter={v => `${v}%`} />
                  <YAxis type="category" dataKey="stage" tick={{ fontSize: 8, fill: cc.axisText }} axisLine={false} tickLine={false} width={100} />
                  <Tooltip contentStyle={cc.tooltip} formatter={v => [`${v}%`, ""]} />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                    {funnelData.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">Positions at Risk vs Price Move</p>
              <p className="text-[9px] text-vgray-400 mb-3">How many positions breach HF 1.1 at each price drop</p>
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={sensitivityData}>
                  <XAxis dataKey="shock" tick={{ fontSize: 8, fill: cc.axisText }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 8, fill: cc.axisText }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={cc.tooltip} />
                  <Line type="monotone" dataKey="positions" stroke="#FC5457" strokeWidth={2} dot={{ fill: "#FC5457", r: 3 }} name="Positions at Risk" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Position Impact Table */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna overflow-hidden">
            <div className="px-5 py-3 border-b border-vgray-100">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500">External-Pool Position Impact — Sorted by Effective Leverage</p>
            </div>
            <div className="overflow-x-auto scrollbar-thin max-h-64">
              <table className="w-full text-[10px] min-w-[700px]">
                <thead className="sticky top-0 bg-vgray-50/90">
                  <tr className="border-b border-vgray-100 text-vgray-400">
                    <th className="px-3 py-2 text-left font-semibold">Wallet</th>
                    <th className="px-3 py-2 text-left font-semibold">Protocol</th>
                    <th className="px-3 py-2 text-center font-semibold">Vanna Lev.</th>
                    <th className="px-3 py-2 text-center font-semibold">Ext. Lev.</th>
                    <th className="px-3 py-2 text-center font-semibold">Effective</th>
                    <th className="px-3 py-2 text-center font-semibold">Before HF</th>
                    <th className="px-3 py-2 text-center font-semibold">After HF</th>
                    <th className="px-3 py-2 text-center font-semibold">Double Liq?</th>
                  </tr>
                </thead>
                <tbody>
                  {sim.results
                    .sort((a, b) => b.effectiveLeverage - a.effectiveLeverage)
                    .slice(0, 15)
                    .map(pos => (
                      <tr key={pos.id} className={cn("border-b border-vgray-100/60", pos.newHF < LIQ_THRESHOLD ? "bg-imperial-50/30" : "")}>
                        <td className="px-3 py-2 font-mono text-vgray-600">{pos.address}</td>
                        <td className="px-3 py-2 text-vgray-600">{pos.protocol}</td>
                        <td className="px-3 py-2 text-center font-mono font-semibold text-violet-600">{pos.vannaLeverage}x</td>
                        <td className="px-3 py-2 text-center font-mono font-semibold text-amber-600">{pos.externalLeverage}x</td>
                        <td className="px-3 py-2 text-center font-mono font-bold" style={{ color: pos.effectiveLeverage > 20 ? "#FC5457" : pos.effectiveLeverage > 10 ? "#F59E0B" : "#949494" }}>{pos.effectiveLeverage}x</td>
                        <td className="px-3 py-2 text-center font-mono" style={{ color: hfColor(pos.healthFactor) }}>{pos.healthFactor.toFixed(2)}</td>
                        <td className="px-3 py-2 text-center font-mono font-bold" style={{ color: hfColor(pos.newHF) }}>{pos.newHF.toFixed(2)}</td>
                        <td className="px-3 py-2 text-center">
                          {pos.externallyLiquidated ? (
                            <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-imperial-100 text-imperial-700">YES ⚡</span>
                          ) : (
                            <span className="text-[8px] text-vgray-300">—</span>
                          )}
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
