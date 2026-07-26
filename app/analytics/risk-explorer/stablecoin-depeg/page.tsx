"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/analytics/PageHeader";
import { formatUsd, formatNumber, cn } from "@/lib/analytics/utils";
import { useChartColors } from "@/lib/analytics/theme";
import CoinIcon from "@/components/analytics/ui/CoinIcon";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LineChart, Line, ReferenceLine, Legend } from "recharts";

const INSURANCE_FUND = 5_400_000;
const LIQ_THRESHOLD = 1.1;
const dr = (s: number) => { const x = Math.sin(s * 9301 + 49297) * 233280; return x - Math.floor(x); };

// Stellar's USDC universe is three protocol-specific variants (one per
// pool: Blend / Aquarius / Soroswap). They each peg to USD independently
// so a depeg in one doesn't auto-propagate, but a paired depeg models
// systemic contagion (e.g. shared issuer or oracle path).
type Stablecoin = "BLUSDC" | "AQUSDC" | "SOUSDC" | "BLUSDC+AQUSDC";

const STABLECOIN_OPTIONS: { id: Stablecoin; label: string; color: string; desc: string }[] = [
  { id: "BLUSDC",          label: "Blend USDC",      color: "#2775CA", desc: "Blend pool USDC reserve — primary lending pool" },
  { id: "AQUSDC",          label: "Aquarius USDC",   color: "#26A17B", desc: "Aquarius AMM USDC reserve" },
  { id: "SOUSDC",          label: "Soroswap USDC",   color: "#F5AC37", desc: "Soroswap DEX USDC reserve" },
  { id: "BLUSDC+AQUSDC",   label: "Blend + Aquarius", color: "#FC5457", desc: "Dual-pool USDC depeg — systemic contagion" },
];

const RECOVERY_OPTIONS = [
  { id: "none", label: "No Recovery", desc: "Stable stays depegged" },
  { id: "partial", label: "Partial (50%)", desc: "Recovers halfway in 7 days" },
  { id: "full", label: "Full Recovery", desc: "Fully recovers in 14 days" },
];

// Each synthetic position carries exposure to all three Stellar USDC
// variants (held as collateral in different pools) plus XLM-tracking
// collateral (Blend/Aquarius LP positions) and free XLM cash.
const ALL_POSITIONS = Array.from({ length: 32 }, (_, i) => {
  const debt = Math.floor(80_000 + dr(i * 7) * 1_200_000 / 1000) * 1000;
  const hf = 1.15 + dr(i * 11) * 1.6;
  const marginValue = Math.floor(debt * hf);
  const leverage = Math.min(10, Math.max(1, Math.round(1.5 + dr(i * 13) * 8.5)));
  const blusdcPct = 0.1 + dr(i * 3) * 0.35;
  const aqusdcPct = 0.05 + dr(i * 5) * 0.25;
  const sousdcPct = dr(i * 7) * 0.15;
  const trackPct = leverage >= 7 ? 0.3 + dr(i * 9) * 0.25 : 0.05 + dr(i * 9) * 0.2;
  const lpPct = Math.max(0, 1 - blusdcPct - aqusdcPct - sousdcPct - trackPct);
  return {
    id: i,
    debt,
    hf: Math.round(hf * 100) / 100,
    leverage,
    marginValue,
    blusdcValue: Math.floor(marginValue * blusdcPct),
    aqusdcValue: Math.floor(marginValue * aqusdcPct),
    sousdcValue: Math.floor(marginValue * sousdcPct),
    trackValue: Math.floor(marginValue * trackPct),
    lpValue: Math.floor(marginValue * lpPct),
  };
});

