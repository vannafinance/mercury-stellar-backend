"use client";

import { useMemo, useState } from "react";
import { PageHeader, PageHeaderMeta } from "@/components/analytics/PageHeader";
import InfoTooltip from "@/components/analytics/ui/InfoTooltip";
import { useChartColors } from "@/lib/analytics/theme";
import { formatUsd, formatPercent, hfColor, cn } from "@/lib/analytics/utils";
import {
  generateAdvancedPositions,
  buildCorrelatedGroups,
  analyzeBorrowRateImpact,
  COLLATERAL_TYPE_META,
  type AdvancedPosition,
  type AgeCategory,
  type CollateralType,
  type CorrelatedGroup,
  type BorrowRateImpact,
} from "@/lib/analytics/positions-advanced-data";

const BASE_CHAIN_ID = 8453;
const PAGE_SIZE = 8;

/* ═══════════════════════════════════════════════════════
   Shared tiny components
   ═══════════════════════════════════════════════════════ */

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-r4 border border-vgray-100 bg-surface p-6 shadow-vanna", className)}>
      {children}
    </div>
  );
}

function SectionHeader({ title, subtitle, tooltip }: { title: string; subtitle: string; tooltip?: string }) {
  return (
    <div className="pt-1 pb-3">
      <div className="flex items-center gap-1.5">
        <h2 className="text-base font-bold tracking-tight text-vgray-800">{title}</h2>
        {tooltip && <InfoTooltip size="md" text={tooltip} />}
      </div>
      <p className="text-sm mt-1 text-vgray-500">{subtitle}</p>
    </div>
  );
}

function CollateralBadge({ type }: { type: CollateralType }) {
  const m = COLLATERAL_TYPE_META[type];
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider", m.bgClass)}>
      {m.label}
    </span>
  );
}

function AgeBadge({ age }: { age: AgeCategory }) {
  const styles: Record<AgeCategory, string> = {
    new: "bg-imperial-100 text-imperial-500",
    recent: "bg-amber-100 text-amber-600",
    established: "bg-electric-100 text-electric-600",
  };
  const labels: Record<AgeCategory, string> = {
    new: "< 24h",
    recent: "1-7d",
    established: "> 7d",
  };
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider", styles[age])}>
      {labels[age]}
    </span>
  );
}

function VelocityIndicator({ velocity }: { velocity: number }) {
  const isNeg = velocity < 0;
  const isZero = Math.abs(velocity) < 0.001;
  const color = isZero ? "text-vgray-400" : isNeg ? "text-imperial-500" : "text-electric-600";
  const arrow = isZero ? "~" : isNeg ? "\u25BC" : "\u25B2";
  return (
    <span className={cn("font-mono text-[11px] font-semibold", color)}>
      {arrow} {Math.abs(velocity).toFixed(4)}/hr
    </span>
  );
}

function ChainBadge({ chain }: { chain: "base" | "stellar" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider",
        chain === "base" ? "bg-[#0052FF]/15 text-[#3b82f6]" : "bg-violet-100 text-violet-400"
      )}
    >
      {chain}
    </span>
  );
}

/* ── Pagination ── */
function usePaged<T>(items: T[], page: number, pageSize: number) {
  return useMemo(() => {
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const start = (safePage - 1) * pageSize;
    return { slice: items.slice(start, start + pageSize), totalPages, safePage };
  }, [items, page, pageSize]);
}

function Pagination({ page, totalPages, total, pageSize, onChange }: {
  page: number; totalPages: number; total: number; pageSize: number; onChange: (p: number) => void;
}) {
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-t border-vgray-100 pt-4 mt-4">
      <p className="text-xs text-vgray-500 tabular-nums">
        {total === 0 ? "No rows" : (
          <>Showing <span className="font-medium text-vgray-700">{start}</span>{" \u2013 "}<span className="font-medium text-vgray-700">{end}</span> of <span className="font-medium text-vgray-700">{total}</span></>
        )}
      </p>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => onChange(Math.max(1, page - 1))} disabled={page <= 1}
          className={cn("px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors",
            page <= 1 ? "border-vgray-100 text-vgray-300 cursor-not-allowed" : "border-vgray-200 text-vgray-700 hover:bg-vgray-50")}>
          Previous
        </button>
        <span className="text-xs text-vgray-500 tabular-nums px-2">Page {page} of {totalPages}</span>
        <button type="button" onClick={() => onChange(Math.min(totalPages, page + 1))} disabled={page >= totalPages}
          className={cn("px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors",
            page >= totalPages ? "border-vgray-100 text-vgray-300 cursor-not-allowed" : "border-vgray-200 text-vgray-700 hover:bg-vgray-50")}>
          Next
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   1. POSITION TABLE — with velocity, distance-to-liq,
      collateral type, age filter
   ═══════════════════════════════════════════════════════ */

