"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/analytics/PageHeader";
import { formatUsd, formatNumber, cn } from "@/lib/analytics/utils";
import { useChartColors } from "@/lib/analytics/theme";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, RadialBarChart, RadialBar, Legend } from "recharts";

const INSURANCE_FUND = 5_400_000;
const LIQ_THRESHOLD = 1.1;
const dr = (s: number) => { const x = Math.sin(s * 9301 + 49297) * 233280; return x - Math.floor(x); };

type Preset = "crypto_winter" | "defi_contagion" | "perfect_storm" | "custom";

// Stellar-native black-swan dimensions:
//   • xlmDrop      → XLM spot price drop (only volatile asset)
//   • secondaryDrop → secondary stress on USDC pool collateral (e.g.
//     concurrent issuer stress on Aquarius/Soroswap)
//   • stablecoinDepeg → Circle USDC peg break magnitude (%)
//   • oracleFailure   → Reflector returns stale/wrong prices
//   • protocolExploit → catastrophic event in Blend/Aquarius/Soroswap
//   • aprSpike        → rate model spike (debt compounds)
//   • lpILMultiplier  → LP IL amplifier (Aquarius/Soroswap pools)
//   • cascadeRounds   → liquidation cascade re-rounds
interface ShockConfig {
  xlmDrop: number;
  secondaryDrop: number;
  stablecoinDepeg: number;
  oracleFailure: boolean;
  protocolExploit: boolean;
  aprSpike: number;
  lpILMultiplier: number;
  cascadeRounds: number;
}

const PRESETS: { id: Preset; label: string; desc: string; color: string; config: ShockConfig }[] = [
  {
    id: "crypto_winter",
    label: "Stellar Crypto Winter",
    desc: "Multi-month bear: XLM -75%, USDC reserves wobble -3%, no protocol failures.",
    color: "#9F7BEE",
    config: { xlmDrop: 75, secondaryDrop: 5, stablecoinDepeg: 3, oracleFailure: false, protocolExploit: false, aprSpike: 40, lpILMultiplier: 1.5, cascadeRounds: 3 }
  },
  {
    id: "defi_contagion",
    label: "DeFi Contagion (Stellar)",
    desc: "USDC issuer stress hits all 3 USDC variants simultaneously while one external pool gets exploited.",
    color: "#FC5457",
    config: { xlmDrop: 35, secondaryDrop: 20, stablecoinDepeg: 60, oracleFailure: true, protocolExploit: true, aprSpike: 120, lpILMultiplier: 2.5, cascadeRounds: 5 }
  },
  {
    id: "perfect_storm",
    label: "Perfect Storm",
    desc: "Simultaneous XLM crash, Reflector oracle outage, Blend exploit, USDC depeg, rate spike.",
    color: "#FF007A",
    config: { xlmDrop: 55, secondaryDrop: 25, stablecoinDepeg: 20, oracleFailure: true, protocolExploit: true, aprSpike: 80, lpILMultiplier: 3.0, cascadeRounds: 5 }
  },
  {
    id: "custom",
    label: "Custom Shock",
    desc: "Build your own scenario — full control over all parameters.",
    color: "#32EEE2",
    config: { xlmDrop: 30, secondaryDrop: 10, stablecoinDepeg: 10, oracleFailure: false, protocolExploit: false, aprSpike: 25, lpILMultiplier: 1.2, cascadeRounds: 2 }
  },
];

