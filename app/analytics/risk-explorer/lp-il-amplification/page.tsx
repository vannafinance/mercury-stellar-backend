"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/analytics/PageHeader";
import { formatUsd, cn, hfColor } from "@/lib/analytics/utils";
import { useChartColors } from "@/lib/analytics/theme";
import CoinIcon from "@/components/analytics/ui/CoinIcon";
import { syntheticGAccount, shortStellar } from "@/lib/analytics/stellar/canon";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ScatterChart, Scatter, ZAxis, CartesianGrid } from "recharts";

const INSURANCE_FUND = 5_400_000;
const LIQ_THRESHOLD = 1.1;
const dr = (s: number) => { const x = Math.sin(s * 9301 + 49297) * 233280; return x - Math.floor(x); };

// Real LP pools deployed on Stellar testnet (see CONTRACT_ADDRESSES in
// lib/stellar-utils.ts and AQUARIUS_POOLS/SOROSWAP_POOLS in
// lib/analytics/aquarius-utils.ts / soroswap-utils.ts). All 3 are XLM-paired
// (XLM being the primary volatile asset) — `stableAsset` is a loose label
// here (this page's IL math only needs a price RATIO, not a literal peg).
const POOLS = [
  { id: "aq_xlm_blusdc", label: "Aquarius XLM/USDC", volatileAsset: "XLM",  stableAsset: "AQUSDC", protocol: "Aquarius" as const },
  { id: "ss_xlm_susdc", label: "Soroswap XLM/USDC", volatileAsset: "XLM",  stableAsset: "SOUSDC", protocol: "Soroswap" as const },
  { id: "aq_xlm_usdt",  label: "Aquarius XLM/USDT", volatileAsset: "XLM",  stableAsset: "USDT",   protocol: "Aquarius" as const },
] as const;

// Standard AMM IL formula
const computeIL = (priceRatio: number): number => {
  return 2 * Math.sqrt(priceRatio) / (1 + priceRatio) - 1;
};

const LP_POSITIONS = Array.from({ length: 22 }, (_, i) => {
  const vannaLev = Math.min(10, Math.max(2, Math.round(2 + dr(i * 7) * 8)));
  const ownCollateral = Math.floor(50_000 + dr(i * 11) * 400_000 / 1000) * 1000;
  const debt = ownCollateral * (vannaLev - 1);
  const totalDeployed = ownCollateral + debt;
  const lpValue = Math.floor(totalDeployed * (0.6 + dr(i * 5) * 0.3));
  const cash = Math.floor(totalDeployed * 0.1);
  const aTokens = totalDeployed - lpValue - cash;
  const hf = totalDeployed / debt;
  const poolIdx = Math.floor(dr(i * 13) * POOLS.length);
  return {
    id: i,
    address: shortStellar(syntheticGAccount(i + 41)),
    vannaLeverage: vannaLev,
    ownCollateral,
    debt,
    totalDeployed,
    lpValue,
    cash,
    aTokens,
    hf: Math.round(hf * 100) / 100,
    pool: POOLS[poolIdx],
  };
});