function applyDepeg(pos: typeof ALL_POSITIONS[0], stable: Stablecoin, severity: number) {
  const depegFactor = 1 - severity / 100;
  let newBl = pos.blusdcValue;
  let newAq = pos.aqusdcValue;
  let newSo = pos.sousdcValue;
  if (stable === "BLUSDC" || stable === "BLUSDC+AQUSDC") newBl = Math.floor(pos.blusdcValue * depegFactor);
  if (stable === "AQUSDC" || stable === "BLUSDC+AQUSDC") newAq = Math.floor(pos.aqusdcValue * depegFactor);
  if (stable === "SOUSDC") newSo = Math.floor(pos.sousdcValue * depegFactor);
  const newMargin = newBl + newAq + newSo + pos.trackValue + pos.lpValue;
  const newHF = Math.round((newMargin / pos.debt) * 100) / 100;
  // Risk Engine threshold: BALANCE_TO_BORROW_THRESHOLD = 1.1 (risk_engine.rs).
  const liquidated = newHF < LIQ_THRESHOLD;
  const grossRecovery = liquidated ? newMargin * 0.93 : 0;
  const badDebt = liquidated ? Math.max(0, pos.debt - grossRecovery) : 0;
  return { ...pos, newMargin, newHF, liquidated, badDebt, newBl, newAq, newSo };
}

