"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { useUserStore } from "@/store/user";
import {
  protocolOverview as mockProtocolOverview,
  hfDistribution as mockHfDistribution,
  leverageDistribution as mockLeverageDistribution,
  marginComposition as mockMarginComposition,
} from "@/lib/analytics/data/mock";
import { useAnalyticsOnchainStore } from "@/lib/analytics/onchain/store";
import {
  deriveProtocolOverview,
  deriveHfDistribution,
  deriveLeverageDistribution,
  deriveMarginComposition,
} from "@/lib/analytics/onchain/derivations";
import { PageHeader, PageHeaderMeta } from "@/components/analytics/PageHeader";
import { formatUsd, formatNumber, formatPercent, formatTimeAgo, cn, hfColor, hfBandColor, leverageColor } from "@/lib/analytics/utils";
import { useChartColors } from "@/lib/analytics/theme";
import MiniSparkline from "@/components/analytics/charts/MiniSparkline";
import InfoTooltip from "@/components/analytics/ui/InfoTooltip";
import CoinIcon from "@/components/analytics/ui/CoinIcon";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  RadialBarChart, RadialBar, PolarAngleAxis,
} from "recharts";
import { syntheticGAccount, shortStellar } from "@/lib/analytics/stellar/canon";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const INSURANCE_FUND = 5_400_000;
const LIQUIDATION_THRESHOLD = 1.1;

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────
// Single-chain protocol; legacy "base" kept in the union for back-compat with
// derivations that may still tag rows historically — UI now treats everything
// as Stellar.
type Chain = "base" | "stellar";
type ActiveTab = "hf" | "pnl" | "leverage";