export default function LPILAmplificationPage() {
  const cc = useChartColors();
  const [priceDrop, setPriceDrop] = useState(-20);
  const [selectedPool, setSelectedPool] = useState<string>("all");
  const [includeAccruedFees, setIncludeAccruedFees] = useState(false);
  const [hasRun, setHasRun] = useState(false);

  const filteredPositions = useMemo(() =>
    LP_POSITIONS.filter(p => selectedPool === "all" || p.pool.id === selectedPool),
    [selectedPool]
  );

  const sim = useMemo(() => {
    const shock = priceDrop / 100;
    const priceRatio = 1 + shock;
    const il = computeIL(priceRatio);
    const feeOffset = includeAccruedFees ? 0.02 : 0; // 2% accrued fees assumption

    const results = filteredPositions.map(pos => {
      // LP token value: affected by price drop of volatile asset (avg 50% weight) + IL
      const poolPriceImpact = shock * 0.5; // 50/50 pool, volatile side drops
      const newLPValue = pos.lpValue * (1 + poolPriceImpact) * (1 + il + feeOffset);
      const newCash = pos.cash * (1 + shock * 0.5);
      const newAToken = pos.aTokens * (1 + shock * 0.2);
      const newMargin = Math.max(0, newLPValue) + newCash + newAToken;
      const newHF = Math.round((newMargin / pos.debt) * 100) / 100;
      const ilLoss = pos.lpValue * Math.abs(il);
      const amplifiedLoss = ilLoss * pos.vannaLeverage;
      const pctOwnCapitalLost = (amplifiedLoss / pos.ownCollateral) * 100;
      return { ...pos, newHF, newMargin, ilLoss, amplifiedLoss, pctOwnCapitalLost, il };
    });

    const breaching = results.filter(p => p.newHF < LIQ_THRESHOLD);
    const debtAtRisk = breaching.reduce((a, p) => a + p.debt, 0);
    const grossRec = breaching.reduce((a, p) => a + p.newMargin * 0.93, 0);
    const netBadDebt = Math.max(0, debtAtRisk - grossRec);
    const coverage = netBadDebt > 0 ? Math.min(999, (INSURANCE_FUND / netBadDebt) * 100) : 999;
    const totalILLoss = results.reduce((a, p) => a + p.ilLoss, 0);
    return { results, breaching, debtAtRisk, grossRec, netBadDebt, coverage, totalILLoss, il, fundRemaining: Math.max(0, INSURANCE_FUND - netBadDebt) };
  }, [filteredPositions, priceDrop, includeAccruedFees]);

  // IL Amplification Matrix data
  const matrixData = [-5, -10, -20, -30, -50].map(drop => {
    const shock = drop / 100;
    const ratio = 1 + shock;
    const il = computeIL(ratio);
    return {
      drop: `${drop}%`,
      "2x": Math.round(Math.abs(il) * 2 * 100),
      "4x": Math.round(Math.abs(il) * 4 * 100),
      "6x": Math.round(Math.abs(il) * 6 * 100),
      "8x": Math.round(Math.abs(il) * 8 * 100),
      "10x": Math.round(Math.abs(il) * 10 * 100),
    };
  });

  return (
    <div className="p-6 w-full max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/analytics/overview2" className="flex items-center gap-1.5 text-[11px] text-vgray-400 hover:text-violet-600 transition-colors">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          Risk Command Center
        </Link>
        <span className="text-vgray-200">/</span>
        <span className="text-[11px] text-vgray-600 font-semibold">LP IL Amplification</span>
      </div>
      <PageHeader title="Leveraged LP Impermanent Loss Amplification" subtitle="IL on leveraged LP positions is amplified by Vanna leverage — normal IL becomes catastrophic at 8–10x" />

      <div className="bg-amber-50/60 border border-amber-200 rounded-r3 p-4">
        <p className="text-[11px] text-amber-700 font-semibold mb-1">Why leverage amplifies IL on Stellar LPs</p>
        <p className="text-[10px] text-amber-600 leading-relaxed">
          Normal Aquarius/Soroswap XLM/USDC LP: XLM drops 30% → IL ≈ 7.2% → acceptable loss.<br />
          <strong>With 8× Vanna leverage:</strong> Same LP on $80K notional (from $10K collateral) → 7.2% IL = $5,760 loss → 57.6% of your own $10K → near total wipeout + bad debt below the Risk Engine 1.1 HF threshold.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="space-y-4">
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-5 space-y-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500">Simulation Controls</p>

            <div className="space-y-2">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">LP Pool</label>
              <div className="space-y-1">
                <button onClick={() => setSelectedPool("all")} className={cn("w-full text-left px-3 py-2 rounded-r2 border text-[10px] font-semibold transition-all", selectedPool === "all" ? "bg-violet-50 border-violet-300 text-violet-700" : "border-vgray-100 text-vgray-500")}>
                  All Pools
                </button>
                {POOLS.map(p => (
                  <button key={p.id} onClick={() => setSelectedPool(p.id)} className={cn("w-full flex items-center gap-2 px-3 py-2 rounded-r2 border text-[10px] font-semibold transition-all", selectedPool === p.id ? "bg-violet-50 border-violet-300 text-violet-700" : "border-vgray-100 text-vgray-500")}>
                    <div className="flex items-center">
                      <CoinIcon symbol={p.volatileAsset} size={16} />
                      <CoinIcon symbol={p.stableAsset} size={16} className="-ml-1.5" />
                    </div>
                    {p.volatileAsset}/{p.stableAsset}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-vgray-400">Volatile Asset Drop</label>
                <span className="font-bold font-mono text-sm text-imperial-600">{priceDrop}%</span>
              </div>
              <input type="range" min={-70} max={-1} step={1} value={priceDrop}
                onChange={e => setPriceDrop(Number(e.target.value))}
                className="w-full h-1.5 appearance-none rounded-full bg-vgray-100 accent-imperial-500 cursor-pointer"
              />
              <div className="p-2 bg-vgray-50 rounded-r2 border border-vgray-100 text-center">
                <p className="text-[9px] text-vgray-400">Impermanent Loss at {priceDrop}%</p>
                <p className="text-lg font-bold font-mono text-rose-600">{(Math.abs(sim.il) * 100).toFixed(2)}%</p>
              </div>
            </div>

            <div className="flex items-center justify-between p-3 bg-vgray-50 rounded-r2 border border-vgray-100">
              <div>
                <p className="text-[10px] font-semibold text-vgray-600">Include Accrued LP Fees</p>
                <p className="text-[9px] text-vgray-400">+2% fee offset to IL</p>
              </div>
              <button onClick={() => setIncludeAccruedFees(!includeAccruedFees)}
                className={cn("w-10 h-5 rounded-full transition-colors relative", includeAccruedFees ? "bg-electric-500" : "bg-vgray-200")}>
                <span className={cn("w-4 h-4 bg-white rounded-full shadow absolute top-0.5 transition-transform", includeAccruedFees ? "translate-x-5" : "translate-x-0.5")} />
              </button>
            </div>

            <button onClick={() => setHasRun(true)}
              className="w-full py-3 rounded-r3 bg-gradient-to-r from-amber-500 to-violet-500 text-white text-[11px] font-bold uppercase tracking-wide hover:opacity-90 transition-opacity shadow-vanna">
              Run IL Simulation
            </button>
          </div>
        </div>

        <div className="lg:col-span-2 space-y-4">
          {/* Results */}
          <div className={cn("bg-surface rounded-r4 border shadow-vanna p-5", hasRun ? "border-violet-200" : "border-vgray-100")}>
            <p className="text-xs font-semibold uppercase tracking-wider text-vgray-500 mb-4">Simulation Results</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: "Positions Below HF 1.1", value: String(sim.breaching.length), sub: `${formatUsd(sim.debtAtRisk)} at risk`, color: sim.breaching.length > 0 ? "#FC5457" : "#32EEE2" },
                { label: "Total IL Loss (All)", value: formatUsd(sim.totalILLoss), sub: `Across ${filteredPositions.length} LP positions`, color: "#FF007A" },
                { label: "Estimated Bad Debt", value: formatUsd(sim.netBadDebt), sub: `${formatUsd(sim.grossRec)} gross recovery`, color: sim.netBadDebt > 0 ? "#FC5457" : "#32EEE2" },
                { label: "Protocol Solvency", value: sim.coverage >= 100 ? "SOLVENT" : "AT RISK", sub: `${Math.min(999, sim.coverage).toFixed(0)}% covered`, color: sim.coverage >= 100 ? "#32EEE2" : "#FC5457" },
              ].map(r => (
                <div key={r.label} className="p-3 rounded-r3 bg-vgray-50/60 border border-vgray-100 space-y-1">
                  <p className="text-[9px] font-semibold uppercase tracking-wide text-vgray-400">{r.label}</p>
                  <p className="text-xl font-bold font-mono" style={{ color: r.color }}>{r.value}</p>
                  <p className="text-[9px] text-vgray-400">{r.sub}</p>
                </div>
              ))}
            </div>
          </div>

          {/* IL Amplification Matrix */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500 mb-1">IL Amplification Matrix — % of Own Capital Lost</p>
            <p className="text-[9px] text-vgray-400 mb-3">Each cell = IL% × leverage = % of user's own capital wiped. Red = likely liquidation.</p>
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="border-b border-vgray-100 text-vgray-400">
                    <th className="px-3 py-2 text-left font-semibold">Asset Drop</th>
                    {["2x", "4x", "6x", "8x", "10x"].map(l => (
                      <th key={l} className="px-3 py-2 text-center font-semibold">{l} Leverage</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrixData.map(row => (
                    <tr key={row.drop} className="border-b border-vgray-100/60">
                      <td className="px-3 py-2 font-mono font-bold text-vgray-700">{row.drop}</td>
                      {(["2x", "4x", "6x", "8x", "10x"] as const).map(l => {
                        const val = row[l];
                        const isCritical = val > 80;
                        const isDanger = val > 50;
                        const isWarning = val > 30;
                        return (
                          <td key={l} className={cn("px-3 py-2 text-center font-mono font-semibold",
                            isCritical ? "bg-imperial-100 text-imperial-700" :
                            isDanger ? "bg-rose-50 text-rose-600" :
                            isWarning ? "bg-amber-50 text-amber-700" : "text-vgray-500"
                          )}>
                            {val}%
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[9px] text-vgray-400 mt-2 px-1">Red = position likely liquidated. 100% = total wipeout of own capital.</p>
            </div>
          </div>

          {/* Position table */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna overflow-hidden">
            <div className="px-5 py-3 border-b border-vgray-100">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-vgray-500">Position Impact — LP Positions Sorted by Worst Impact</p>
            </div>
            <div className="overflow-x-auto scrollbar-thin max-h-56">
              <table className="w-full text-[10px] min-w-[600px]">
                <thead className="sticky top-0 bg-vgray-50/90">
                  <tr className="border-b border-vgray-100 text-vgray-400">
                    <th className="px-3 py-2 text-left font-semibold">Pool</th>
                    <th className="px-3 py-2 text-center font-semibold">Leverage</th>
                    <th className="px-3 py-2 text-right font-semibold">IL Loss</th>
                    <th className="px-3 py-2 text-right font-semibold">% Own Capital</th>
                    <th className="px-3 py-2 text-center font-semibold">Before HF</th>
                    <th className="px-3 py-2 text-center font-semibold">After HF</th>
                    <th className="px-3 py-2 text-center font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sim.results.sort((a, b) => b.pctOwnCapitalLost - a.pctOwnCapitalLost).slice(0, 15).map(pos => (
                    <tr key={pos.id} className={cn("border-b border-vgray-100/60", pos.newHF < LIQ_THRESHOLD ? "bg-imperial-50/30" : "")}>
                      <td className="px-3 py-2 text-vgray-600">{pos.pool.label}</td>
                      <td className="px-3 py-2 text-center font-mono font-bold text-violet-600">{pos.vannaLeverage}x</td>
                      <td className="px-3 py-2 text-right font-mono text-rose-600">{formatUsd(pos.ilLoss)}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold" style={{ color: pos.pctOwnCapitalLost > 80 ? "#FC5457" : pos.pctOwnCapitalLost > 50 ? "#FF007A" : "#F59E0B" }}>
                        {pos.pctOwnCapitalLost.toFixed(1)}%
                      </td>
                      <td className="px-3 py-2 text-center font-mono" style={{ color: hfColor(pos.hf) }}>{pos.hf.toFixed(2)}</td>
                      <td className="px-3 py-2 text-center font-mono font-bold" style={{ color: hfColor(pos.newHF) }}>{pos.newHF.toFixed(2)}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={cn("text-[8px] font-bold px-1.5 py-0.5 rounded-full", pos.newHF < LIQ_THRESHOLD ? "bg-imperial-100 text-imperial-700" : pos.newHF < 1.3 ? "bg-amber-100 text-amber-700" : "bg-electric-50 text-electric-700")}>
                          {pos.newHF < LIQ_THRESHOLD ? "LIQ" : pos.newHF < 1.3 ? "CRIT" : "OK"}
                        </span>
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