const ALL_POSITIONS = Array.from({ length: 32 }, (_, i) => {
  const debt = Math.floor(60_000 + dr(i * 7) * 1_500_000 / 1000) * 1000;
  const hf = 1.13 + dr(i * 11) * 1.8;
  const marginValue = Math.floor(debt * hf);
  const leverage = Math.min(10, Math.max(1, Math.round(1.5 + dr(i * 13) * 8.5)));
  const trackTokens = Math.floor(marginValue * (leverage >= 7 ? 0.35 + dr(i * 3) * 0.3 : 0.08 + dr(i * 3) * 0.2));
  const cash = Math.floor(marginValue * (0.08 + dr(i * 5) * 0.18));
  const aTokens = Math.floor(marginValue * dr(i * 7) * 0.38);
  const lpTokens = Math.max(0, marginValue - trackTokens - cash - aTokens);
  const stablePct = 0.1 + dr(i * 17) * 0.3; // fraction of cash+aTokens that is stablecoin
  return { id: i, debt, hf: Math.round(hf * 100) / 100, leverage, marginValue, trackTokens, cash, aTokens, lpTokens, stablePct };
});

function runBlackSwan(config: ShockConfig) {
  const {
    xlmDrop, secondaryDrop, stablecoinDepeg, oracleFailure, protocolExploit,
    aprSpike, lpILMultiplier, cascadeRounds
  } = config;

  let totalShocks: string[] = [];
  let cumulativeLiquidated = 0;
  let totalBadDebt = 0;

  const results = ALL_POSITIONS.map((pos, i) => {
    // Asset shock: XLM-heavy positions take the full xlmDrop; positions
    // skewed toward USDC variants take the lighter `secondaryDrop`.
    const assetShock = i % 2 === 0 ? -xlmDrop / 100 : -secondaryDrop / 100;
    const perpMultiplier = pos.leverage >= 7 ? pos.leverage * 0.8 : 1;
    const trackShock = assetShock * perpMultiplier;

    let newTrack = Math.max(0, pos.trackTokens * (1 + trackShock));
    let newCash = pos.cash * (1 + assetShock * 0.1); // cash partially exposed (stablecoin depeg)
    let newATokens = pos.aTokens * (1 + assetShock * 0.3);
    let newLp = pos.lpTokens * (1 + assetShock * 0.5 * lpILMultiplier);

    // 2. Stablecoin depeg — cash + some aTokens
    const stableShock = stablecoinDepeg / 100;
    newCash = newCash * (1 - stableShock * pos.stablePct);
    newATokens = newATokens * (1 - stableShock * 0.4);

    // 3. Protocol exploit — track tokens or aTokens
    if (protocolExploit && pos.leverage >= 6) {
      newTrack = newTrack * 0.4; // 60% loss on track tokens from exploited perp
    }

    // 4. Oracle failure — additional 10% uncertainty buffer
    if (oracleFailure) {
      newTrack = newTrack * 0.9;
      newLp = newLp * 0.9;
    }

    // 5. Rate spike — debt compounds
    const extraDebt = pos.debt * (aprSpike / 100) * (30 / 365);
    const newDebt = pos.debt + extraDebt;

    const newMargin = Math.max(0, newCash + newATokens + newLp + newTrack);
    const newHF = Math.round((newMargin / newDebt) * 100) / 100;
    const liquidated = newHF < LIQ_THRESHOLD;
    const grossRecovery = liquidated ? newMargin * 0.93 : 0;
    const badDebt = liquidated ? Math.max(0, newDebt - grossRecovery) : 0;

    return { ...pos, newMargin, newDebt, newHF, liquidated, badDebt };
  });

  const liquidated = results.filter(p => p.liquidated);
  totalBadDebt = liquidated.reduce((a, p) => a + p.badDebt, 0);
  cumulativeLiquidated = liquidated.length;

  // Cascade rounds
  let remainingPositions = results.filter(p => !p.liquidated);
  const cascadeLog: { round: number; liquidated: number; badDebt: number }[] = [
    { round: 0, liquidated: cumulativeLiquidated, badDebt: Math.round(totalBadDebt / 1000) }
  ];

  for (let r = 1; r <= cascadeRounds; r++) {
    const cascadeShock = (cumulativeLiquidated * 50_000 / 1_000_000) * 0.004; // 40bps per $1M sold
    const newPositions = remainingPositions.map(pos => {
      const newMargin = pos.newMargin * (1 - cascadeShock);
      const newHF = Math.round((newMargin / pos.newDebt) * 100) / 100;
      const liquidated = newHF < LIQ_THRESHOLD;
      const grossRecovery = liquidated ? newMargin * 0.93 : 0;
      const badDebt = liquidated ? Math.max(0, pos.newDebt - grossRecovery) : 0;
      return { ...pos, newMargin, newHF, liquidated, badDebt };
    });
    const newLiquidated = newPositions.filter(p => p.liquidated);
    if (newLiquidated.length === 0) break;
    const roundBD = newLiquidated.reduce((a, p) => a + p.badDebt, 0);
    totalBadDebt += roundBD;
    cumulativeLiquidated += newLiquidated.length;
    cascadeLog.push({ round: r, liquidated: newLiquidated.length, badDebt: Math.round(roundBD / 1000) });
    remainingPositions = newPositions.filter(p => !p.liquidated);
  }

  const coverage = totalBadDebt > 0 ? Math.min(999, (INSURANCE_FUND / totalBadDebt) * 100) : 999;
  return { results, liquidated: cumulativeLiquidated, totalBadDebt, coverage, cascadeLog, surviving: remainingPositions.length, fundRemaining: Math.max(0, INSURANCE_FUND - totalBadDebt) };
}