export default function StablecoinDepegPage() {
  const cc = useChartColors();
  const [stablecoin, setStablecoin] = useState<Stablecoin>("BLUSDC");
  const [severity, setSeverity] = useState(10);
  const [recovery, setRecovery] = useState("none");
  const [hasRun, setHasRun] = useState(false);

  const sim = useMemo(() => {
    // Apply recovery: partial = half severity, full = 0
    const effectiveSeverity = recovery === "full" ? 0 : recovery === "partial" ? severity * 0.5 : severity;
    const results = ALL_POSITIONS.map(p => applyDepeg(p, stablecoin, effectiveSeverity));
    const liquidated = results.filter(p => p.liquidated);
    const totalBadDebt = liquidated.reduce((a, p) => a + p.badDebt, 0);
    const coverage = totalBadDebt > 0 ? Math.min(999, (INSURANCE_FUND / totalBadDebt) * 100) : 999;
    const totalExposure = ALL_POSITIONS.reduce((a, p) => {
      let exp = 0;
      if (stablecoin === "BLUSDC" || stablecoin === "BLUSDC+AQUSDC") exp += p.blusdcValue;
      if (stablecoin === "AQUSDC" || stablecoin === "BLUSDC+AQUSDC") exp += p.aqusdcValue;
      if (stablecoin === "SOUSDC") exp += p.sousdcValue;
      return a + exp;
    }, 0);
    return { results, liquidated, totalBadDebt, coverage, totalExposure, fundRemaining: Math.max(0, INSURANCE_FUND - totalBadDebt), effectiveSeverity };
  }, [stablecoin, severity, recovery]);

  // Severity sweep
  const severityData = [2, 5, 10, 15, 20, 30, 50].map(sev => {
    const res = ALL_POSITIONS.map(p => applyDepeg(p, stablecoin, sev));
    const liq = res.filter(p => p.liquidated);
    const bd = liq.reduce((a, p) => a + p.badDebt, 0);
    return { severity: `${sev}%`, positions: liq.length, badDebt: Math.round(bd / 1000) };
  });

  // HF distribution before / after
  const hfBuckets = ["<1.1", "1.1-1.3", "1.3-1.5", "1.5-1.8", ">1.8"];
  const hfDist = hfBuckets.map((b, idx) => {
    const thresh = [1.1, 1.3, 1.5, 1.8, Infinity];
    const low = [0, 1.1, 1.3, 1.5, 1.8][idx];
    const high = thresh[idx];
    return {
      bucket: b,
      before: ALL_POSITIONS.filter(p => p.hf >= low && p.hf < high).length,
      after: sim.results.filter(p => p.newHF >= low && p.newHF < high).length,
    };
  });

  const selectedStable = STABLECOIN_OPTIONS.find(s => s.id === stablecoin)!;

  return (
    <div className="p-6 w-full max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/analytics/overview2" className="flex items-center gap-1.5 text-[11px] text-vgray-400 hover:text-violet-600 transition-colors">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          Risk Command Center
        </Link>
        <span className="text-vgray-200">/</span>
        <span className="text-[11px] text-vgray-600 font-semibold">Stablecoin Depeg Scenario</span>
      </div>
      <PageHeader title="Stablecoin Depeg Scenario" subtitle="Model Blend / Aquarius / Soroswap USDC losing its peg — protocol-specific stable variants reprice and breach Risk Engine HF≥1.1" />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Controls */}
        <div className="space-y-4">
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-5 space-y-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500">Depeg Controls</p>

            {/* Stablecoin selector */}
            <div className="space-y-2">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Select Stablecoin</label>
              <div className="space-y-1.5">
                {STABLECOIN_OPTIONS.map(s => (
                  <button key={s.id} onClick={() => setStablecoin(s.id)}
                    className={cn("w-full flex items-center gap-2.5 p-2.5 rounded-r2 border text-left transition-all",
                      stablecoin === s.id ? "border-violet-300 bg-violet-50" : "border-vgray-100 hover:border-vgray-200"
                    )}>
                    <CoinIcon symbol={s.id === "BLUSDC+AQUSDC" ? "BLUSDC" : s.id} size={18} />
                    <div>
                      <p className={cn("text-[10px] font-bold", stablecoin === s.id ? "text-violet-700" : "text-vgray-600")}>{s.label}</p>
                      <p className="text-[8px] text-vgray-400">{s.desc}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Severity */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Depeg Severity</label>
                <span className="font-bold font-mono text-sm text-imperial-600">-{severity}%</span>
              </div>
              <input type="range" min={1} max={60} step={1} value={severity}
                onChange={e => setSeverity(Number(e.target.value))}
                className="w-full h-1.5 appearance-none rounded-full bg-vgray-100 accent-imperial-500 cursor-pointer"
              />
              <div className="flex justify-between text-[9px] text-vgray-300"><span>-1%</span><span>-30%</span><span>-60%</span></div>
              <p className="text-[9px] text-vgray-400">Drop from $1.00 peg (real-world references: USDC 2023: -12%, UST 2022: -99%)</p>
            </div>

            {/* Recovery */}
            <div className="space-y-2">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Recovery Scenario</label>
              <div className="space-y-1.5">
                {RECOVERY_OPTIONS.map(r => (
                  <button key={r.id} onClick={() => setRecovery(r.id)}
                    className={cn("w-full flex items-center justify-between p-2 rounded-r2 border text-left transition-all",
                      recovery === r.id ? "border-violet-300 bg-violet-50" : "border-vgray-100 hover:border-vgray-200"
                    )}>
                    <span className={cn("text-[10px] font-bold", recovery === r.id ? "text-violet-700" : "text-vgray-500")}>{r.label}</span>
                    <span className="text-[9px] text-vgray-400">{r.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="p-3 bg-vgray-50 rounded-r2 border border-vgray-100 space-y-1.5">
              <p className="text-[9px] font-bold uppercase tracking-wide text-vgray-400">Protocol Exposure</p>
              <div className="flex justify-between">
                <span className="text-[9px] text-vgray-400">Total {selectedStable.label} in margins</span>
                <span className="text-[9px] font-mono font-semibold text-vgray-700">{formatUsd(sim.totalExposure)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[9px] text-vgray-400">Effective depeg loss</span>
                <span className="text-[9px] font-mono font-semibold text-imperial-600">{formatUsd(sim.totalExposure * sim.effectiveSeverity / 100)}</span>
              </div>
            </div>

            <button onClick={() => setHasRun(true)}
              className="w-full py-3 rounded-r3 bg-gradient-to-r from-imperial-500 to-violet-500 text-white text-[11px] font-bold uppercase tracking-wide hover:opacity-90 transition-opacity shadow-vanna">
              Run Depeg Simulation
            </button>
          </div>
        </div>

        {/* Results */}
        <div className="lg:col-span-2 space-y-4">
          {/* Core Metrics */}
          <div className={cn("bg-surface rounded-r4 border shadow-vanna p-5", hasRun ? "border-violet-200" : "border-vgray-100")}>
            <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500 mb-4">Depeg Impact — {selectedStable.label} -{severity}%</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: "Positions Below HF 1.1", value: String(sim.liquidated.length), sub: `of ${ALL_POSITIONS.length} positions`, color: sim.liquidated.length > 0 ? "#FC5457" : "#32EEE2" },
                { label: "Total Exposure at Risk", value: formatUsd(sim.totalExposure), sub: `${selectedStable.label} in margin accounts`, color: "#9F7BEE" },
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

          {/* Severity sweep */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">Liquidation vs. Depeg Severity</p>
            <p className="text-[9px] text-vgray-400 mb-3">Positions liquidated at each severity level — find the critical depeg threshold for your protocol</p>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={severityData} barSize={28}>
                <XAxis dataKey="severity" tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={cc.tooltip} formatter={(v, name) => [name === "positions" ? `${v} positions` : `$${v}K bad debt`, name]} />
                <Bar dataKey="positions" name="positions" radius={[3, 3, 0, 0]}>
                  {severityData.map((d, i) => <Cell key={i} fill={d.positions > 10 ? "#FC5457" : d.positions > 4 ? "#FF007A" : "#F59E0B"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* HF distribution */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">HF Distribution — Before vs After Depeg</p>
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

          {/* Position table */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-3">Position Impact — Stablecoin Exposure</p>
            <div className="overflow-x-auto scrollbar-thin max-h-48 overflow-y-auto">
              <table className="w-full text-[10px]">
                <thead className="sticky top-0 bg-surface">
                  <tr className="border-b border-vgray-100 text-vgray-400">
                    <th className="px-3 py-2 text-left font-semibold">Position</th>
                    <th className="px-3 py-2 text-right font-semibold">{selectedStable.label} Exp.</th>
                    <th className="px-3 py-2 text-right font-semibold">Loss</th>
                    <th className="px-3 py-2 text-center font-semibold">HF Before</th>
                    <th className="px-3 py-2 text-center font-semibold">HF After</th>
                    <th className="px-3 py-2 text-center font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sim.results.sort((a, b) => a.newHF - b.newHF).slice(0, 20).map(p => {
                    let exposure = 0;
                    if (stablecoin === "BLUSDC" || stablecoin === "BLUSDC+AQUSDC") exposure += p.blusdcValue;
                    if (stablecoin === "AQUSDC" || stablecoin === "BLUSDC+AQUSDC") exposure += p.aqusdcValue;
                    if (stablecoin === "SOUSDC") exposure += p.sousdcValue;
                    const loss = exposure * sim.effectiveSeverity / 100;
                    // Stellar G-account synthetic — never an EVM 0x.
                    const synthAccount = `G${(0xA000 + p.id * 71).toString(36).toUpperCase().padStart(50, "0").slice(0, 50)}`;
                    const display = `${synthAccount.slice(0, 6)}...${synthAccount.slice(-4)}`;
                    return (
                      <tr key={p.id} className={cn("border-b border-vgray-100/60", p.liquidated ? "bg-imperial-50/20" : "")}>
                        <td className="px-3 py-2 font-mono text-vgray-600">{display}</td>
                        <td className="px-3 py-2 text-right font-mono text-vgray-600">{formatUsd(exposure)}</td>
                        <td className="px-3 py-2 text-right font-mono text-imperial-600">-{formatUsd(loss)}</td>
                        <td className="px-3 py-2 text-center font-mono text-violet-600">{p.hf.toFixed(2)}</td>
                        <td className="px-3 py-2 text-center font-mono" style={{ color: p.newHF < LIQ_THRESHOLD ? "#FC5457" : p.newHF < 1.3 ? "#F59E0B" : "#32EEE2" }}>{p.newHF.toFixed(2)}</td>
                        <td className="px-3 py-2 text-center">
                          {p.liquidated
                            ? <span className="px-1.5 py-0.5 rounded bg-imperial-50 text-imperial-600 text-[8px] font-bold">LIQUIDATED</span>
                            : <span className="px-1.5 py-0.5 rounded bg-electric-50 text-electric-600 text-[8px] font-bold">SAFE</span>}
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