type SortKey = "hf" | "velocity" | "distToLiq" | "debt" | "leverage" | "age";
type SortDir = "asc" | "desc";

function PositionsTable({ positions }: { positions: AdvancedPosition[] }) {
  const [page, setPage] = useState(1);
  const [ageFilter, setAgeFilter] = useState<AgeCategory | "all">("all");
  const [collTypeFilter, setCollTypeFilter] = useState<CollateralType | "all">("all");
  const [sortKey, setSortKey] = useState<SortKey>("hf");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const filtered = useMemo(() => {
    let result = positions;
    if (ageFilter !== "all") result = result.filter((p) => p.ageCategory === ageFilter);
    if (collTypeFilter !== "all") result = result.filter((p) => p.collateralType === collTypeFilter);
    return result;
  }, [positions, ageFilter, collTypeFilter]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const dir = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      switch (sortKey) {
        case "hf": return (a.hf - b.hf) * dir;
        case "velocity": return (a.hfVelocity - b.hfVelocity) * dir;
        case "distToLiq": return (a.distToLiqPct - b.distToLiqPct) * dir;
        case "debt": return (a.debt - b.debt) * dir;
        case "leverage": return (a.leverageX - b.leverageX) * dir;
        case "age": return (a.openedAt - b.openedAt) * dir;
        default: return 0;
      }
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  const { slice, totalPages, safePage } = usePaged(sorted, page, PAGE_SIZE);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
    setPage(1);
  };

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return " \u2195";
    return sortDir === "asc" ? " \u2191" : " \u2193";
  };

  const formatAge = (openedAt: number) => {
    const hrs = (Date.now() - openedAt) / (1000 * 60 * 60);
    if (hrs < 1) return `${Math.floor(hrs * 60)}m`;
    if (hrs < 24) return `${Math.floor(hrs)}h`;
    return `${Math.floor(hrs / 24)}d`;
  };

  return (
    <Card>
      <div className="flex items-center gap-1.5 mb-1">
        <h3 className="text-sm font-bold text-vgray-800">All positions</h3>
        <InfoTooltip size="md" text="Enhanced position table with HF velocity (rate of change), distance to liquidation (how much price must drop to hit HF 1.1), collateral type, and position age. Click column headers to sort." />
      </div>
      <p className="text-[10px] text-vgray-500 mb-4">
        Click column headers to sort. Use filters to narrow by age or collateral type.
      </p>

      {/* Filters */}
      <div className="flex flex-wrap gap-4 mb-4">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-vgray-400">Age</span>
          <div className="flex gap-1">
            {(["all", "new", "recent", "established"] as const).map((v) => (
              <button key={v} type="button" onClick={() => { setAgeFilter(v); setPage(1); }}
                className={cn("px-2.5 py-1 rounded-full text-[10px] font-semibold transition-all",
                  ageFilter === v ? "bg-violet-500 text-white" : "bg-vgray-100 text-vgray-500 hover:bg-vgray-200")}>
                {v === "all" ? "All" : v === "new" ? "< 24h" : v === "recent" ? "1-7d" : "> 7d"}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-vgray-400">Collateral</span>
          <div className="flex gap-1">
            {(["all", "aToken", "lpToken", "trackToken", "cash"] as const).map((v) => (
              <button key={v} type="button" onClick={() => { setCollTypeFilter(v); setPage(1); }}
                className={cn("px-2.5 py-1 rounded-full text-[10px] font-semibold transition-all",
                  collTypeFilter === v ? "bg-violet-500 text-white" : "bg-vgray-100 text-vgray-500 hover:bg-vgray-200")}>
                {v === "all" ? "All" : COLLATERAL_TYPE_META[v].label}
              </button>
            ))}
          </div>
        </div>
        <div className="ml-auto text-xs text-vgray-400">
          {filtered.length} positions
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="bg-vgray-50">
              <th className="px-3 py-2 text-left font-semibold text-vgray-500 text-[10px] uppercase tracking-wider">Address</th>
              <th className="px-3 py-2 text-left font-semibold text-vgray-500 text-[10px] uppercase tracking-wider">Asset</th>
              <th className="px-3 py-2 text-left font-semibold text-vgray-500 text-[10px] uppercase tracking-wider">Collateral type</th>
              <th className="px-3 py-2 text-left font-semibold text-vgray-500 text-[10px] uppercase tracking-wider">
                <button type="button" onClick={() => toggleSort("age")} className="hover:text-violet-500 transition-colors">
                  Age{sortIcon("age")}
                </button>
              </th>
              <th className="px-3 py-2 text-right font-semibold text-vgray-500 text-[10px] uppercase tracking-wider">
                <button type="button" onClick={() => toggleSort("debt")} className="hover:text-violet-500 transition-colors">
                  Debt{sortIcon("debt")}
                </button>
              </th>
              <th className="px-3 py-2 text-right font-semibold text-vgray-500 text-[10px] uppercase tracking-wider">Collateral</th>
              <th className="px-3 py-2 text-right font-semibold text-vgray-500 text-[10px] uppercase tracking-wider">
                <button type="button" onClick={() => toggleSort("hf")} className="hover:text-violet-500 transition-colors">
                  HF{sortIcon("hf")}
                </button>
              </th>
              <th className="px-3 py-2 text-right font-semibold text-vgray-500 text-[10px] uppercase tracking-wider">
                <button type="button" onClick={() => toggleSort("velocity")} className="hover:text-violet-500 transition-colors">
                  <span className="flex items-center justify-end gap-1">
                    \u0394HF/hr{sortIcon("velocity")}
                    <InfoTooltip text="Rate of change in health factor per hour. Negative (red \u25BC) means the position is deteriorating. Watch for rapidly declining positions." />
                  </span>
                </button>
              </th>
              <th className="px-3 py-2 text-right font-semibold text-vgray-500 text-[10px] uppercase tracking-wider">
                <button type="button" onClick={() => toggleSort("distToLiq")} className="hover:text-violet-500 transition-colors">
                  <span className="flex items-center justify-end gap-1">
                    Dist. to liq{sortIcon("distToLiq")}
                    <InfoTooltip text="How much the collateral asset price must drop (%) to push HF to 1.1 (liquidation threshold). Lower = closer to liquidation. Negative = already below threshold." />
                  </span>
                </button>
              </th>
              <th className="px-3 py-2 text-right font-semibold text-vgray-500 text-[10px] uppercase tracking-wider">
                <button type="button" onClick={() => toggleSort("leverage")} className="hover:text-violet-500 transition-colors">
                  Leverage{sortIcon("leverage")}
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {slice.map((p, i) => (
              <tr key={p.address + i} className={cn("border-t border-vgray-100 hover:bg-surface-hover transition-colors", i % 2 === 0 ? "bg-surface" : "bg-vgray-50/50")}>
                <td className="px-3 py-2.5 font-mono text-vgray-700">{p.address}</td>
                <td className="px-3 py-2.5 font-mono font-medium text-vgray-800">{p.primaryAsset}</td>
                <td className="px-3 py-2.5"><CollateralBadge type={p.collateralType} /></td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <AgeBadge age={p.ageCategory} />
                    <span className="text-[10px] font-mono text-vgray-400">{formatAge(p.openedAt)}</span>
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-vgray-700">{formatUsd(p.debt)}</td>
                <td className="px-3 py-2.5 text-right font-mono text-vgray-700">{formatUsd(p.collateral)}</td>
                <td className="px-3 py-2.5 text-right font-mono font-semibold" style={{ color: hfColor(p.hf) }}>
                  {p.hf === Infinity ? "\u221E" : p.hf.toFixed(4)}
                </td>
                <td className="px-3 py-2.5 text-right"><VelocityIndicator velocity={p.hfVelocity} /></td>
                <td className="px-3 py-2.5 text-right">
                  <span className={cn("font-mono text-[11px] font-semibold",
                    p.distToLiqPct < 0 ? "text-imperial-500" : p.distToLiqPct < 10 ? "text-rose-500" : p.distToLiqPct < 25 ? "text-amber-500" : "text-electric-600")}>
                    {p.distToLiqPct < 0 ? "BELOW" : `\u2212${p.distToLiqPct.toFixed(1)}%`}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-vgray-700">{p.leverageX === Infinity ? "\u221E" : `${p.leverageX.toFixed(2)}x`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={safePage} totalPages={totalPages} total={sorted.length} pageSize={PAGE_SIZE} onChange={setPage} />
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════
   2. RAPIDLY DETERIORATING — top positions by velocity
   ═══════════════════════════════════════════════════════ */

function RapidlyDeterioratingPanel({ positions }: { positions: AdvancedPosition[] }) {
  const cc = useChartColors();

  const deteriorating = useMemo(() => {
    return [...positions]
      .filter((p) => p.hfVelocity < -0.005)
      .sort((a, b) => a.hfVelocity - b.hfVelocity)
      .slice(0, 8);
  }, [positions]);

  if (deteriorating.length === 0) {
    return (
      <Card>
        <div className="flex items-center gap-1.5 mb-2">
          <h3 className="text-sm font-bold text-vgray-800">Rapidly deteriorating positions</h3>
          <InfoTooltip size="md" text="Positions whose HF is declining fastest. These need immediate attention as they may reach liquidation soon." />
        </div>
        <div className="rounded-lg border border-electric-500/20 bg-electric-500/5 px-4 py-4 text-xs font-semibold text-electric-600 text-center">
          No positions are deteriorating rapidly. All HF trends are stable or improving.
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center gap-1.5 mb-1">
        <h3 className="text-sm font-bold text-vgray-800">Rapidly deteriorating positions</h3>
        <InfoTooltip size="md" text="Positions whose HF is declining fastest per hour. A position at HF 1.3 dropping -0.05/hr will reach liquidation in ~4 hours. These need immediate attention." />
      </div>
      <p className="text-[10px] text-vgray-500 mb-4">
        Sorted by HF velocity (most negative first). Estimated time to HF 1.1 shown.
      </p>
      <div className="space-y-2">
        {deteriorating.map((p, i) => {
          // Estimate hours until HF reaches 1.1
          const hfGap = p.hf - 1.1;
          const hoursToLiq = p.hfVelocity < 0 ? Math.max(0, hfGap / Math.abs(p.hfVelocity)) : Infinity;
          const isUrgent = hoursToLiq < 6;
          const isCritical = hoursToLiq < 2;

          return (
            <div
              key={p.address + i}
              className={cn(
                "flex items-center gap-4 px-4 py-3 rounded-xl border transition-colors",
                isCritical
                  ? "border-imperial-500/30 bg-imperial-500/5"
                  : isUrgent
                    ? "border-amber-500/30 bg-amber-500/5"
                    : "border-vgray-100 bg-surface"
              )}
            >
              <div className="flex-shrink-0 w-6 text-center">
                <span className={cn("text-xs font-bold", isCritical ? "text-imperial-500" : isUrgent ? "text-amber-500" : "text-vgray-400")}>
                  {i + 1}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-mono text-xs text-vgray-700">{p.address}</span>
                  <CollateralBadge type={p.collateralType} />
                  <AgeBadge age={p.ageCategory} />
                </div>
                <div className="flex items-center gap-3 text-[10px]">
                  <span className="text-vgray-400">
                    Debt: <span className="font-mono font-semibold text-vgray-700">{formatUsd(p.debt)}</span>
                  </span>
                  <span className="text-vgray-400">
                    Asset: <span className="font-semibold text-vgray-700">{p.primaryAsset}</span>
                  </span>
                  <span className="text-vgray-400">
                    Leverage: <span className="font-mono font-semibold text-vgray-700">{p.leverageX.toFixed(1)}x</span>
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-4 flex-shrink-0">
                <div className="text-right">
                  <p className="text-[9px] text-vgray-400 uppercase font-semibold">HF</p>
                  <p className="font-mono text-sm font-bold" style={{ color: hfColor(p.hf) }}>{p.hf.toFixed(4)}</p>
                </div>
                <div className="text-right">
                  <p className="text-[9px] text-vgray-400 uppercase font-semibold">\u0394HF/hr</p>
                  <VelocityIndicator velocity={p.hfVelocity} />
                </div>
                <div className="text-right min-w-[72px]">
                  <p className="text-[9px] text-vgray-400 uppercase font-semibold">Time to liq</p>
                  <p className={cn("font-mono text-xs font-bold",
                    isCritical ? "text-imperial-500" : isUrgent ? "text-amber-500" : "text-vgray-600")}>
                    {hoursToLiq === Infinity
                      ? "Safe"
                      : p.hf <= 1.1
                        ? "NOW"
                        : hoursToLiq < 1
                          ? `${Math.floor(hoursToLiq * 60)}m`
                          : `${hoursToLiq.toFixed(1)}h`}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════
   3. CORRELATED POSITIONS
   ═══════════════════════════════════════════════════════ */

function CorrelatedPositionsPanel({ groups }: { groups: CorrelatedGroup[] }) {
  const cc = useChartColors();
  const [expanded, setExpanded] = useState<string | null>(null);

  // Only show groups with meaningful size
  const significant = groups.filter((g) => g.positions.length >= 3);

  return (
    <Card>
      <div className="flex items-center gap-1.5 mb-1">
        <h3 className="text-sm font-bold text-vgray-800">Correlated position groups</h3>
        <InfoTooltip size="md" text="Positions grouped by shared collateral dependency (same asset + same collateral type). If a single asset crashes, ALL positions in a group are affected simultaneously. Large groups with high debt represent systemic risk \u2014 cascading liquidations can overwhelm liquidators." />
      </div>
      <p className="text-[10px] text-vgray-500 mb-4">
        Positions sharing the same asset and collateral type. A crash in one asset affects the entire group. Shows impact of a \u221220% price drop.
      </p>

      {significant.length === 0 ? (
        <div className="rounded-lg border border-electric-500/20 bg-electric-500/5 px-4 py-4 text-xs font-semibold text-electric-600 text-center">
          No significant correlated groups detected (all groups have &lt; 3 positions).
        </div>
      ) : (
        <div className="space-y-2">
          {significant.map((g) => {
            const isOpen = expanded === g.key;
            const dangerRatio = g.positions.length > 0 ? g.liquidatedAt20Pct / g.positions.length : 0;
            const isDangerous = dangerRatio > 0.3 || g.badDebtAt20Pct > 100000;

            return (
              <div key={g.key} className={cn("rounded-xl border overflow-hidden transition-all",
                isDangerous ? "border-imperial-500/20" : "border-vgray-100")}>
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : g.key)}
                  className="w-full flex items-center gap-3 px-5 py-3.5 hover:bg-surface-hover transition-colors text-left"
                >
                  <div className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: COLLATERAL_TYPE_META[g.collateralType].color }} />
                  <span className="text-xs font-bold text-vgray-800 min-w-[120px]">{g.label}</span>
                  <div className="flex items-center gap-4 flex-1 text-[10px]">
                    <span className="text-vgray-400">
                      Positions: <span className="font-mono font-semibold text-vgray-700">{g.positions.length}</span>
                    </span>
                    <span className="text-vgray-400">
                      Total debt: <span className="font-mono font-semibold text-vgray-700">{formatUsd(g.totalDebt)}</span>
                    </span>
                    <span className="text-vgray-400">
                      At \u221220%: <span className={cn("font-mono font-semibold", g.liquidatedAt20Pct > 0 ? "text-imperial-500" : "text-electric-600")}>
                        {g.liquidatedAt20Pct} liquidated
                      </span>
                    </span>
                    {g.badDebtAt20Pct > 0 && (
                      <span className="text-imperial-500 font-semibold font-mono">
                        Bad debt: {formatUsd(g.badDebtAt20Pct)}
                      </span>
                    )}
                  </div>
                  <svg className={cn("w-4 h-4 transition-transform duration-200 text-vgray-400 shrink-0", isOpen && "rotate-180")}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {isOpen && (
                  <div className="border-t border-vgray-100">
                    <div className="overflow-x-auto">
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="bg-vgray-50">
                            {["Address", "Collateral", "Debt", "HF", "\u0394HF/hr", "Dist to liq", "Leverage"].map((h) => (
                              <th key={h} className="px-3 py-2 text-left font-semibold text-vgray-400 text-[10px] uppercase tracking-wider">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {g.positions.sort((a, b) => a.hf - b.hf).map((p, i) => (
                            <tr key={p.address + i} className="border-t border-vgray-100 hover:bg-surface-hover">
                              <td className="px-3 py-2 font-mono text-vgray-700">{p.address}</td>
                              <td className="px-3 py-2 font-mono text-vgray-700">{formatUsd(p.collateral)}</td>
                              <td className="px-3 py-2 font-mono text-vgray-700">{formatUsd(p.debt)}</td>
                              <td className="px-3 py-2 font-mono font-semibold" style={{ color: hfColor(p.hf) }}>{p.hf.toFixed(4)}</td>
                              <td className="px-3 py-2"><VelocityIndicator velocity={p.hfVelocity} /></td>
                              <td className="px-3 py-2">
                                <span className={cn("font-mono font-semibold",
                                  p.distToLiqPct < 0 ? "text-imperial-500" : p.distToLiqPct < 10 ? "text-rose-500" : "text-vgray-600")}>
                                  {p.distToLiqPct < 0 ? "BELOW" : `\u2212${p.distToLiqPct.toFixed(1)}%`}
                                </span>
                              </td>
                              <td className="px-3 py-2 font-mono text-vgray-700">{p.leverageX === Infinity ? "\u221E" : `${p.leverageX.toFixed(2)}x`}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════
   4. BORROW RATE IMPACT ANALYSIS
   ═══════════════════════════════════════════════════════ */

function BorrowRateImpactPanel({ impacts }: { impacts: BorrowRateImpact[] }) {
  const cc = useChartColors();
  const maxDebt = Math.max(...impacts.map((i) => i.unprofitableDebt), 1);

  return (
    <Card>
      <div className="flex items-center gap-1.5 mb-1">
        <h3 className="text-sm font-bold text-vgray-800">Borrow rate impact analysis</h3>
        <InfoTooltip size="md" text="Simulates what happens if borrow rates increase. Shows how many positions become unprofitable and how many approach liquidation (HF drops below 1.3) at each rate increase over 30 days." />
      </div>
      <p className="text-[10px] text-vgray-500 mb-4">
        If borrow rate increases by X%, how many positions become unprofitable or enter liquidation risk over 30 days?
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="bg-vgray-50">
              <th className="px-4 py-2.5 text-left font-semibold text-vgray-500 text-[10px] uppercase tracking-wider">Rate increase</th>
              <th className="px-4 py-2.5 text-right font-semibold text-vgray-500 text-[10px] uppercase tracking-wider">Unprofitable positions</th>
              <th className="px-4 py-2.5 text-right font-semibold text-vgray-500 text-[10px] uppercase tracking-wider">Unprofitable debt</th>
              <th className="px-4 py-2.5 text-left font-semibold text-vgray-500 text-[10px] uppercase tracking-wider">Debt exposure</th>
              <th className="px-4 py-2.5 text-right font-semibold text-vgray-500 text-[10px] uppercase tracking-wider">
                <span className="flex items-center justify-end gap-1">
                  Enter liq zone
                  <InfoTooltip text="Positions that would drop from HF \u2265 1.3 to HF < 1.3, entering the danger zone where a small further price drop triggers liquidation." />
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {impacts.map((imp, i) => (
              <tr key={imp.rateIncreasePct} className={cn("border-t border-vgray-100", i % 2 === 0 ? "bg-surface" : "bg-vgray-50/50")}>
                <td className="px-4 py-2.5">
                  <span className="font-mono font-bold text-vgray-800">+{imp.rateIncreasePct}%</span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span className={cn("font-mono font-semibold",
                    imp.unprofitableCount > 10 ? "text-imperial-500" : imp.unprofitableCount > 5 ? "text-amber-500" : "text-vgray-700")}>
                    {imp.unprofitableCount}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-vgray-700">{formatUsd(imp.unprofitableDebt)}</td>
                <td className="px-4 py-2.5">
                  <div className="w-full max-w-[200px] h-3 rounded-full overflow-hidden bg-vgray-50">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${(imp.unprofitableDebt / maxDebt) * 100}%`,
                        backgroundColor: imp.unprofitableDebt / maxDebt > 0.5 ? "#FC5457" : imp.unprofitableDebt / maxDebt > 0.25 ? "#F59E0B" : "#703AE6",
                      }}
                    />
                  </div>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span className={cn("font-mono font-semibold",
                    imp.liquidationRiskCount > 5 ? "text-imperial-500" : imp.liquidationRiskCount > 0 ? "text-amber-500" : "text-electric-600")}>
                    {imp.liquidationRiskCount}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════
   5. COLLATERAL TYPE BREAKDOWN KPIs
   ═══════════════════════════════════════════════════════ */

function CollateralBreakdownPanel({ positions }: { positions: AdvancedPosition[] }) {
  const breakdown = useMemo(() => {
    const groups: Record<CollateralType, { count: number; debt: number; collateral: number; avgHf: number; riskCount: number }> = {
      aToken: { count: 0, debt: 0, collateral: 0, avgHf: 0, riskCount: 0 },
      lpToken: { count: 0, debt: 0, collateral: 0, avgHf: 0, riskCount: 0 },
      trackToken: { count: 0, debt: 0, collateral: 0, avgHf: 0, riskCount: 0 },
      cash: { count: 0, debt: 0, collateral: 0, avgHf: 0, riskCount: 0 },
    };

    for (const p of positions) {
      const g = groups[p.collateralType];
      g.count++;
      g.debt += p.debt;
      g.collateral += p.collateral;
      g.avgHf += p.hf === Infinity ? 5 : p.hf;
      if (p.hf < 1.5) g.riskCount++;
    }

    return (Object.entries(groups) as [CollateralType, typeof groups[CollateralType]][]).map(([type, g]) => ({
      type,
      ...g,
      avgHf: g.count > 0 ? g.avgHf / g.count : 0,
    }));
  }, [positions]);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {breakdown.map((b) => {
        const meta = COLLATERAL_TYPE_META[b.type];
        return (
          <Card key={b.type} className="!p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: meta.color }} />
              <span className="text-xs font-bold text-vgray-800">{meta.label}</span>
              <span className={cn("text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full", meta.bgClass)}>
                {meta.risk} risk
              </span>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-[10px]">
                <span className="text-vgray-400">Positions</span>
                <span className="font-mono font-semibold text-vgray-800">{b.count}</span>
              </div>
              <div className="flex justify-between text-[10px]">
                <span className="text-vgray-400">Total debt</span>
                <span className="font-mono font-semibold text-vgray-800">{formatUsd(b.debt)}</span>
              </div>
              <div className="flex justify-between text-[10px]">
                <span className="text-vgray-400">Avg HF</span>
                <span className="font-mono font-semibold" style={{ color: hfColor(b.avgHf) }}>{b.avgHf.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-[10px]">
                <span className="text-vgray-400">At risk (HF &lt; 1.5)</span>
                <span className={cn("font-mono font-semibold", b.riskCount > 0 ? "text-imperial-500" : "text-electric-600")}>{b.riskCount}</span>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   6. SUMMARY KPIs
   ═══════════════════════════════════════════════════════ */

function SummaryKPIs({ positions }: { positions: AdvancedPosition[] }) {
  const stats = useMemo(() => {
    const deteriorating = positions.filter((p) => p.hfVelocity < -0.005).length;
    const belowThreshold = positions.filter((p) => p.hf < 1.1).length;
    const closeToLiq = positions.filter((p) => p.distToLiqPct >= 0 && p.distToLiqPct < 15).length;
    const newPositions = positions.filter((p) => p.ageCategory === "new").length;
    const lpPositions = positions.filter((p) => p.collateralType === "lpToken").length;
    const avgVelocity = positions.length > 0
      ? positions.reduce((s, p) => s + p.hfVelocity, 0) / positions.length
      : 0;

    return { deteriorating, belowThreshold, closeToLiq, newPositions, lpPositions, avgVelocity };
  }, [positions]);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      <Card className="!p-4">
        <div className="flex items-center gap-1 mb-1">
          <p className="text-[10px] font-semibold text-vgray-500 uppercase tracking-wide">Deteriorating</p>
          <InfoTooltip text="Positions with HF declining faster than -0.005/hr" />
        </div>
        <p className={cn("text-xl font-bold font-mono", stats.deteriorating > 0 ? "text-imperial-500" : "text-electric-600")}>{stats.deteriorating}</p>
      </Card>
      <Card className="!p-4">
        <div className="flex items-center gap-1 mb-1">
          <p className="text-[10px] font-semibold text-vgray-500 uppercase tracking-wide">Below HF 1.1</p>
          <InfoTooltip text="Positions eligible for liquidation (HF < 1.1)" />
        </div>
        <p className={cn("text-xl font-bold font-mono", stats.belowThreshold > 0 ? "text-imperial-500" : "text-electric-600")}>{stats.belowThreshold}</p>
      </Card>
      <Card className="!p-4">
        <div className="flex items-center gap-1 mb-1">
          <p className="text-[10px] font-semibold text-vgray-500 uppercase tracking-wide">Close to liq</p>
          <InfoTooltip text="Positions needing < 15% price drop to reach HF 1.1" />
        </div>
        <p className={cn("text-xl font-bold font-mono", stats.closeToLiq > 5 ? "text-amber-500" : "text-vgray-800")}>{stats.closeToLiq}</p>
      </Card>
      <Card className="!p-4">
        <div className="flex items-center gap-1 mb-1">
          <p className="text-[10px] font-semibold text-vgray-500 uppercase tracking-wide">New (&lt; 24h)</p>
          <InfoTooltip text="Positions opened within the last 24 hours \u2014 fresh high-leverage positions are riskier" />
        </div>
        <p className="text-xl font-bold font-mono text-vgray-800">{stats.newPositions}</p>
      </Card>
      <Card className="!p-4">
        <div className="flex items-center gap-1 mb-1">
          <p className="text-[10px] font-semibold text-vgray-500 uppercase tracking-wide">LP collateral</p>
          <InfoTooltip text="Positions using LP tokens as collateral \u2014 higher risk due to impermanent loss and oracle complexity" />
        </div>
        <p className={cn("text-xl font-bold font-mono", stats.lpPositions > 10 ? "text-rose-500" : "text-vgray-800")}>{stats.lpPositions}</p>
      </Card>
      <Card className="!p-4">
        <div className="flex items-center gap-1 mb-1">
          <p className="text-[10px] font-semibold text-vgray-500 uppercase tracking-wide">Avg \u0394HF/hr</p>
          <InfoTooltip text="Protocol-wide average HF velocity. Negative means the protocol is becoming riskier overall." />
        </div>
        <p className={cn("text-xl font-bold font-mono", stats.avgVelocity < -0.002 ? "text-imperial-500" : stats.avgVelocity < 0 ? "text-amber-500" : "text-electric-600")}>
          {stats.avgVelocity >= 0 ? "+" : ""}{stats.avgVelocity.toFixed(4)}
        </p>
      </Card>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   PAGE
   ═══════════════════════════════════════════════════════ */

export default function PositionsAdvancedPage() {
  const positions = useMemo(() => generateAdvancedPositions(BASE_CHAIN_ID), []);
  const correlatedGroups = useMemo(() => buildCorrelatedGroups(positions), [positions]);
  const borrowImpacts = useMemo(() => analyzeBorrowRateImpact(positions), [positions]);

  const timeStr = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="p-6 w-full max-w-[1600px] mx-auto space-y-8">
      <PageHeader
        title="Positions (Advanced)"
        subtitle="HF velocity, distance to liquidation, collateral composition, correlated risk detection, borrow rate sensitivity, and position age analysis"
        meta={<PageHeaderMeta timeLabel={timeStr} />}
      />

      {/* 1. Summary KPIs */}
      <section className="space-y-3">
        <SectionHeader
          title="Risk summary"
          subtitle="Key position risk indicators at a glance"
          tooltip="Quick overview of position-level risk metrics. Deteriorating = HF declining fast. Close to liq = small price drop triggers liquidation."
        />
        <SummaryKPIs positions={positions} />
      </section>

      {/* 2. Rapidly deteriorating positions */}
      <section className="space-y-3">
        <SectionHeader
          title="HF velocity monitor"
          subtitle="Positions with the fastest deteriorating health factors \u2014 sorted by urgency"
          tooltip="Positions whose HF is declining most rapidly. Even if current HF looks safe, a fast decline rate means trouble is coming. Estimated time-to-liquidation is shown."
        />
        <RapidlyDeterioratingPanel positions={positions} />
      </section>

      {/* 3. Collateral composition breakdown */}
      <section className="space-y-3">
        <SectionHeader
          title="Collateral composition"
          subtitle="Position breakdown by collateral type \u2014 LP tokens and track tokens carry higher risk"
          tooltip="LP tokens are subject to impermanent loss and complex oracle pricing. Track tokens depend on external protocol health. Cash and aTokens are the safest collateral types."
        />
        <CollateralBreakdownPanel positions={positions} />
      </section>

      {/* 4. Correlated positions */}
      <section className="space-y-3">
        <SectionHeader
          title="Correlated position detection"
          subtitle="Groups of positions sharing the same collateral dependency \u2014 a single crash affects all"
          tooltip="If 30 positions use ETH LP tokens and ETH drops 20%, all 30 are affected simultaneously. This can overwhelm liquidators and create bad debt. Larger groups with higher debt are more dangerous."
        />
        <CorrelatedPositionsPanel groups={correlatedGroups} />
      </section>

      {/* 5. Borrow rate impact */}
      <section className="space-y-3">
        <SectionHeader
          title="Borrow rate sensitivity"
          subtitle="What happens to positions if borrow rates increase?"
          tooltip="Rising borrow rates increase debt cost, which can make positions unprofitable and push them closer to liquidation. This analysis shows the impact of rate increases over 30 days."
        />
        <BorrowRateImpactPanel impacts={borrowImpacts} />
      </section>

      {/* 6. Full position table with all enhancements */}
      <section className="space-y-3">
        <SectionHeader
          title="All positions (enhanced)"
          subtitle="Full position table with velocity, distance-to-liquidation, collateral type, and age filters"
          tooltip="Sortable and filterable table showing every position with enhanced risk metrics. Use column headers to sort and filters to narrow down."
        />
        <PositionsTable positions={positions} />
      </section>
    </div>
  );
}