export default function BlackSwanPage() {
  const cc = useChartColors();
  const [preset, setPreset] = useState<Preset>("perfect_storm");
  const [config, setConfig] = useState<ShockConfig>(PRESETS[2].config);
  const [hasRun, setHasRun] = useState(false);

  const handlePresetSelect = (p: typeof PRESETS[0]) => {
    setPreset(p.id);
    setConfig({ ...p.config });
  };

  const sim = useMemo(() => runBlackSwan(config), [config]);

  // Risk component breakdown
  const riskComponents = [
    { name: "Price Shock", severity: Math.min(100, config.xlmDrop), color: "#FC5457" },
    { name: "Stable Depeg", severity: Math.min(100, config.stablecoinDepeg * 1.2), color: "#FF007A" },
    { name: "Rate Spike", severity: Math.min(100, config.aprSpike * 0.7), color: "#F59E0B" },
    { name: "LP IL", severity: Math.min(100, (config.lpILMultiplier - 1) * 40), color: "#9F7BEE" },
    { name: "Oracle Risk", severity: config.oracleFailure ? 80 : 5, color: "#32EEE2" },
    { name: "Exploit Risk", severity: config.protocolExploit ? 90 : 5, color: "#FF6B35" },
  ];

  const selectedPreset = PRESETS.find(p => p.id === preset)!;

  return (
    <div className="p-6 w-full max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/analytics/overview2" className="flex items-center gap-1.5 text-[11px] text-vgray-400 hover:text-violet-600 transition-colors">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          Risk Command Center
        </Link>
        <span className="text-vgray-200">/</span>
        <span className="text-[11px] text-vgray-600 font-semibold">Black Swan Multi-Shock</span>
      </div>
      <PageHeader title="Black Swan Multi-Shock" subtitle="Combine all Stellar risk vectors at once: XLM crash, Circle USDC depeg, Reflector oracle failure, Blend/Aquarius/Soroswap exploit, rate spike, and cascading liquidations against the Risk Engine HF≥1.1 threshold." />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Controls */}
        <div className="space-y-4">
          {/* Presets */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-5 space-y-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500">Scenario Presets</p>
            <div className="space-y-2">
              {PRESETS.map(p => (
                <button key={p.id} onClick={() => handlePresetSelect(p)}
                  className={cn("w-full flex items-start gap-2.5 p-2.5 rounded-r2 border text-left transition-all",
                    preset === p.id ? "border-violet-300 bg-violet-50" : "border-vgray-100 hover:border-vgray-200"
                  )}>
                  <div className="w-2 h-2 rounded-full flex-shrink-0 mt-1" style={{ backgroundColor: p.color }} />
                  <div>
                    <p className={cn("text-[10px] font-bold", preset === p.id ? "text-violet-700" : "text-vgray-600")}>{p.label}</p>
                    <p className="text-[8px] text-vgray-400">{p.desc}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Custom controls */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-5 space-y-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500">Shock Parameters</p>

            {[
              { label: "XLM Price Drop", key: "xlmDrop" as keyof ShockConfig, min: 0, max: 95, unit: "%" },
              { label: "Secondary Asset Drop", key: "secondaryDrop" as keyof ShockConfig, min: 0, max: 95, unit: "%" },
              { label: "USDC-Variant Depeg", key: "stablecoinDepeg" as keyof ShockConfig, min: 0, max: 100, unit: "%" },
              { label: "Borrow APR Spike", key: "aprSpike" as keyof ShockConfig, min: 0, max: 200, unit: "%" },
              { label: "LP IL Multiplier (Aquarius/Soroswap)", key: "lpILMultiplier" as keyof ShockConfig, min: 1, max: 5, unit: "×", step: 0.1 },
              { label: "Cascade Rounds", key: "cascadeRounds" as keyof ShockConfig, min: 0, max: 5, unit: " rounds" },
            ].map(ctrl => (
              <div key={ctrl.key} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-[9px] font-semibold uppercase tracking-wide text-vgray-400">{ctrl.label}</label>
                  <span className="text-[9px] font-bold font-mono text-violet-600">{typeof config[ctrl.key] === 'number' ? (config[ctrl.key] as number).toFixed(ctrl.key === 'lpILMultiplier' ? 1 : 0) : config[ctrl.key]}{ctrl.unit}</span>
                </div>
                <input type="range" min={ctrl.min} max={ctrl.max} step={ctrl.step ?? 1}
                  value={config[ctrl.key] as number}
                  onChange={e => { setPreset("custom"); setConfig(prev => ({ ...prev, [ctrl.key]: Number(e.target.value) })); }}
                  className="w-full h-1.5 appearance-none rounded-full bg-vgray-100 accent-violet-500 cursor-pointer"
                />
              </div>
            ))}

            <div className="flex gap-3">
              {[
              { label: "Reflector Failure", key: "oracleFailure" as keyof ShockConfig },
              { label: "External Protocol Exploit", key: "protocolExploit" as keyof ShockConfig },
              ].map(toggle => (
                <button key={toggle.key}
                  onClick={() => { setPreset("custom"); setConfig(prev => ({ ...prev, [toggle.key]: !prev[toggle.key] })); }}
                  className={cn("flex-1 py-2 rounded-r2 border text-[9px] font-bold transition-all",
                    config[toggle.key] ? "bg-imperial-50 border-imperial-300 text-imperial-600" : "border-vgray-100 text-vgray-400"
                  )}>
                  {toggle.label}
                </button>
              ))}
            </div>

            <button onClick={() => setHasRun(true)}
              className="w-full py-3 rounded-r3 bg-gradient-to-r from-imperial-500 to-violet-500 text-white text-[11px] font-bold uppercase tracking-wide hover:opacity-90 transition-opacity shadow-vanna">
              Run Black Swan
            </button>
          </div>
        </div>

        {/* Results */}
        <div className="lg:col-span-2 space-y-4">
          {/* Core Metrics */}
          <div className={cn("bg-surface rounded-r4 border shadow-vanna p-5", hasRun ? "border-imperial-300" : "border-vgray-100")}>
            <div className="flex items-center gap-2 mb-4">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: selectedPreset.color }} />
              <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500">{selectedPreset.label} — Full Multi-Shock Results</p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: "Total Positions Liquidated", value: String(sim.liquidated), sub: `${sim.surviving} positions survive`, color: sim.liquidated > 0 ? "#FC5457" : "#32EEE2" },
                { label: "Cascade Rounds", value: String(sim.cascadeLog.length), sub: `${config.cascadeRounds} max rounds set`, color: "#9F7BEE" },
                { label: "Net Bad Debt", value: formatUsd(sim.totalBadDebt), sub: "After all liquidations", color: sim.totalBadDebt > 0 ? "#FC5457" : "#32EEE2" },
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

          {/* Risk component severity */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">Shock Vector Severity</p>
            <p className="text-[9px] text-vgray-400 mb-3">Combined severity of all active risk factors in this scenario</p>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={riskComponents} layout="vertical" barSize={14}>
                <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} tickFormatter={v => `${v}%`} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} width={70} />
                <Tooltip contentStyle={cc.tooltip} formatter={(v) => [`${v}%`, "Severity"]} />
                <Bar dataKey="severity" radius={[0, 3, 3, 0]}>
                  {riskComponents.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Cascade log */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">Cascade Progression</p>
            <p className="text-[9px] text-vgray-400 mb-3">Initial wave + cascade rounds — each round's selloff drives further price impact</p>
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={sim.cascadeLog} barSize={36}>
                <XAxis dataKey="round" tickFormatter={r => r === 0 ? "Initial" : `Cascade ${r}`} tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={cc.tooltip} formatter={(v, name) => [name === "liquidated" ? `${v} positions` : `$${v}K bad debt`, name]} />
                <Bar dataKey="liquidated" name="liquidated" radius={[4, 4, 0, 0]}>
                  {sim.cascadeLog.map((r, i) => <Cell key={i} fill={i === 0 ? "#FC5457" : i === 1 ? "#FF007A" : "#F59E0B"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Preset comparison */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">Preset Comparison</p>
            <p className="text-[9px] text-vgray-400 mb-3">Liquidations and bad debt across all historical scenario presets</p>
            <ResponsiveContainer width="100%" height={140}>
              <BarChart
                data={PRESETS.slice(0, 3).map(p => {
                  const r = runBlackSwan(p.config);
                  return { scenario: p.label, liquidations: r.liquidated, badDebt: Math.round(r.totalBadDebt / 1000), color: p.color };
                })}
                barSize={40}
              >
                <XAxis dataKey="scenario" tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={cc.tooltip} formatter={(v, name) => [name === "liquidations" ? `${v} positions` : `$${v}K bad debt`, name]} />
                <Bar dataKey="liquidations" name="liquidations" radius={[4, 4, 0, 0]}>
                  {PRESETS.slice(0, 3).map((p, i) => <Cell key={i} fill={p.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Insurance fund waterfall */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4 space-y-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500">Insurance Fund Waterfall</p>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-vgray-500">Insurance Fund</span>
                <span className="font-mono font-bold text-violet-600">{formatUsd(INSURANCE_FUND)}</span>
              </div>
              <div className="w-full bg-vgray-100 rounded-full h-3 overflow-hidden">
                <div className="h-full rounded-full flex">
                  <div className="h-full bg-electric-500 transition-all duration-500"
                    style={{ width: `${Math.min(100, (sim.fundRemaining / INSURANCE_FUND) * 100)}%` }} />
                  <div className="h-full bg-imperial-500 transition-all duration-500"
                    style={{ width: `${Math.min(100, (Math.min(INSURANCE_FUND, sim.totalBadDebt) / INSURANCE_FUND) * 100)}%` }} />
                </div>
              </div>
              <div className="flex justify-between text-[9px]">
                <span className="text-electric-600">Remaining: {formatUsd(sim.fundRemaining)}</span>
                <span className="text-imperial-600">Used: {formatUsd(Math.min(INSURANCE_FUND, sim.totalBadDebt))}</span>
              </div>
              {sim.totalBadDebt > INSURANCE_FUND && (
                <div className="p-2 bg-imperial-50/40 rounded-r2 border border-imperial-200 text-[9px] text-imperial-600 font-semibold">
                  ⚠ Bad debt exceeds insurance fund by {formatUsd(sim.totalBadDebt - INSURANCE_FUND)} — protocol requires socialized loss or emergency recapitalization
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