interface PositionRow {
  address: string;
  chain: Chain;
  healthFactor: number;
  totalDebt: number;
  marginValue: number;
  leverage: number;
  currentPnL: number;
  pnlPercent: number;
  openSince: number;
  primaryProtocol: string;
  breakdown: { aTokens: number; lpTokens: number; trackTokens: number; cash: number };
  hfTrend: number[];
  pnlTrend: number[];
  distanceToLiquidation: number;
  liquidationPrice: number;
  timeAtRisk: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC POSITION DATA (seeded, no Math.random)
// ─────────────────────────────────────────────────────────────────────────────
const dr = (seed: number): number => {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
};

// Stellar-only protocol universe (matches CONTRACT_ADDRESSES on testnet).
const PROTO_LIST = ["Blend", "Aquarius", "Soroswap"];

const ALL_POSITIONS: PositionRow[] = Array.from({ length: 32 }, (_, i) => {
  let hf: number;
  if (i === 0) hf = 0.93;
  else if (i === 1) hf = 0.97;
  else if (i === 2) hf = 1.04;
  else if (i < 7) hf = 1.06 + (i - 3) * 0.04;
  else if (i < 18) hf = 1.25 + (i - 7) * 0.08;
  else hf = 2.0 + (i - 18) * 0.15;

  hf = Math.round(hf * 100) / 100;

  const debt = Math.floor(60_000 + dr(i * 7 + 1) * 1_600_000 / 1000) * 1000;
  const marginValue = Math.floor(debt * hf);
  const leverage = Math.min(10, Math.max(1, Math.round(1.5 + dr(i * 13 + 2) * 8.5)));
  // Single chain — every margin account is a Soroban SmartAccount.
  const chain: Chain = "stellar";

  const trackPct = leverage >= 7 ? 0.35 + dr(i * 3 + 3) * 0.3 : dr(i * 3 + 3) * 0.22;
  const aTokenPct = dr(i * 5 + 4) * 0.38;
  const rem = Math.max(0.08, 1 - trackPct - aTokenPct);
  const lpTokenPct = dr(i * 11 + 5) * rem * 0.7;
  const cashPct = Math.max(0.05, rem - lpTokenPct);
  const trackTokens = Math.floor(marginValue * trackPct);
  const aTokens = Math.floor(marginValue * aTokenPct);
  const lpTokens = Math.floor(marginValue * lpTokenPct);
  const cash = Math.max(0, marginValue - trackTokens - aTokens - lpTokens);

  const pnlPct = leverage >= 7
    ? -(dr(i * 17 + 6) * 0.7 + 0.05)
    : (dr(i * 17 + 6) - 0.45) * 0.7;

  const distToLiq = Math.max(0, ((hf - LIQUIDATION_THRESHOLD) / hf) * 100);
  const protIdx = Math.floor(dr(i * 23 + 7) * PROTO_LIST.length);

  // Format-correct Stellar G-account addresses (56 chars base32).
  const address = shortStellar(syntheticGAccount(i + 5001));

  return {
    address,
    chain,
    healthFactor: hf,
    totalDebt: debt,
    marginValue,
    leverage,
    currentPnL: Math.floor(debt * pnlPct),
    pnlPercent: Math.round(pnlPct * 1000) / 10,
    openSince: Date.now() - Math.floor(dr(i * 29 + 8) * 30) * 86_400_000,
    primaryProtocol: PROTO_LIST[protIdx],
    breakdown: { aTokens, lpTokens, trackTokens, cash },
    hfTrend: Array.from({ length: 10 }, (_, j) => Math.max(0.5, hf + (dr(i * 100 + j) - 0.5) * 0.14)),
    pnlTrend: Array.from({ length: 10 }, (_, j) => Math.floor(debt * pnlPct * (0.65 + dr(i * 200 + j) * 0.7))),
    distanceToLiquidation: Math.round(distToLiq * 10) / 10,
    // Anchored to XLM Reflector reference price (~$0.16) — see FALLBACK_PRICES.
    liquidationPrice: Math.round(0.16 * (1 - distToLiq / 100) * 10000) / 10000,
    timeAtRisk: hf < 1.5 ? Math.floor(dr(i * 31 + 9) * 7200) : 0,
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function getStatus(hf: number): string {
  if (hf < LIQUIDATION_THRESHOLD) return "LIQUIDATABLE";
  if (hf < 1.3) return "CRITICAL";
  if (hf < 1.5) return "WARNING";
  return "HEALTHY";
}

function statusStyle(hf: number): string {
  if (hf < LIQUIDATION_THRESHOLD) return "bg-imperial-100 text-imperial-700 border border-imperial-300";
  if (hf < 1.3) return "bg-amber-400/10 text-amber-600 border border-amber-400/30";
  if (hf < 1.5) return "bg-violet-50 text-violet-600 border border-violet-200";
  return "bg-electric-50 text-electric-700 border border-electric-200";
}

function rowBg(hf: number): string {
  if (hf < LIQUIDATION_THRESHOLD) return "bg-imperial-50/40";
  if (hf < 1.3) return "bg-amber-50/30";
  return "";
}

function ChainBadge({ chain: _chain }: { chain: Chain }) {
  return (
    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide bg-electric-50 text-electric-700">
      Stellar
    </span>
  );
}

function MarginBar({ breakdown, total }: { breakdown: PositionRow["breakdown"]; total: number }) {
  const segments = [
    { val: breakdown.trackTokens, color: "#FC5457", label: "Track" },
    { val: breakdown.lpTokens, color: "#703AE6", label: "LP" },
    { val: breakdown.aTokens, color: "#32EEE2", label: "aToken" },
    { val: breakdown.cash, color: "#949494", label: "Cash" },
  ];
  return (
    <div className="flex h-2 w-20 rounded-full overflow-hidden gap-px" title="Track/LP/aToken/Cash">
      {segments.map((s) => (
        <div key={s.label} style={{ width: `${(s.val / total) * 100}%`, background: s.color }} />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ADVANCED KPI CARD
// ─────────────────────────────────────────────────────────────────────────────
function AdvKpi({
  label, value, sub, sparkData, sparkColor, accentColor, tooltip, badge,
}: {
  label: string; value: string; sub?: string; sparkData?: number[]; sparkColor?: string;
  accentColor?: string; tooltip?: string; badge?: string;
}) {
  return (
    <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-5 min-w-0">
      <div className="flex items-center gap-1.5 mb-1.5">
        <p className="text-[11px] font-semibold text-vgray-500 uppercase tracking-wide">{label}</p>
        {tooltip && <InfoTooltip text={tooltip} />}
        {badge && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-imperial-50 text-imperial-600 border border-imperial-200 whitespace-nowrap">
            {badge}
          </span>
        )}
      </div>
      <div className="flex items-end justify-between gap-2">
        <p className="text-xl sm:text-2xl font-bold font-mono text-vgray-800 tabular-nums">
          {value}
        </p>
        {sparkData && sparkData.length >= 2 && (
          <MiniSparkline data={sparkData} color={sparkColor ?? "#703AE6"} width={60} height={28} />
        )}
      </div>
      {sub && <p className="text-xs text-vgray-400 mt-1.5 leading-snug">{sub}</p>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM HEALTH GAUGE
// ─────────────────────────────────────────────────────────────────────────────
function SystemHealthGauge({ score }: { score: number }) {
  const color = score >= 70 ? "#32EEE2" : score >= 45 ? "#F59E0B" : "#FC5457";
  const data = [{ value: score, fill: color }, { value: 100 - score, fill: "#F4F4F4" }];
  return (
    <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4 flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-vgray-400">System Health Score</p>
        <InfoTooltip text="Composite 0–100 score based on HF distribution, bad debt rate, insurance coverage, and leverage concentration. Higher = safer protocol." />
      </div>
      <div className="flex items-center gap-3">
        <div className="relative w-14 h-14">
          <RadialBarChart width={56} height={56} cx={28} cy={28} innerRadius={18} outerRadius={26} startAngle={90} endAngle={-270} data={data} barSize={8}>
            <RadialBar dataKey="value" cornerRadius={4} background={false} />
          </RadialBarChart>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[11px] font-bold font-mono" style={{ color }}>{score}</span>
          </div>
        </div>
        <div>
          <p className="text-xl font-bold font-mono tabular-nums text-vgray-800">{score}<span className="text-sm text-vgray-400">/100</span></p>
          <p className="text-[10px] text-vgray-400">{score >= 70 ? "Protocol healthy" : score >= 45 ? "Elevated risk" : "Critical state"}</p>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SIMULATION CARD
// ─────────────────────────────────────────────────────────────────────────────
const SIM_CARDS: { cat: string; catColor: string; title: string; desc: string; route: string; lastResult: string; icon: React.ReactNode }[] = [
  // MARKET RISK
  { cat: "MARKET RISK", catColor: "#703AE6", title: "Single Asset Risk Explorer", desc: "Simulate the impact of a single asset price drop on all positions holding it as collateral or exposure.", route: "/analytics/risk-explorer/single-asset", lastResult: "47 positions at risk · $2.1M bad debt est.",
    icon: <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 4L7 10L11 7L18 16" stroke="#703AE6" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/><path d="M13 16H18V11" stroke="#703AE6" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg> },
  { cat: "MARKET RISK", catColor: "#703AE6", title: "Multi-Asset Correlated Crash", desc: "Correlated market crash across the Stellar ecosystem — XLM Deep Bear, Stellar Flash Crash, Stable Pool Contagion presets.", route: "/analytics/risk-explorer/multi-asset-crash", lastResult: "112 positions at risk · $8.4M bad debt est.",
    icon: <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="10" width="3" height="8" rx="1" fill="#703AE6"/><rect x="7" y="6" width="3" height="12" rx="1" fill="#703AE6" fillOpacity="0.7"/><rect x="12" y="2" width="3" height="16" rx="1" fill="#703AE6" fillOpacity="0.4"/><path d="M17 8L15 10M15 10L13 8M15 10V4" stroke="#FC5457" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg> },
  { cat: "MARKET RISK", catColor: "#703AE6", title: "Stablecoin Depeg Simulation", desc: "BLUSDC / AQUSDC / SOUSDC depegs — dual impact: collateral value drops and borrower debt exposure changes.", route: "/analytics/risk-explorer/stablecoin-depeg", lastResult: "23 positions at risk · $1.2M bad debt est.",
    icon: <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="7.5" stroke="#703AE6" strokeWidth="1.6"/><path d="M10 5.5V7M10 13V14.5M7.5 8.5C7.5 7.4 8.6 6.5 10 6.5C11.4 6.5 12.5 7.4 12.5 8.5C12.5 9.6 11.4 10.5 10 10.5C8.6 10.5 7.5 11.4 7.5 12.5C7.5 13.6 8.6 14.5 10 14.5C11.4 14.5 12.5 13.6 12.5 12.5" stroke="#703AE6" strokeWidth="1.6" strokeLinecap="round"/></svg> },
  // LEVERAGE RISK
  { cat: "LEVERAGE RISK", catColor: "#FC5457", title: "LP Impermanent Loss Amplification", desc: "Leveraged LP positions on Aquarius / Soroswap — IL amplified by Vanna leverage causes HF collapse.", route: "/analytics/risk-explorer/lp-il-amplification", lastResult: "34 positions at risk · $2.8M bad debt est.",
    icon: <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 12C4 8 6 6 10 6C14 6 16 10 18 10" stroke="#FC5457" strokeWidth="1.6" strokeLinecap="round"/><path d="M2 16C4 12 6 10 10 10C14 10 16 14 18 14" stroke="#FC5457" strokeWidth="1.6" strokeLinecap="round" strokeOpacity="0.5"/><path d="M10 6V3M8.5 4.5L10 3L11.5 4.5" stroke="#FC5457" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg> },
  // SYSTEMIC RISK
  { cat: "SYSTEMIC RISK", catColor: "#F59E0B", title: "Whale Withdrawal Risk", desc: "Top LP depositors withdraw — pool utilization spikes, APR surges, borrower HF degrades over time.", route: "/analytics/risk-explorer/whale-withdrawal", lastResult: "18 positions at risk · $0.9M bad debt est.",
    icon: <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 12C3 9 5.5 6.5 9 6.5C12.5 6.5 15 8.5 16 11C17 11 18.5 10.5 18.5 12C18.5 13.5 17 14 16 14H5C3.5 14 3 13 3 12Z" stroke="#F59E0B" strokeWidth="1.6" strokeLinejoin="round"/><path d="M16 11C15.5 9 14 7 12 6.5L14 4" stroke="#F59E0B" strokeWidth="1.4" strokeLinecap="round"/><circle cx="7" cy="10.5" r="1" fill="#F59E0B"/></svg> },
  // PROTOCOL RISK
  { cat: "PROTOCOL RISK", catColor: "#FF007A", title: "Oracle Failure / Manipulation", desc: "Stale or manipulated oracle triggers wrongful liquidations or enables overborrowing.", route: "/analytics/risk-explorer/oracle-failure", lastResult: "12 positions at risk · $0.4M bad debt est.",
    icon: <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="7.5" stroke="#FF007A" strokeWidth="1.6"/><circle cx="10" cy="10" r="3" stroke="#FF007A" strokeWidth="1.6"/><path d="M10 2.5V5M10 15V17.5M2.5 10H5M15 10H17.5" stroke="#FF007A" strokeWidth="1.4" strokeLinecap="round"/></svg> },
];

function SimCard({ sim }: { sim: typeof SIM_CARDS[0] }) {
  return (
    <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-4 flex flex-col gap-3 group hover:border-violet-200 hover:shadow-lg transition-all duration-200">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex-shrink-0">{sim.icon}</span>
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide" style={{ background: sim.catColor + "18", color: sim.catColor, border: `1px solid ${sim.catColor}30` }}>
            {sim.cat}
          </span>
        </div>
      </div>
      <div>
        <p className="text-[13px] font-semibold text-vgray-800 leading-tight mb-1">{sim.title}</p>
        <p className="text-[11px] text-vgray-400 leading-snug">{sim.desc}</p>
      </div>
      <div className="border-t border-vgray-100 pt-2.5 flex items-end justify-between gap-2">
        <div>
          <p className="text-[9px] text-vgray-300 uppercase tracking-wide mb-0.5">Last Run</p>
          <p className="text-[10px] text-vgray-500">{sim.lastResult}</p>
        </div>
        <Link href={sim.route} className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-r2 bg-violet-50 text-violet-600 border border-violet-200 text-[11px] font-semibold hover:bg-violet-100 transition-colors whitespace-nowrap group-hover:bg-violet-500 group-hover:text-white group-hover:border-violet-500">
          Run Simulation
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2 5H8M5.5 2.5L8 5L5.5 7.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BAD DEBT / INSURANCE METER
// ─────────────────────────────────────────────────────────────────────────────
function BadDebtMeter({ badDebt, atRisk, buffer, insuranceFund }: { badDebt: number; atRisk: number; buffer: number; insuranceFund: number }) {
  const total = badDebt + atRisk + buffer;
  const safePct = Math.max(5, (buffer / total) * 100);
  const atRiskPct = (atRisk / total) * 100;
  const badDebtPct = Math.max(0, (badDebt / total) * 100);
  const coverPct = Math.min(100, (insuranceFund / total) * 100);

  return (
    <div className="space-y-2">
      <div className="flex h-5 rounded-full overflow-hidden gap-0.5">
        <div className="flex items-center justify-center text-[8px] font-bold text-white" style={{ width: `${badDebtPct}%`, background: "#FC5457", minWidth: badDebt > 0 ? "4px" : "0" }}>
          {badDebt > 0 && formatUsd(badDebt)}
        </div>
        <div className="flex items-center justify-center text-[8px] font-bold text-white" style={{ width: `${atRiskPct}%`, background: "#FF007A" }}>
          {formatUsd(atRisk)}
        </div>
        <div className="flex-1 flex items-center justify-center text-[8px] font-bold text-violet-700" style={{ background: "#F1EBFD" }}>
          {formatUsd(buffer)}
        </div>
      </div>
      <div className="flex items-center gap-1 text-[9px] text-vgray-400">
        <span className="w-2 h-2 rounded-full bg-imperial-500 flex-shrink-0" />Active bad debt
        <span className="w-2 h-2 rounded-full bg-rose-500 flex-shrink-0 ml-2" />At risk (HF&lt;1.1)
        <span className="w-2 h-2 rounded-full bg-violet-100 flex-shrink-0 ml-2" />Buffer zone (1.1–1.3)
      </div>
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-vgray-500">Insurance fund coverage</span>
        <span className="font-semibold font-mono text-electric-700">{formatUsd(insuranceFund)} ({coverPct.toFixed(0)}% of exposure)</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export default function Overview2Page() {
  const cc = useChartColors();
  const [activeTab, setActiveTab] = useState<ActiveTab>("hf");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  // Single-chain build — kept as a no-op for layout compatibility.
  const chainFilter = "all" as const;

  const timeStr = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

  // ── Live data (Stellar) ────────────────────────────────────────────────
  // Adapter pulls 1 real snapshot from the connected wallet's margin
  // account + a deterministic synthetic fill so distribution charts
  // populate. See lib/analytics/stellar/buildSnapshots.ts.
  const userAddress = useUserStore((s) => s.address);
  const snapshot = useAnalyticsOnchainStore((s) => s.result);
  const isLoadingSnapshot = useAnalyticsOnchainStore((s) => s.isLoading);
  const load = useAnalyticsOnchainStore((s) => s.load);

  useEffect(() => {
    void load(userAddress);
  }, [userAddress, load]);

  // Derivations. Fall back to mock when no snapshot OR the protocol has zero
  // active debt (charts would otherwise render empty bars).
  const liveOverview = useMemo(
    () => (snapshot ? deriveProtocolOverview(snapshot.accounts) : null),
    [snapshot],
  );
  const liveHfDist = useMemo(
    () => (snapshot ? deriveHfDistribution(snapshot.accounts) : null),
    [snapshot],
  );
  const liveLeverageDist = useMemo(
    () => (snapshot ? deriveLeverageDistribution(snapshot.accounts) : null),
    [snapshot],
  );
  const liveMargin = useMemo(
    () => (snapshot ? deriveMarginComposition(snapshot.accounts) : null),
    [snapshot],
  );

  const hasLiveData = Boolean(liveOverview && liveOverview.activeAccountCount > 0);
  const protocolOverview = hasLiveData ? liveOverview! : mockProtocolOverview;
  const hfDistribution = hasLiveData && liveHfDist!.some((b) => b.totalDebtUsd > 0)
    ? liveHfDist!
    : mockHfDistribution;
  const leverageDistribution = hasLiveData && liveLeverageDist!.some((b) => b.debtUsd > 0)
    ? liveLeverageDist!
    : mockLeverageDistribution;
  const marginComposition = hasLiveData &&
    (liveMargin!.aTokens.valueUsd + liveMargin!.lpTokens.valueUsd + liveMargin!.trackTokens.valueUsd + liveMargin!.cash.valueUsd) > 0
    ? liveMargin!
    : mockMarginComposition;

  // ── Derived KPI Data ────────────────────────────────────────────────────
  const belowThreshold = hfDistribution.filter(b => b.range.includes("1.0")).reduce((a, b) => ({ positions: a.positions + b.positionCount, debt: a.debt + b.totalDebtUsd }), { positions: 0, debt: 0 });
  const atRiskExposure = hfDistribution.find(b => b.range === "1.0–1.1")?.totalDebtUsd ?? 0;
  const bufferZoneDebt = hfDistribution.find(b => b.range === "1.1–1.3")?.totalDebtUsd ?? 0;
  const activeBadDebt = protocolOverview.activeBadDebt.value;
  const totalPositions = leverageDistribution.reduce((a, b) => a + b.count, 0);
  const avgLeverage = totalPositions > 0
    ? leverageDistribution.reduce((a, b) => a + (parseInt(b.range) + 0.5) * b.count, 0) / totalPositions
    : 0;
  const avgHFSparkline = Array.from({ length: 10 }, (_, i) => 2.12 + (dr(i * 17) - 0.5) * 0.12);
  const activeCount = hasLiveData ? liveOverview!.activeAccountCount : ALL_POSITIONS.length;

  // ── Filtered & Sorted Positions ─────────────────────────────────────────
  const filteredPositions = useMemo(() =>
    ALL_POSITIONS.filter(p => chainFilter === "all" || p.chain === chainFilter),
    [chainFilter]
  );

  const hfSorted = useMemo(() => [...filteredPositions].sort((a, b) => a.healthFactor - b.healthFactor), [filteredPositions]);
  const pnlSorted = useMemo(() => [...filteredPositions].sort((a, b) => a.currentPnL - b.currentPnL), [filteredPositions]);
  const leverageSorted = useMemo(() => [...filteredPositions].sort((a, b) => b.leverage - a.leverage), [filteredPositions]);

  const displayPositions = activeTab === "hf" ? hfSorted : activeTab === "pnl" ? pnlSorted : leverageSorted;

  return (
    <div className="p-6 w-full max-w-[1600px] mx-auto space-y-8">
      <PageHeader
        title="Overview"
        subtitle="Advanced protocol-wide risk intelligence · Liquidation threshold: HF 1.1"
        meta={<PageHeaderMeta timeLabel={timeStr} mock={!hasLiveData} />}
      />

      {/* ── LIVE DATA STATUS STRIP ─────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 rounded-r4 border border-vgray-100 bg-surface px-4 py-2 text-[11px]">
        <div className="flex items-center gap-2 text-vgray-500">
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              hasLiveData ? "bg-electric-500" : isLoadingSnapshot ? "bg-amber-400 animate-pulse" : "bg-vgray-300",
            )}
          />
          {isLoadingSnapshot && !snapshot ? (
            <span>Loading Stellar accounts…</span>
          ) : hasLiveData ? (
            <span>
              Live · Stellar · <span className="font-mono tabular-nums">{snapshot!.accountCount}</span> accounts
              {userAddress ? (
                snapshot!.realAccountCount > 0 ? (
                  <span className="text-vgray-400">
                    {" "}
                    · {snapshot!.realAccountCount} real + {snapshot!.accountCount - snapshot!.realAccountCount}{" "}
                    synthetic
                  </span>
                ) : (
                  <span className="text-vgray-400">
                    {" "}
                    · all {snapshot!.accountCount} synthetic (open a margin account for your data)
                  </span>
                )
              ) : (
                <span className="text-vgray-400"> · all synthetic (connect wallet for real data)</span>
              )}
            </span>
          ) : snapshot ? (
            <span>No active accounts — showing mock data</span>
          ) : (
            <span>Connect wallet for real margin position — showing mock data</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void load(userAddress, { force: true })}
          disabled={isLoadingSnapshot}
          className="rounded-full border border-vgray-200 bg-vgray-50 px-3 py-1 font-semibold text-vgray-600 hover:bg-vgray-100 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoadingSnapshot ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* ── SECTION 1: RISK COMMAND BAR ─────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-vgray-400">Analytics</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">

          <AdvKpi
            label="Active Bad Debt"
            value={formatUsd(activeBadDebt)}
            sub={activeBadDebt > 0 ? "Uncovered protocol loss" : "No active bad debt"}
            accentColor={activeBadDebt > 500_000 ? "#FC5457" : activeBadDebt > 0 ? "#F59E0B" : "#32EEE2"}
            tooltip="Current bad debt — debt that cannot be recovered from liquidated collateral. Must be covered by the insurance fund."
          />

          <AdvKpi
            label="Insurance Fund"
            value={formatUsd(INSURANCE_FUND)}
            sub={`${((INSURANCE_FUND / (activeBadDebt + INSURANCE_FUND)) * 100).toFixed(0)}% capacity remaining`}
            accentColor="#32EEE2"
            tooltip="Total insurance fund balance available to cover bad debt. If bad debt exceeds this, the protocol requires recapitalization."
          />

          <AdvKpi
            label="Positions Below HF 1.1"
            value={String(belowThreshold.positions)}
            sub={`${formatUsd(belowThreshold.debt)} liquidatable debt`}
            accentColor={belowThreshold.positions > 0 ? "#FC5457" : "#32EEE2"}
            badge={belowThreshold.positions > 0 ? "LIQUIDATABLE" : undefined}
            tooltip="Count of positions currently below Vanna's liquidation threshold of HF 1.1 — these can be liquidated right now."
          />

          <AdvKpi
            label="Value Eligible for Liquidation"
            value={formatUsd(belowThreshold.debt)}
            sub={`${belowThreshold.positions} positions below HF 1.1`}
            accentColor={belowThreshold.debt > 2_000_000 ? "#FC5457" : belowThreshold.debt > 0 ? "#F59E0B" : "#32EEE2"}
            tooltip="Total outstanding debt across all positions with HF below 1.1 — the total value liquidators can act on right now."
          />

          <AdvKpi
            label="Wallets at Risk / Active"
            value={`${belowThreshold.positions} / ${activeCount}`}
            sub={`${activeCount > 0 ? ((belowThreshold.positions / activeCount) * 100).toFixed(1) : "0.0"}% of wallets at risk`}
            accentColor={belowThreshold.positions > 0 ? "#FC5457" : "#32EEE2"}
            tooltip="Wallets with HF below 1.1 (at risk) vs total active wallets on the protocol. High ratio = widespread risk across user base."
          />

          <AdvKpi
            label="Average HF"
            value={protocolOverview.avgHealthFactor.toFixed(2)}
            sub="Across all open positions"
            sparkData={avgHFSparkline}
            sparkColor={cc.electric}
            tooltip="Simple average health factor across all open positions. A declining number signals growing protocol-wide risk."
          />

          <AdvKpi
            label="Total Collateral at Risk"
            value={formatUsd(protocolOverview.collateralAtRisk.value)}
            sub={`${protocolOverview.collateralAtRisk.percentOfTVL.toFixed(1)}% of protocol TVL`}
            accentColor={protocolOverview.collateralAtRisk.percentOfTVL > 10 ? "#FC5457" : protocolOverview.collateralAtRisk.percentOfTVL > 5 ? "#F59E0B" : "#949494"}
            tooltip="Total USD value of collateral backing positions with HF below 1.5 — the absolute dollar amount of capital exposed to liquidation risk."
          />

          <AdvKpi
            label="Average Leverage"
            value={`${avgLeverage.toFixed(2)}×`}
            sub={`Across ${formatNumber(totalPositions)} active positions`}
            accentColor={avgLeverage > 6 ? "#FC5457" : avgLeverage > 4 ? "#F59E0B" : "#949494"}
            tooltip="Weighted average leverage across all open positions. Higher average means the protocol is more sensitive to price moves — a rising average is a systemic risk signal."
          />

        </div>
      </section>

      {/* ── SECTION 2: ALL POSITIONS MONITOR ────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-vgray-400">All Positions Monitor</h2>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-electric-50 text-electric-700 border border-electric-200 text-[10px] font-bold uppercase tracking-wide">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-electric-500" />
              Stellar (Soroban)
            </span>
          </div>
        </div>

        {/* Tabs */}
        <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna overflow-hidden">
          <div className="flex border-b border-vgray-100">
            {([
              { id: "hf", label: "Health Factor" },
              { id: "pnl", label: "Current PnL" },
              { id: "leverage", label: "Leverage Exposure" },
            ] as const).map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={cn("flex items-center gap-1.5 px-5 py-3 text-[11px] font-semibold border-b-2 transition-colors",
                  activeTab === tab.id
                    ? "border-violet-500 text-violet-600 bg-violet-50/50"
                    : "border-transparent text-vgray-400 hover:text-vgray-600 hover:bg-vgray-50/50"
                )}>
                {tab.id === "hf" && <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 11S1 7.5 1 4.5a2.5 2.5 0 015 0 2.5 2.5 0 015 0C11 7.5 6.5 11 6.5 11z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>}
                {tab.id === "pnl" && <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="1" y="7" width="2.5" height="5" rx="0.5" fill="currentColor"/><rect x="5.25" y="4" width="2.5" height="8" rx="0.5" fill="currentColor"/><rect x="9.5" y="1" width="2.5" height="11" rx="0.5" fill="currentColor"/></svg>}
                {tab.id === "leverage" && <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 1L8 5.5H12.5L9 8.5L10.5 13L6.5 10L2.5 13L4 8.5L0.5 5.5H5L6.5 1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>}
                {tab.label}
              </button>
            ))}
            <div className="flex-1 flex items-center justify-end px-4">
              <span className="text-[10px] text-vgray-400">{displayPositions.length} positions</span>
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-[11px] min-w-[900px]">
              <thead>
                <tr className="border-b border-vgray-100 bg-vgray-50/50">
                  {activeTab === "hf" && <>
                    <th className="pl-3 pr-1 py-2.5 w-7" />
                    <th className="px-3 py-2.5 text-left font-semibold text-vgray-400 w-8">#</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-vgray-400">Wallet</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-vgray-400">Health Factor</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-vgray-400">HF Trend</th>
                    <th className="px-3 py-2.5 text-right font-semibold text-vgray-400">Total Debt</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-vgray-400">Margin Composition</th>
                    <th className="px-3 py-2.5 text-right font-semibold text-vgray-400">Track Tokens</th>
                    <th className="px-3 py-2.5 text-center font-semibold text-vgray-400">Leverage</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-vgray-400">Protocol</th>
                    <th className="px-3 py-2.5 text-right font-semibold text-vgray-400">Liq. Distance</th>
                    <th className="px-3 py-2.5 text-center font-semibold text-vgray-400">Status</th>
                  </>}
                  {activeTab === "pnl" && <>
                    <th className="pl-3 pr-1 py-2.5 w-7" />
                    <th className="px-3 py-2.5 text-left font-semibold text-vgray-400 w-8">#</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-vgray-400">Wallet</th>
                    <th className="px-3 py-2.5 text-right font-semibold text-vgray-400">Current PnL</th>
                    <th className="px-3 py-2.5 text-right font-semibold text-vgray-400">PnL %</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-vgray-400">PnL Trend</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-vgray-400">Open Since</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-vgray-400">Health Factor</th>
                    <th className="px-3 py-2.5 text-center font-semibold text-vgray-400">Leverage</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-vgray-400">Protocol</th>
                    <th className="px-3 py-2.5 text-right font-semibold text-vgray-400">Total Debt</th>
                  </>}
                  {activeTab === "leverage" && <>
                    <th className="pl-3 pr-1 py-2.5 w-7" />
                    <th className="px-3 py-2.5 text-left font-semibold text-vgray-400 w-8">#</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-vgray-400">Wallet</th>
                    <th className="px-3 py-2.5 text-center font-semibold text-vgray-400">Leverage</th>
                    <th className="px-3 py-2.5 text-right font-semibold text-vgray-400">Break-Even Move</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-vgray-400">Health Factor</th>
                    <th className="px-3 py-2.5 text-right font-semibold text-vgray-400">Track Token %</th>
                    <th className="px-3 py-2.5 text-right font-semibold text-vgray-400">Own Collateral</th>
                    <th className="px-3 py-2.5 text-right font-semibold text-vgray-400">Borrowed</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-vgray-400">Protocol</th>
                    <th className="px-3 py-2.5 text-center font-semibold text-vgray-400">Status</th>
                  </>}
                </tr>
              </thead>
              <tbody>
                {displayPositions.map((pos, idx) => {
                  const status = getStatus(pos.healthFactor);
                  const isExpanded = expandedRow === pos.address;
                  const ownCollateral = Math.floor(pos.totalDebt / pos.leverage);
                  const trackTokenPct = Math.round((pos.breakdown.trackTokens / pos.marginValue) * 100);
                  const breakEvenMove = pos.distanceToLiquidation;

                  return (
                    <>
                      <tr
                        key={pos.address}
                        onClick={() => setExpandedRow(isExpanded ? null : pos.address)}
                        className={cn(
                          "border-b border-vgray-100/60 cursor-pointer transition-colors select-none",
                          isExpanded ? "bg-violet-50/40" : rowBg(pos.healthFactor),
                          !isExpanded && "hover:bg-vgray-50/50"
                        )}
                      >
                        {/* Chevron */}
                        <td className="pl-3 pr-1 py-2.5 text-vgray-300 w-7">
                          <svg
                            width="13" height="13" viewBox="0 0 13 13" fill="none"
                            className={cn("transition-transform duration-200", isExpanded ? "rotate-90 text-violet-500" : "")}
                          >
                            <path d="M4.5 3L8 6.5L4.5 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </td>

                        {/* # index */}
                        <td className="px-3 py-2.5 text-vgray-400 font-mono">{idx + 1}</td>

                        {/* Common: Wallet */}
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-vgray-700">{pos.address}</span>
                            <ChainBadge chain={pos.chain} />
                          </div>
                        </td>

                        {activeTab === "hf" && <>
                          <td className="px-3 py-2.5">
                            <span className="font-bold font-mono text-sm" style={{ color: hfColor(pos.healthFactor) }}>
                              {pos.healthFactor.toFixed(2)}
                            </span>
                          </td>
                          <td className="px-3 py-2.5">
                            <MiniSparkline data={pos.hfTrend} color={hfColor(pos.healthFactor)} width={52} height={20} />
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-vgray-700">{formatUsd(pos.totalDebt)}</td>
                          <td className="px-3 py-2.5">
                            <MarginBar breakdown={pos.breakdown} total={pos.marginValue} />
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-rose-600">
                            {pos.breakdown.trackTokens > 0 ? formatUsd(pos.breakdown.trackTokens) : "—"}
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            <span className="font-bold font-mono text-xs px-1.5 py-0.5 rounded" style={{ background: leverageColor(pos.leverage.toString()) + "20", color: leverageColor(pos.leverage.toString()) }}>
                              {pos.leverage}x
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-vgray-600">{pos.primaryProtocol}</td>
                          <td className="px-3 py-2.5 text-right font-mono">
                            <span style={{ color: breakEvenMove < 5 ? "#FC5457" : breakEvenMove < 15 ? "#F59E0B" : "#32EEE2" }}>
                              {breakEvenMove.toFixed(1)}%
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            <span className={cn("text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide", statusStyle(pos.healthFactor))}>
                              {status}
                            </span>
                          </td>
                        </>}

                        {activeTab === "pnl" && <>
                          <td className="px-3 py-2.5 text-right">
                            <span className={cn("font-bold font-mono text-sm", pos.currentPnL < 0 ? "text-imperial-600" : "text-electric-700")}>
                              {pos.currentPnL < 0 ? "-" : "+"}{formatUsd(Math.abs(pos.currentPnL))}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <span className={cn("font-mono text-xs", pos.pnlPercent < 0 ? "text-imperial-500" : "text-electric-600")}>
                              {pos.pnlPercent > 0 ? "+" : ""}{pos.pnlPercent.toFixed(1)}%
                            </span>
                          </td>
                          <td className="px-3 py-2.5">
                            <MiniSparkline data={pos.pnlTrend} color={pos.currentPnL < 0 ? "#FC5457" : "#32EEE2"} width={52} height={20} />
                          </td>
                          <td className="px-3 py-2.5 text-vgray-500">{formatTimeAgo(pos.openSince)}</td>
                          <td className="px-3 py-2.5">
                            <span className="font-bold font-mono" style={{ color: hfColor(pos.healthFactor) }}>{pos.healthFactor.toFixed(2)}</span>
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            <span className="font-bold font-mono text-xs px-1.5 py-0.5 rounded" style={{ background: leverageColor(pos.leverage.toString()) + "20", color: leverageColor(pos.leverage.toString()) }}>
                              {pos.leverage}x
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-vgray-600">{pos.primaryProtocol}</td>
                          <td className="px-3 py-2.5 text-right font-mono text-vgray-700">{formatUsd(pos.totalDebt)}</td>
                        </>}

                        {activeTab === "leverage" && <>
                          <td className="px-3 py-2.5 text-center">
                            <span className="font-bold font-mono text-sm px-2 py-0.5 rounded-r2" style={{ background: leverageColor(pos.leverage.toString()) + "18", color: leverageColor(pos.leverage.toString()) }}>
                              {pos.leverage}x
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <span className="font-mono font-semibold" style={{ color: breakEvenMove < 5 ? "#FC5457" : breakEvenMove < 15 ? "#F59E0B" : "#32EEE2" }}>
                              -{breakEvenMove.toFixed(1)}%
                            </span>
                          </td>
                          <td className="px-3 py-2.5">
                            <span className="font-bold font-mono" style={{ color: hfColor(pos.healthFactor) }}>{pos.healthFactor.toFixed(2)}</span>
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <span className={cn("font-mono text-xs", trackTokenPct > 50 ? "text-rose-600 font-semibold" : "text-vgray-500")}>
                              {trackTokenPct}%
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-vgray-600">{formatUsd(ownCollateral)}</td>
                          <td className="px-3 py-2.5 text-right font-mono text-vgray-700">{formatUsd(pos.totalDebt)}</td>
                          <td className="px-3 py-2.5 text-vgray-600">{pos.primaryProtocol}</td>
                          <td className="px-3 py-2.5 text-center">
                            <span className={cn("text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide", statusStyle(pos.healthFactor))}>
                              {status}
                            </span>
                          </td>
                        </>}
                      </tr>

                      {/* Expanded Row Detail */}
                      {isExpanded && (
                        <tr key={`${pos.address}-detail`} className="border-b-2 border-violet-100">
                          <td colSpan={12} className="p-0">
                            <div className="px-5 py-4 bg-violet-50/30 border-l-2 border-violet-400">

                              {/* Margin Breakdown */}
                              <p className="text-[9px] font-bold uppercase tracking-widest text-violet-500 mb-3">Margin Breakdown</p>
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                                {[
                                  { label: "Cash / Collateral", val: pos.breakdown.cash, color: "#949494" },
                                  { label: "aTokens (Lending)", val: pos.breakdown.aTokens, color: "#32EEE2" },
                                  { label: "LP Tokens (AMM)", val: pos.breakdown.lpTokens, color: "#703AE6" },
                                  { label: "Track Tokens (Perp)", val: pos.breakdown.trackTokens, color: "#FC5457" },
                                ].map(d => (
                                  <div key={d.label} className="flex items-center gap-2 bg-surface rounded-r2 px-3 py-2 border border-vgray-100">
                                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: d.color }} />
                                    <div>
                                      <p className="text-[8px] text-vgray-400 uppercase tracking-wide">{d.label}</p>
                                      <p className="text-[11px] font-bold font-mono text-vgray-700">{formatUsd(d.val)}</p>
                                      <p className="text-[8px] text-vgray-400">{((d.val / pos.marginValue) * 100).toFixed(1)}% of margin</p>
                                    </div>
                                  </div>
                                ))}
                              </div>

                              {/* Position Stats */}
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                                {[
                                  { label: "Liquidation Price (XLM)", val: `$${pos.liquidationPrice.toFixed(4)}` },
                                  { label: "Distance to Liquidation", val: `${pos.distanceToLiquidation.toFixed(1)}%` },
                                  { label: "Margin Buffer", val: `${((pos.marginValue / pos.totalDebt - 1) * 100).toFixed(1)}%` },
                                  { label: "Open Since", val: formatTimeAgo(pos.openSince) },
                                ].map(d => (
                                  <div key={d.label} className="bg-surface rounded-r2 px-3 py-2 border border-vgray-100">
                                    <p className="text-[8px] text-vgray-400 uppercase tracking-wide mb-0.5">{d.label}</p>
                                    <p className="text-[11px] font-bold font-mono text-vgray-700">{d.val}</p>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Table footer */}
          <div className="px-5 py-3 border-t border-vgray-100 bg-vgray-50/30 flex items-center justify-between">
            <p className="text-[10px] text-vgray-400">Click any row to expand margin composition details · Sorted by {activeTab === "hf" ? "Health Factor ↑" : activeTab === "pnl" ? "PnL (loss first) ↑" : "Leverage ↓"}</p>
            <div className="flex items-center gap-3 text-[9px] text-vgray-400">
              <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-sm bg-imperial-50 border border-imperial-200" />Liquidatable</div>
              <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-sm bg-amber-50 border border-amber-200" />Critical</div>
              <div className="flex items-center gap-1.5 ml-2 text-[9px] text-vgray-400">
                <span className="w-2 h-2 rounded-sm" style={{ background: "#FC5457" }} />Track
                <span className="w-2 h-2 rounded-sm" style={{ background: "#703AE6" }} />LP
                <span className="w-2 h-2 rounded-sm" style={{ background: "#32EEE2" }} />aToken
                <span className="w-2 h-2 rounded-sm" style={{ background: "#949494" }} />Cash
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── SECTION 3: RISK DISTRIBUTION INTELLIGENCE ───────────────────── */}
      <section className="space-y-3">
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-vgray-400">Risk Distribution Intelligence</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* HF Distribution */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-5">
            <div className="flex items-center gap-1.5 mb-1">
              <p className="text-xs font-semibold text-vgray-500 uppercase tracking-wide">HF Distribution — Debt Weighted</p>
              <InfoTooltip text="Debt-weighted exposure by health factor band. Positions left of the 1.1 threshold (red) are currently liquidatable." />
            </div>
            <p className="text-[10px] text-vgray-400 mb-3">Total debt exposure ($) per HF band — click bar to filter positions table</p>
            <div className="mb-2 flex items-center gap-2">
              <div className="w-0.5 h-16 bg-imperial-500 rounded" />
              <span className="text-[9px] text-imperial-600 font-semibold">← Liquidation threshold (HF 1.1)</span>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={hfDistribution} barSize={32}>
                <XAxis dataKey="range" tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} tickFormatter={v => formatUsd(Number(v))} />
                <Tooltip contentStyle={cc.tooltip} formatter={(v) => [formatUsd(Number(v ?? 0)), "Debt exposure"]} />
                <Bar dataKey="totalDebtUsd" radius={[4, 4, 0, 0]}>
                  {hfDistribution.map((entry, i) => (
                    <Cell key={i} fill={hfBandColor(entry.range)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Leverage Distribution */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-5">
            <div className="flex items-center gap-1.5 mb-1">
              <p className="text-xs font-semibold text-vgray-500 uppercase tracking-wide">Leverage Distribution — Debt Weighted</p>
              <InfoTooltip text="Total debt ($) at each leverage bucket. High concentration at 8–10x means even a small price move can trigger mass liquidations." />
            </div>
            <p className="text-[10px] text-vgray-400 mb-4">Total debt ($) per leverage range — higher leverage = more sensitive to price moves</p>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={leverageDistribution} barSize={28}>
                <XAxis dataKey="range" tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: cc.axisText }} axisLine={false} tickLine={false} tickFormatter={v => formatUsd(Number(v))} />
                <Tooltip contentStyle={cc.tooltip} formatter={(v, name) => [name === "debtUsd" ? formatUsd(Number(v ?? 0)) : formatNumber(Number(v ?? 0)), name === "debtUsd" ? "Debt" : "Positions"]} />
                <Bar dataKey="debtUsd" radius={[4, 4, 0, 0]}>
                  {leverageDistribution.map((entry, i) => (
                    <Cell key={i} fill={leverageColor(entry.range)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Bad Debt Meter + Insurance */}
          <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-5 lg:col-span-2">
            <div className="flex items-center gap-1.5 mb-3">
              <p className="text-xs font-semibold text-vgray-500 uppercase tracking-wide">Bad Debt & Insurance Fund Coverage</p>
              <InfoTooltip text="Visual breakdown of current bad debt, at-risk positions, and the insurance fund's ability to cover them." />
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <p className="text-[10px] text-vgray-400 mb-3">Protocol debt risk exposure vs. insurance fund</p>
                <BadDebtMeter badDebt={activeBadDebt} atRisk={atRiskExposure} buffer={bufferZoneDebt} insuranceFund={INSURANCE_FUND} />
              </div>
              <div>
                <p className="text-[10px] text-vgray-400 mb-3">Margin composition across all positions</p>
                <div className="space-y-2.5">
                  {[
                    { label: "Track Tokens (External Perps)", val: marginComposition.trackTokens.valueUsd, pct: marginComposition.trackTokens.percent, color: "#FC5457" },
                    { label: "LP Tokens (AMM Positions)", val: marginComposition.lpTokens.valueUsd, pct: marginComposition.lpTokens.percent, color: "#703AE6" },
                    { label: "aTokens (Lending Protocol)", val: marginComposition.aTokens.valueUsd, pct: marginComposition.aTokens.percent, color: "#32EEE2" },
                    { label: "Cash / Collateral", val: marginComposition.cash.valueUsd, pct: marginComposition.cash.percent, color: "#949494" },
                  ].map(m => (
                    <div key={m.label} className="flex items-center gap-3">
                      <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: m.color }} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="text-[10px] text-vgray-600 truncate">{m.label}</span>
                          <span className="text-[10px] font-mono font-semibold text-vgray-700 ml-2 flex-shrink-0">{formatUsd(m.val)}</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-vgray-100 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${m.pct}%`, background: m.color }} />
                        </div>
                      </div>
                      <span className="text-[10px] font-mono text-vgray-400 w-8 text-right flex-shrink-0">{m.pct.toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── SECTION 4: SIMULATION LAUNCH HUB ───────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[10px] font-semibold uppercase tracking-wider text-vgray-400">Advanced Risk Explorer — Stress Testing Hub</h2>
            <p className="text-xs text-vgray-400 mt-0.5">Simulate extreme scenarios to understand protocol solvency under stress conditions</p>
          </div>
          <span className="text-[10px] font-semibold text-vgray-400 bg-vgray-50 px-3 py-1.5 rounded-r4 border border-vgray-100">6 simulations</span>
        </div>

        {/* All simulation cards in one grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {SIM_CARDS.map(s => <SimCard key={s.route} sim={s} />)}
        </div>
      </section>

    </div>
  );
}
