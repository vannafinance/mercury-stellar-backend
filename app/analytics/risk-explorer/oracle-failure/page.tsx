"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/analytics/PageHeader";
import { formatUsd, formatNumber, cn } from "@/lib/analytics/utils";
import { useChartColors } from "@/lib/analytics/theme";
import CoinIcon from "@/components/analytics/ui/CoinIcon";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, Legend } from "recharts";

const INSURANCE_FUND = 5_400_000;
const LIQ_THRESHOLD = 1.1;
const dr = (s: number) => { const x = Math.sin(s * 9301 + 49297) * 233280; return x - Math.floor(x); };

type FailureMode = "stale" | "crashed" | "inflated" | "manipulated";

const FAILURE_MODES: { id: FailureMode; label: string; color: string; desc: string; icon: React.ReactNode }[] = [
  { id: "stale", label: "Stale Oracle", color: "#F59E0B", desc: "Price feed stops updating — reported price diverges from market",
    icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="#F59E0B" strokeWidth="1.4"/><path d="M8 4.5V8L10.5 10" stroke="#F59E0B" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/><path d="M3 3L13 13" stroke="#FC5457" strokeWidth="1.2" strokeLinecap="round"/></svg> },
  { id: "crashed", label: "Oracle Crash", color: "#FC5457", desc: "Feed returns $0 — all collateral priced at zero",
    icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="#FC5457" strokeWidth="1.4"/><path d="M5.5 5.5L10.5 10.5M10.5 5.5L5.5 10.5" stroke="#FC5457" strokeWidth="1.4" strokeLinecap="round"/></svg> },
  { id: "inflated", label: "Price Inflation", color: "#FF007A", desc: "Manipulated feed reports inflated prices — overborrowing enabled",
    icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 12L5.5 8L8.5 10L14 4" stroke="#FF007A" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/><path d="M10.5 4H14V7.5" stroke="#FF007A" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg> },
  { id: "manipulated", label: "Flash Loan Attack", color: "#9F7BEE", desc: "Spot price oracle manipulated within a single block — fake HF spike",
    icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M9 1.5L5 8.5H8L7 14.5L11 7.5H8L9 1.5Z" stroke="#9F7BEE" strokeWidth="1.4" strokeLinejoin="round"/></svg> },
];

const AFFECTED_ASSETS = ["ETH", "WBTC", "weETH", "USDC", "All"];

const ALL_POSITIONS = Array.from({ length: 34 }, (_, i) => {
  const debt = Math.floor(70_000 + dr(i * 7) * 1_400_000 / 1000) * 1000;
  const hf = 1.13 + dr(i * 11) * 1.7;
  const marginValue = Math.floor(debt * hf);
  const leverage = Math.min(10, Math.max(1, Math.round(1.5 + dr(i * 13) * 8.5)));
  const trackTokens = Math.floor(marginValue * (leverage >= 7 ? 0.3 + dr(i * 3) * 0.3 : 0.05 + dr(i * 3) * 0.2));
  const cash = Math.floor(marginValue * (0.1 + dr(i * 5) * 0.2));
  const aTokens = Math.floor(marginValue * dr(i * 7) * 0.35);
  const lpTokens = Math.max(0, marginValue - trackTokens - cash - aTokens);
  // Each position's collateral is backed by a primary asset
  const assetIdx = Math.floor(dr(i * 19) * 4); // 0=ETH, 1=WBTC, 2=weETH, 3=USDC
  const assets = ["ETH", "WBTC", "weETH", "USDC"];
  return { id: i, debt, hf: Math.round(hf * 100) / 100, leverage, marginValue, trackTokens, cash, aTokens, lpTokens, primaryAsset: assets[assetIdx] };
});

function applyOracleFailure(pos: typeof ALL_POSITIONS[0], mode: FailureMode, affectedAsset: string, staleness: number, inflationPct: number) {
  const isAffected = affectedAsset === "All" || pos.primaryAsset === affectedAsset;
  if (!isAffected) {
    return { ...pos, newHF: pos.hf, newMargin: pos.marginValue, liquidated: false, badDebt: 0, oracleNote: "Unaffected" };
  }

  let newMargin = pos.marginValue;
  let oracleNote = "";

  switch (mode) {
    case "stale":
      // Stale = market moved but oracle didn't — position margin is actually staleness% worse
      newMargin = pos.marginValue * (1 - staleness / 100);
      oracleNote = `Actual price -${staleness}% below stale feed`;
      break;
    case "crashed":
      // All non-cash margin → 0
      newMargin = pos.cash;
      oracleNote = "Oracle returned $0 — collateral unpriced";
      break;
    case "inflated":
      // Inflated oracle → borrower could extract more; on HF side, "true" margin is lower
      newMargin = pos.marginValue / (1 + inflationPct / 100);
      oracleNote = `True margin ${inflationPct}% below inflated reading`;
      break;
    case "manipulated":
      // Flash loan: temporary spike then reverts; protocol may liquidate based on manipulated price
      // This creates bad liquidations — positions liquidated at wrong prices
      newMargin = pos.marginValue * 0.75; // assume 25% slippage on rushed liquidation
      oracleNote = "Liquidation triggered at manipulated price";
      break;
  }

  const newHF = Math.round((newMargin / pos.debt) * 100) / 100;
  const liquidated = newHF < LIQ_THRESHOLD;
  const grossRecovery = liquidated ? newMargin * 0.93 : 0;
  const badDebt = liquidated ? Math.max(0, pos.debt - grossRecovery) : 0;
  return { ...pos, newMargin, newHF, liquidated, badDebt, oracleNote };
}

export default function OracleFailurePage() {
  const cc = useChartColors();
  const [failureMode, setFailureMode] = useState<FailureMode>("stale");
  const [affectedAsset, setAffectedAsset] = useState("ETH");
  const [staleness, setStaleness] = useState(15); // % market moved while oracle stale
  const [inflationPct, setInflationPct] = useState(50);
  const [hasRun, setHasRun] = useState(false);

  const sim = useMemo(() => {
    const results = ALL_POSITIONS.map(p => applyOracleFailure(p, failureMode, affectedAsset, staleness, inflationPct));
    const liquidated = results.filter(p => p.liquidated);
    const totalBadDebt = liquidated.reduce((a, p) => a + p.badDebt, 0);
    const coverage = totalBadDebt > 0 ? Math.min(999, (INSURANCE_FUND / totalBadDebt) * 100) : 999;
    const affected = results.filter(p => p.oracleNote !== "Unaffected");
    return { results, liquidated, totalBadDebt, coverage, affected, fundRemaining: Math.max(0, INSURANCE_FUND - totalBadDebt) };
  }, [failureMode, affectedAsset, staleness, inflationPct]);

  // Failure mode comparison
  const modeComparison = FAILURE_MODES.map(m => {
    const res = ALL_POSITIONS.map(p => applyOracleFailure(p, m.id, affectedAsset, staleness, inflationPct));
    const liq = res.filter(p => p.liquidated);
    const bd = liq.reduce((a, p) => a + p.badDebt, 0);
    return { mode: m.label, liquidations: liq.length, badDebt: Math.round(bd / 1000), color: m.color };
  });

  // Staleness sweep (for stale mode)
  const stalenessSweep = [5, 10, 15, 20, 30, 40, 50].map(s => {
    const res = ALL_POSITIONS.map(p => applyOracleFailure(p, "stale", affectedAsset, s, inflationPct));
    const liq = res.filter(p => p.liquidated);
    const bd = liq.reduce((a, p) => a + p.badDebt, 0);
    return { staleness: `${s}%`, liquidations: liq.length, badDebt: Math.round(bd / 1000) };
  });

  // Asset breakdown
  const assetBreakdown = ["ETH", "WBTC", "weETH", "USDC"].map(asset => {
    const res = ALL_POSITIONS.map(p => applyOracleFailure(p, failureMode, asset, staleness, inflationPct));
    const liq = res.filter(p => p.liquidated);
    const bd = liq.reduce((a, p) => a + p.badDebt, 0);
    return { asset, liquidations: liq.length, badDebt: Math.round(bd / 1000) };
  });

  const selectedMode = FAILURE_MODES.find(m => m.id === failureMode)!;

  return (
    <div className="p-6 w-full max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/analytics/overview2" className="flex items-center gap-1.5 text-[11px] text-vgray-400 hover:text-violet-600 transition-colors">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          Risk Command Center
        </Link>
        <span className="text-vgray-200">/</span>
        <span className="text-[11px] text-vgray-600 font-semibold">Oracle Failure / Manipulation</span>
      </div>
      <PageHeader title="Oracle Failure / Manipulation" subtitle="Stress test what happens when price oracles fail, go stale, or are manipulated — bad prices = wrong HF calculations = wrong liquidations" />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Controls */}
        <div className="space-y-4">
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-5 space-y-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500">Oracle Failure Controls</p>

            {/* Failure Mode */}
            <div className="space-y-2">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Failure Mode</label>
              <div className="space-y-1.5">
                {FAILURE_MODES.map(m => (
                  <button key={m.id} onClick={() => setFailureMode(m.id)}
                    className={cn("w-full flex items-center gap-2.5 p-2.5 rounded-r2 border text-left transition-all",
                      failureMode === m.id ? "border-violet-300 bg-violet-50" : "border-vgray-100 hover:border-vgray-200"
                    )}>
                    <span className="shrink-0">{m.icon}</span>
                    <div>
                      <p className={cn("text-[10px] font-bold", failureMode === m.id ? "text-violet-700" : "text-vgray-600")}>{m.label}</p>
                      <p className="text-[8px] text-vgray-400">{m.desc}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Affected Asset */}
            <div className="space-y-2">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Affected Asset</label>
              <div className="flex flex-wrap gap-1.5">
                {AFFECTED_ASSETS.map(a => (
                  <button key={a} onClick={() => setAffectedAsset(a)}
                    className={cn("flex items-center gap-1 px-2.5 py-1 rounded-r2 border text-[10px] font-bold transition-all",
                      affectedAsset === a ? "bg-violet-50 border-violet-300 text-violet-700" : "border-vgray-100 text-vgray-400"
                    )}>
                    {a !== "All" && <CoinIcon symbol={a} size={14} />}
                    {a}
                  </button>
                ))}
              </div>
            </div>

            {/* Staleness / Inflation controls */}
            {failureMode === "stale" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Market Move During Staleness</label>
                  <span className="font-bold font-mono text-sm text-amber-600">-{staleness}%</span>
                </div>
                <input type="range" min={2} max={60} step={1} value={staleness}
                  onChange={e => setStaleness(Number(e.target.value))}
                  className="w-full h-1.5 appearance-none rounded-full bg-vgray-100 accent-amber-500 cursor-pointer"
                />
                <p className="text-[9px] text-vgray-400">How much the real price fell while oracle was frozen</p>
              </div>
            )}
            {failureMode === "inflated" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Oracle Inflation %</label>
                  <span className="font-bold font-mono text-sm text-pink-600">+{inflationPct}%</span>
                </div>
                <input type="range" min={10} max={200} step={10} value={inflationPct}
                  onChange={e => setInflationPct(Number(e.target.value))}
                  className="w-full h-1.5 appearance-none rounded-full bg-vgray-100 accent-pink-500 cursor-pointer"
                />
                <p className="text-[9px] text-vgray-400">% above true market price reported by oracle</p>
              </div>
            )}

            <button onClick={() => setHasRun(true)}
              className="w-full py-3 rounded-r3 bg-gradient-to-r from-imperial-500 to-violet-500 text-white text-[11px] font-bold uppercase tracking-wide hover:opacity-90 transition-opacity shadow-vanna">
              Run Oracle Scenario
            </button>
          </div>
        </div>

        {/* Results */}
        <div className="lg:col-span-2 space-y-4">
          {/* Core Metrics */}
          <div className={cn("bg-surface rounded-r4 border shadow-vanna p-5", hasRun ? "border-violet-200" : "border-vgray-100")}>
            <div className="flex items-center gap-2 mb-4">
              <span className="text-lg">{selectedMode.icon}</span>
              <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500">Oracle {selectedMode.label} — {affectedAsset} Affected</p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: "Positions Affected", value: String(sim.affected.length), sub: `${ALL_POSITIONS.length - sim.affected.length} positions unaffected`, color: "#9F7BEE" },
                { label: "Positions Below HF 1.1", value: String(sim.liquidated.length), sub: `From oracle failure`, color: sim.liquidated.length > 0 ? "#FC5457" : "#32EEE2" },
                { label: "Net Bad Debt", value: formatUsd(sim.totalBadDebt), sub: "Incorrect liquidations", color: sim.totalBadDebt > 0 ? "#FC5457" : "#32EEE2" },
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

          {/* Failure Mode Comparison */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">Failure Mode Comparison — {affectedAsset}</p>
            <p className="text-[9px] text-vgray-400 mb-3">Liquidations across all 4 oracle failure scenarios for selected asset</p>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={modeComparison} barSize={36}>
                <XAxis dataKey="mode" tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={cc.tooltip} formatter={(v, name) => [name === "liquidations" ? `${v} positions` : `$${v}K bad debt`, name]} />
                <Bar dataKey="liquidations" name="liquidations" radius={[4, 4, 0, 0]}>
                  {modeComparison.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Staleness sweep or asset breakdown */}
            <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">
                {failureMode === "stale" ? "Liquidations vs. Staleness" : "Liquidations by Asset"}
              </p>
              <ResponsiveContainer width="100%" height={140}>
                {failureMode === "stale" ? (
                  <BarChart data={stalenessSweep} barSize={22}>
                    <XAxis dataKey="staleness" tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={cc.tooltip} formatter={(v) => [`${v} positions`, "Liquidated"]} />
                    <Bar dataKey="liquidations" fill="#F59E0B" radius={[3, 3, 0, 0]}>
                      {stalenessSweep.map((d, i) => <Cell key={i} fill={d.liquidations > 5 ? "#FC5457" : "#F59E0B"} />)}
                    </Bar>
                  </BarChart>
                ) : (
                  <BarChart data={assetBreakdown} barSize={28}>
                    <XAxis dataKey="asset" tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={cc.tooltip} formatter={(v) => [`${v} positions`, "Liquidated"]} />
                    <Bar dataKey="liquidations" radius={[3, 3, 0, 0]}>
                      {assetBreakdown.map((d, i) => <Cell key={i} fill={["#9F7BEE", "#F59E0B", "#32EEE2", "#2775CA"][i]} />)}
                    </Bar>
                  </BarChart>
                )}
              </ResponsiveContainer>
            </div>

            {/* Oracle circuit breakers info */}
            <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4 space-y-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500">Oracle Safeguards Status</p>
              {[
                { label: "Chainlink heartbeat", status: "Active", ok: true, note: "60s max staleness" },
                { label: "Pyth fallback", status: "Standby", ok: true, note: "Cross-validated" },
                { label: "RedStone fallback", status: "Standby", ok: true, note: "On-demand" },
                { label: "Deviation guard", status: failureMode === "inflated" ? "BREACHED" : "Active", ok: failureMode !== "inflated", note: "±2% from median" },
                { label: "TWAP protection", status: failureMode === "manipulated" ? "BYPASSED" : "Active", ok: failureMode !== "manipulated", note: "30-min window" },
                { label: "Emergency pause", status: failureMode === "crashed" ? "TRIGGERED" : "Armed", ok: true, note: "DAO multisig" },
              ].map(s => (
                <div key={s.label} className="flex items-center justify-between">
                  <div>
                    <p className="text-[9px] font-semibold text-vgray-600">{s.label}</p>
                    <p className="text-[8px] text-vgray-400">{s.note}</p>
                  </div>
                  <span className={cn("text-[8px] font-bold px-1.5 py-0.5 rounded", s.ok ? "bg-electric-50 text-electric-600" : "bg-imperial-50 text-imperial-600")}>{s.status}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Position table */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-3">Position Impact — Oracle {selectedMode.label}</p>
            <div className="overflow-x-auto scrollbar-thin max-h-48 overflow-y-auto">
              <table className="w-full text-[10px]">
                <thead className="sticky top-0 bg-surface">
                  <tr className="border-b border-vgray-100 text-vgray-400">
                    <th className="px-3 py-2 text-left font-semibold">Position</th>
                    <th className="px-3 py-2 text-center font-semibold">Asset</th>
                    <th className="px-3 py-2 text-center font-semibold">HF Before</th>
                    <th className="px-3 py-2 text-center font-semibold">HF After</th>
                    <th className="px-3 py-2 text-left font-semibold">Oracle Note</th>
                    <th className="px-3 py-2 text-center font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sim.results.sort((a, b) => a.newHF - b.newHF).slice(0, 20).map(p => (
                    <tr key={p.id} className={cn("border-b border-vgray-100/60", p.liquidated ? "bg-imperial-50/20" : "")}>
                      <td className="px-3 py-2 font-mono text-vgray-600">0x{(0xa000 + p.id * 71).toString(16)}...{(0xb100 + p.id * 53).toString(16)}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-center gap-1">
                          <CoinIcon symbol={p.primaryAsset} size={14} />
                          <span className="font-mono text-vgray-500">{p.primaryAsset}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-center font-mono text-violet-600">{p.hf.toFixed(2)}</td>
                      <td className="px-3 py-2 text-center font-mono" style={{ color: p.newHF < LIQ_THRESHOLD ? "#FC5457" : p.newHF < 1.3 ? "#F59E0B" : "#32EEE2" }}>{p.newHF.toFixed(2)}</td>
                      <td className="px-3 py-2 text-[9px] text-vgray-400">{p.oracleNote}</td>
                      <td className="px-3 py-2 text-center">
                        {p.liquidated
                          ? <span className="px-1.5 py-0.5 rounded bg-imperial-50 text-imperial-600 text-[8px] font-bold">LIQUIDATED</span>
                          : p.oracleNote === "Unaffected"
                            ? <span className="px-1.5 py-0.5 rounded bg-vgray-50 text-vgray-400 text-[8px] font-bold">UNAFFECTED</span>
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
