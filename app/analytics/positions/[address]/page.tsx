"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { formatUsd, cn, hfColor } from "@/lib/analytics/utils";
import { PageHeader, PageHeaderMeta } from "@/components/analytics/PageHeader";
import CoinIcon from "@/components/analytics/ui/CoinIcon";
import InfoTooltip from "@/components/analytics/ui/InfoTooltip";

// ─────────────────────────────────────────────────────────────────────────────
// SEEDED RANDOM
// ─────────────────────────────────────────────────────────────────────────────
const dr = (seed: number) => {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
};

function hashAddr(addr: string): number {
  let h = 5381;
  for (let i = 0; i < addr.length; i++) {
    h = Math.imul(31, h) + addr.charCodeAt(i) | 0;
  }
  return Math.abs(h);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const PROTOCOLS = ["Avantis", "Hyperliquid", "Morpho", "Uniswap", "Aerodrome", "Aquarius", "Pendle", "GMX"];
const ASSETS = ["ETH", "WBTC", "weETH", "USDC", "USDT"];
const POS_TYPES = ["Long", "Short", "LP", "Lend"];

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────
interface OpenPosition {
  id: number;
  protocol: string;
  asset: string;
  type: string;
  leverage: number;
  collateral: number;
  debt: number;
  hf: number;
  pnl: number;
  pnlPct: number;
  openDaysAgo: number;
}

interface DayPnL {
  date: Date;
  pnl: number;
  active: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA GENERATOR
// ─────────────────────────────────────────────────────────────────────────────
function generateUserData(address: string) {
  const seed = hashAddr(address);
  const posCount = 2 + Math.floor(dr(seed) * 3); // 2–4 positions

  const positions: OpenPosition[] = Array.from({ length: posCount }, (_, i) => {
    const s = seed + i * 1337;
    const leverage = Math.round((1.5 + dr(s + 4) * 8.5) * 10) / 10;
    const collateral = Math.floor(20_000 + dr(s + 5) * 400_000);
    const hf = Math.round((0.9 + dr(s + 6) * 2.6) * 100) / 100;
    const debt = Math.floor(collateral * (leverage - 1));
    const pnlPct = (dr(s + 9) - 0.42) * 0.9;
    const pnl = Math.round(collateral * pnlPct);

    return {
      id: i,
      protocol: PROTOCOLS[Math.floor(dr(s + 1) * PROTOCOLS.length)],
      asset: ASSETS[Math.floor(dr(s + 2) * ASSETS.length)],
      type: POS_TYPES[Math.floor(dr(s + 3) * POS_TYPES.length)],
      leverage,
      collateral,
      debt,
      hf,
      pnl,
      pnlPct,
      openDaysAgo: Math.max(1, Math.floor(dr(s + 10) * 89)),
    };
  });

  const totalCollateral = positions.reduce((a, p) => a + p.collateral, 0);
  const totalDebt = positions.reduce((a, p) => a + p.debt, 0);
  const avgHF = positions.reduce((a, p) => a + p.hf, 0) / positions.length;
  const totalPnL = positions.reduce((a, p) => a + p.pnl, 0);

  // 91 days P&L (13 weeks × 7 days)
  const today = new Date(2026, 2, 31); // March 31 2026 — matches currentDate
  const calendarData: DayPnL[] = Array.from({ length: 91 }, (_, i) => {
    const s2 = seed + (90 - i) * 77 + 9999;
    const date = new Date(today);
    date.setDate(today.getDate() - (90 - i));
    const active = dr(s2) > 0.28;
    const pnl = active ? Math.round((dr(s2 + 1) - 0.42) * 14000) : 0;
    return { date, pnl, active };
  });

  return { positions, totalCollateral, totalDebt, avgHF, totalPnL, calendarData };
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS HELPER
// ─────────────────────────────────────────────────────────────────────────────
function getStatus(hf: number) {
  if (hf < 1.0) return { label: "Liquidatable", cls: "bg-red-50 text-red-600 border-red-200" };
  if (hf < 1.1) return { label: "Critical",     cls: "bg-rose-50 text-rose-600 border-rose-200" };
  if (hf < 1.2) return { label: "Warning",      cls: "bg-violet-50 text-violet-600 border-violet-200" };
  if (hf < 1.5) return { label: "Caution",      cls: "bg-amber-50 text-amber-600 border-amber-200" };
  return           { label: "Safe",           cls: "bg-teal-50 text-teal-600 border-teal-200" };
}

// ─────────────────────────────────────────────────────────────────────────────
// P&L CALENDAR HEATMAP
// ─────────────────────────────────────────────────────────────────────────────
function PnLCalendar({ data }: { data: DayPnL[] }) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // Group into 13 weeks (columns of 7)
  const weeks: DayPnL[][] = [];
  for (let i = 0; i < data.length; i += 7) {
    weeks.push(data.slice(i, i + 7));
  }

  const maxAbs = Math.max(...data.filter(d => d.active).map(d => Math.abs(d.pnl)), 1);

  const getCellColor = (day: DayPnL): string => {
    if (!day.active) return "var(--color-vgray-50, #F8F8FC)";
    const t = Math.min(Math.abs(day.pnl) / maxAbs, 1);
    if (day.pnl > 0) {
      // light emerald → deep green
      const r = Math.round(220 - t * 180);
      const g = Math.round(240 - t * 40);
      const b = Math.round(200 - t * 160);
      return `rgb(${r},${g},${b})`;
    } else {
      // light rose → deep red
      const r = Math.round(255 - t * 30);
      const g = Math.round(220 - t * 170);
      const b = Math.round(220 - t * 190);
      return `rgb(${r},${g},${b})`;
    }
  };

  // Build month label positions
  const monthLabels: { label: string; weekIdx: number }[] = [];
  weeks.forEach((week, wi) => {
    const first = week[0];
    if (!first) return;
    const monthStr = first.date.toLocaleString("en-US", { month: "short" });
    if (!monthLabels.length || monthLabels[monthLabels.length - 1].label !== monthStr) {
      monthLabels.push({ label: monthStr, weekIdx: wi });
    }
  });

  const DAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"];

  return (
    <div className="space-y-2 overflow-x-auto">
      {/* Month labels row */}
      <div className="flex gap-1 ml-7">
        {weeks.map((_, wi) => {
          const ml = monthLabels.find(m => m.weekIdx === wi);
          return (
            <div key={wi} className="w-4 flex-shrink-0 text-[9px] text-vgray-400 font-medium">
              {ml ? ml.label : ""}
            </div>
          );
        })}
      </div>

      <div className="flex gap-1">
        {/* Day-of-week labels */}
        <div className="flex flex-col gap-1 mr-1 flex-shrink-0">
          {DAY_INITIALS.map((d, i) => (
            <div key={i} className="w-5 h-4 flex items-center justify-end text-[9px] text-vgray-300 pr-0.5">
              {i % 2 === 0 ? d : ""}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-1 flex-shrink-0">
            {Array.from({ length: 7 }, (_, di) => {
              const day = week[di];
              const idx = wi * 7 + di;
              if (!day) return <div key={di} className="w-4 h-4" />;
              const isHovered = hoveredIdx === idx;

              return (
                <div
                  key={di}
                  className="relative w-4 h-4 rounded-[3px] cursor-pointer transition-transform duration-100 hover:scale-125 hover:z-10"
                  style={{ backgroundColor: getCellColor(day) }}
                  onMouseEnter={() => setHoveredIdx(idx)}
                  onMouseLeave={() => setHoveredIdx(null)}
                >
                  {isHovered && (
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 pointer-events-none">
                      <div className="bg-vgray-800 text-white text-[10px] rounded-lg px-2.5 py-1.5 whitespace-nowrap shadow-xl border border-vgray-700">
                        <div className="text-vgray-300 mb-0.5">
                          {day.date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                        </div>
                        {day.active ? (
                          <div className={cn("font-semibold font-mono", day.pnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
                            {day.pnl >= 0 ? "+" : ""}{formatUsd(day.pnl)}
                          </div>
                        ) : (
                          <div className="text-vgray-400 text-[9px]">No activity</div>
                        )}
                      </div>
                      {/* Arrow */}
                      <div className="w-2 h-2 bg-vgray-800 border-r border-b border-vgray-700 rotate-45 mx-auto -mt-1" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 pt-1">
        <span className="text-[9px] text-vgray-400">Less</span>
        <div className="flex gap-0.5 items-center">
          {[0.1, 0.35, 0.6, 0.85, 1.0].map((t, i) => {
            const r = Math.round(255 - t * 30); const g = Math.round(220 - t * 170); const b = Math.round(220 - t * 190);
            return <div key={i} className="w-3.5 h-3.5 rounded-[2px]" style={{ backgroundColor: `rgb(${r},${g},${b})` }} />;
          })}
        </div>
        <span className="text-[9px] text-vgray-400 mr-2">Loss</span>
        <div className="flex gap-0.5 items-center">
          {[0.1, 0.35, 0.6, 0.85, 1.0].map((t, i) => {
            const r = Math.round(220 - t * 180); const g = Math.round(240 - t * 40); const b = Math.round(200 - t * 160);
            return <div key={i} className="w-3.5 h-3.5 rounded-[2px]" style={{ backgroundColor: `rgb(${r},${g},${b})` }} />;
          })}
        </div>
        <span className="text-[9px] text-vgray-400">Profit</span>
        <div className="ml-1 w-3.5 h-3.5 rounded-[2px]" style={{ backgroundColor: "var(--color-vgray-50, #F8F8FC)", border: "1px solid #E5E5EF" }} />
        <span className="text-[9px] text-vgray-400">No activity</span>
        <span className="text-[9px] text-vgray-400">More</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────────────────────────────────────
export default function UserPortfolioPage() {
  const params = useParams();
  const router = useRouter();
  const rawAddress = typeof params.address === "string" ? decodeURIComponent(params.address) : "";
  const timeStr = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  const isBase = rawAddress.startsWith("0x");

  const { positions, totalCollateral, totalDebt, avgHF, totalPnL, calendarData } = useMemo(
    () => generateUserData(rawAddress),
    [rawAddress]
  );

  const kpiCards = [
    {
      label: "Total Collateral",
      value: formatUsd(totalCollateral),
      sub: `${positions.length} open position${positions.length !== 1 ? "s" : ""}`,
    },
    {
      label: "Total Debt",
      value: formatUsd(totalDebt),
      sub: "Outstanding borrows",
    },
    {
      label: "Avg Health Factor",
      value: avgHF.toFixed(3),
      sub: "Across all positions",
      valueColor: hfColor(avgHF),
    },
    {
      label: "Total PnL",
      value: (totalPnL >= 0 ? "+" : "") + formatUsd(totalPnL),
      sub: totalPnL >= 0 ? "Net profit" : "Net loss",
      valueColor: totalPnL >= 0 ? "#10b981" : "#f43f5e",
    },
    {
      label: "Network",
      value: isBase ? "Base" : "Stellar",
      sub: isBase ? "EVM chain" : "Layer-1 chain",
    },
  ];

  return (
    <div className="p-6 w-full max-w-[1600px] mx-auto space-y-8">
      {/* Back */}
      <button
        onClick={() => router.back()}
        className="flex items-center gap-1.5 text-[11px] text-vgray-400 hover:text-vgray-600 transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M9 3L5 7L9 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back to Positions
      </button>

      <PageHeader
        title="Portfolio"
        subtitle={rawAddress}
        meta={<PageHeaderMeta timeLabel={timeStr} />}
      />

      {/* ── KPI SUMMARY ─────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-vgray-400">Summary</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {kpiCards.map(card => (
            <div key={card.label} className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-5">
              <p className="text-[11px] font-semibold text-vgray-500 uppercase tracking-wide mb-1.5">{card.label}</p>
              <p
                className="text-xl sm:text-2xl font-bold font-mono tabular-nums"
                style={{ color: card.valueColor ?? "var(--color-vgray-800, #1E1E2D)" }}
              >
                {card.value}
              </p>
              <p className="text-xs text-vgray-400 mt-1.5">{card.sub}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── OPEN POSITIONS TABLE ─────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-vgray-400">Open Positions</h2>
        <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-vgray-50 border-b border-vgray-100">
                  <th className="px-4 py-3 text-left font-semibold text-vgray-400 w-8">#</th>
                  <th className="px-4 py-3 text-left font-semibold text-vgray-400">Protocol</th>
                  <th className="px-4 py-3 text-left font-semibold text-vgray-400">Asset</th>
                  <th className="px-4 py-3 text-left font-semibold text-vgray-400">Type</th>
                  <th className="px-4 py-3 text-right font-semibold text-vgray-400">Collateral</th>
                  <th className="px-4 py-3 text-right font-semibold text-vgray-400">Debt</th>
                  <th className="px-4 py-3 text-center font-semibold text-vgray-400">Leverage</th>
                  <th className="px-4 py-3 text-right font-semibold text-vgray-400">Health Factor</th>
                  <th className="px-4 py-3 text-right font-semibold text-vgray-400">PnL</th>
                  <th className="px-4 py-3 text-center font-semibold text-vgray-400">Opened</th>
                  <th className="px-4 py-3 text-center font-semibold text-vgray-400">Status</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((pos, i) => {
                  const status = getStatus(pos.hf);
                  return (
                    <tr key={pos.id} className="border-t border-vgray-100 hover:bg-vgray-50/50 transition-colors">
                      <td className="px-4 py-3 font-mono text-vgray-300">{i + 1}</td>
                      <td className="px-4 py-3 font-medium text-vgray-700">{pos.protocol}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <CoinIcon symbol={pos.asset} size={14} />
                          <span className="font-medium text-vgray-700">{pos.asset}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-vgray-50 border border-vgray-100 text-vgray-500">
                          {pos.type}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-vgray-700">{formatUsd(pos.collateral)}</td>
                      <td className="px-4 py-3 text-right font-mono text-vgray-700">{formatUsd(pos.debt)}</td>
                      <td className="px-4 py-3 text-center font-mono font-semibold text-vgray-700">{pos.leverage.toFixed(1)}×</td>
                      <td className="px-4 py-3 text-right">
                        <span className="font-mono font-semibold" style={{ color: hfColor(pos.hf) }}>{pos.hf.toFixed(3)}</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div>
                          <div className={cn("font-mono font-semibold", pos.pnl >= 0 ? "text-emerald-500" : "text-rose-500")}>
                            {pos.pnl >= 0 ? "+" : ""}{formatUsd(pos.pnl)}
                          </div>
                          <div className={cn("text-[9px]", pos.pnlPct >= 0 ? "text-emerald-400" : "text-rose-400")}>
                            {pos.pnlPct >= 0 ? "+" : ""}{(pos.pnlPct * 100).toFixed(1)}%
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center text-[11px] text-vgray-400">
                        {pos.openDaysAgo === 1 ? "1d ago" : `${pos.openDaysAgo}d ago`}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={cn("text-[10px] font-semibold px-2 py-0.5 rounded-full border", status.cls)}>
                          {status.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2.5 border-t border-vgray-100 bg-vgray-50/50">
            <span className="text-[10px] text-vgray-400">{positions.length} active positions</span>
          </div>
        </div>
      </section>

      {/* ── DAILY P&L CALENDAR ───────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center gap-1.5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-vgray-400">Daily P&L Calendar</h2>
          <InfoTooltip text="Daily profit and loss over the past 90 days. Green = profitable day, Red = loss day. Intensity shows magnitude. Hover any cell for exact figures." />
        </div>
        <div className="bg-surface rounded-r4 border border-vgray-100 shadow-vanna p-6">
          <p className="text-xs text-vgray-400 mb-5">Last 90 days · Hover a cell to see exact P&L</p>
          <PnLCalendar data={calendarData} />
        </div>
      </section>
    </div>
  );
}
