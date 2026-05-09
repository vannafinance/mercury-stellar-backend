"use client";

import type { ReactNode } from "react";
import { useMemo, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { WalletPosition } from "@/components/analytics/risk-explorer/constants";
import { formatUsd, formatPercent, hfColor, cn } from "@/lib/analytics/utils";
import { useChartColors } from "@/lib/analytics/theme";
import InfoTooltip from "@/components/analytics/ui/InfoTooltip";
import CoinIcon from "@/components/analytics/ui/CoinIcon";
import { readAllPoolStats } from "@/lib/analytics/stellar/rpcReader";
import { computeBorrowApr } from "@/lib/utils/borrow-rate";

const POOL_APR_CHART_POINTS = 20;

/* ── HF bucket definitions (colors injected at render time for theme support) ── */
function getHfBuckets(cc: ReturnType<typeof useChartColors>) {
  return [
    { label: "< 1.0", tag: "Underwater", color: cc.imperial, min: 0, max: 1.0 },
    { label: "1.0-1.1", tag: "Critical", color: cc.rose, min: 1.0, max: 1.1 },
    { label: "1.1-1.2", tag: "Warning", color: cc.violet, min: 1.1, max: 1.2 },
    { label: "1.2-1.5", tag: "Caution", color: cc.accent2, min: 1.2, max: 1.5 },
    { label: "> 1.5", tag: "Safe", color: cc.electric, min: 1.5, max: Infinity },
  ];
}

function getLevBuckets(cc: ReturnType<typeof useChartColors>) {
  return [
    { label: "1-2x", tag: "Conservative", color: cc.electric, min: 1, max: 2 },
    { label: "2-3x", tag: "Moderate", color: cc.violet, min: 2, max: 3 },
    { label: "3-5x", tag: "Aggressive", color: cc.accent2, min: 3, max: 5 },
    { label: "5-7x", tag: "High Risk", color: cc.rose, min: 5, max: 7 },
    { label: "7-10x", tag: "Max Leverage", color: cc.imperial, min: 7, max: 10 },
    { label: "10x+", tag: "Over-leveraged", color: cc.imperial, min: 10, max: Infinity },
  ];
}

const HEATMAP_HF_RANGES = ["< 1.0", "1.0-1.1", "1.1-1.2", "1.2-1.5", "1.5-2.0", "> 2.0"] as const;
const HEATMAP_TIME_LABELS = ["Mar 10", "Mar 12", "Mar 14", "Mar 16", "Today"] as const;

function bucketWallets(wallets: WalletPosition[], buckets: ReturnType<typeof getHfBuckets>) {
  return buckets.map((b) => {
    const items = wallets.filter((w) => w.hf >= b.min && w.hf < b.max);
    const totalCollateral = items.reduce((s, w) => s + w.collateral, 0);
    return { ...b, wallets: items, count: items.length, totalCollateral };
  });
}

function bucketLeverage(wallets: WalletPosition[], buckets: ReturnType<typeof getLevBuckets>) {
  return buckets.map((b) => {
    const items = wallets.filter((w) => w.leverageX >= b.min && w.leverageX < b.max);
    const totalCollateral = items.reduce((s, w) => s + w.collateral, 0);
    return { ...b, wallets: items, count: items.length, totalCollateral };
  });
}

function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-r4 border border-vgray-100 bg-surface p-6 shadow-vanna",
        className
      )}
    >
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

function BorrowRateLineChart({
  title,
  subtitle,
  data,
  color,
  yFormat,
  xLabels,
}: {
  title: string;
  subtitle: string;
  data: number[];
  color: string;
  yFormat: (v: number) => string;
  xLabels: string[];
}) {
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const pts = data.map((v, i) => ({
    x: (i / Math.max(data.length - 1, 1)) * 100,
    y: 100 - ((v - min) / range) * 85 - 5,
  }));
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const area = `${line} L 100 100 L 0 100 Z`;
  const gradId = `br-${color.replace("#", "")}`;

  return (
    <Card>
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-bold text-vgray-800">{title}</h3>
          <p className="text-xs mt-1 text-vgray-500">{subtitle}</p>
        </div>
        <div className="relative h-48">
          <div className="absolute left-0 top-0 bottom-5 w-14 flex flex-col justify-between text-[9px] font-mono pr-2 text-right text-vgray-400">
            <span>{yFormat(max)}</span>
            <span>{yFormat((max + min) / 2)}</span>
            <span>{yFormat(min)}</span>
          </div>
          <div className="ml-16 mr-1 relative h-[calc(100%-18px)]">
            {[0, 50, 100].map((y) => (
              <div
                key={y}
                className="absolute left-0 right-0 h-px bg-vgray-100"
                style={{ top: `${y}%` }}
              />
            ))}
            <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
              <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity="0.2" />
                  <stop offset="100%" stopColor={color} stopOpacity="0.01" />
                </linearGradient>
              </defs>
              <path d={area} fill={`url(#${gradId})`} />
              <path
                d={line}
                fill="none"
                stroke={color}
                strokeWidth="0.6"
                vectorEffect="non-scaling-stroke"
              />
              {pts.map((p, i) => (
                <circle
                  key={i}
                  cx={p.x}
                  cy={p.y}
                  r="0.8"
                  fill={color}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
          </div>
          <div className="ml-16 mr-1 flex justify-between text-[9px] font-mono mt-1.5 text-vgray-300">
            {xLabels.map((l, i) => (
              <span key={i}>{l}</span>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

export default function PositionsMonitor({
  wallets,
  chainName,
}: {
  wallets: WalletPosition[];
  chainName: string;
}) {
  const cc = useChartColors();
  const router = useRouter();
  const [expandedBucket, setExpandedBucket] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [poolBorrowAprSeries, setPoolBorrowAprSeries] = useState<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pools = await readAllPoolStats();
        const aprs = pools.map((p) => computeBorrowApr(p.utilizationRate));
        const avg = aprs.length
          ? aprs.reduce((a, b) => a + b, 0) / aprs.length
          : computeBorrowApr(0);
        if (!cancelled) {
          setPoolBorrowAprSeries(Array.from({ length: POOL_APR_CHART_POINTS }, () => avg));
        }
      } catch {
        if (!cancelled) setPoolBorrowAprSeries([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallets.length]);

  const filteredWallets = useMemo(() =>
    search.trim()
      ? wallets.filter(w => w.address.toLowerCase().includes(search.toLowerCase()))
      : wallets,
    [wallets, search]
  );

  const hfBucketDefs = useMemo(() => getHfBuckets(cc), [cc]);
  const levBucketDefs = useMemo(() => getLevBuckets(cc), [cc]);
  const hfBuckets = useMemo(() => bucketWallets(wallets, hfBucketDefs), [wallets, hfBucketDefs]);
  const levBuckets = useMemo(() => bucketLeverage(wallets, levBucketDefs), [wallets, levBucketDefs]);
  const borrowRateData =
    poolBorrowAprSeries.length > 0
      ? poolBorrowAprSeries
      : [computeBorrowApr(0), computeBorrowApr(0)];
  const borrowChartXLabels = useMemo(
    () => Array.from({ length: borrowRateData.length }, (_, i) => String(i + 1)),
    [borrowRateData.length],
  );

  const maxHfCount = useMemo(
    () => Math.max(...hfBuckets.map((b) => b.count), 1),
    [hfBuckets]
  );
  const maxLevCount = useMemo(
    () => Math.max(...levBuckets.map((b) => b.count), 1),
    [levBuckets]
  );

  const leverageStats = useMemo(() => {
    if (wallets.length === 0) return { avg: 0, highRisk: 0 };
    const avg = wallets.reduce((s, w) => s + w.leverageX, 0) / wallets.length;
    const highRisk = wallets.filter((w) => w.leverageX > 5).length;
    return { avg, highRisk };
  }, [wallets]);

  const heatmapData = useMemo(() => {
    const hfRangeBounds = [
      { min: 0, max: 1.0 },
      { min: 1.0, max: 1.1 },
      { min: 1.1, max: 1.2 },
      { min: 1.2, max: 1.5 },
      { min: 1.5, max: 2.0 },
      { min: 2.0, max: Infinity },
    ];

    return hfRangeBounds.map((range) => {
      const baseWallets = wallets.filter((w) => w.hf >= range.min && w.hf < range.max);
      const baseValue = baseWallets.reduce((s, w) => s + w.collateral, 0);
      const n = HEATMAP_TIME_LABELS.length;
      const perCol = n > 0 ? baseValue / n : 0;
      const cells = HEATMAP_TIME_LABELS.map(() => perCol);
      const rowTotal = baseValue;
      return { cells, rowTotal };
    });
  }, [wallets]);

  const heatmapMax = useMemo(
    () => Math.max(...heatmapData.flatMap((r) => r.cells), 1),
    [heatmapData]
  );

  return (
    <div className="space-y-6">
      {wallets.length === 0 && (
        <div className="rounded-r4 border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-900">
          No live margin positions — charts reflect your SmartAccount from Soroban only. Connect a wallet with an active borrowed position to populate this page.
        </div>
      )}
      <SectionHeader
        title="Health factor distribution & borrow rate"
        subtitle={`Current health factor distribution and historical borrow rates on ${chainName}`}
        tooltip="Health factor measures how safe a position is. Below 1.1 triggers liquidation. Borrow rate affects how quickly debt grows."
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <div className="flex items-center gap-1.5 mb-1">
            <h3 className="text-sm font-bold text-vgray-800">HF distribution</h3>
            <InfoTooltip text="Position count grouped by health factor range. Red/pink bands are danger zones — those positions are close to or past the 1.1 liquidation threshold." />
          </div>
          <p className="text-[10px] text-vgray-500 mb-4">
            Position count by health factor range
          </p>
          <div className="space-y-3">
            {hfBuckets.map((b) => (
              <div key={b.label} className="flex items-center gap-2">
                <span
                  className="w-[70px] text-[10px] font-mono font-medium shrink-0"
                  style={{ color: b.color }}
                >
                  {b.label}
                </span>
                <span className="w-[72px] text-[9px] shrink-0 text-vgray-400">{b.tag}</span>
                <div className="flex-1 h-5 rounded-md overflow-hidden bg-vgray-50">
                  <div
                    className="h-full rounded-md transition-all duration-500"
                    style={{
                      width: `${(b.count / maxHfCount) * 100}%`,
                      backgroundColor: b.color,
                      opacity: 0.8,
                    }}
                  />
                </div>
                <span className="w-8 text-right text-[11px] font-mono font-semibold text-vgray-700">
                  {b.count}
                </span>
              </div>
            ))}
          </div>
        </Card>

        <BorrowRateLineChart
          title="Borrow rate (pools)"
          subtitle="Average model-implied borrow APR from live lending-pool utilization — flat series (no on-chain historical rate feed)"
          data={borrowRateData}
          color={cc.violet}
          yFormat={(v) => formatPercent(v)}
          xLabels={borrowChartXLabels}
        />
      </div>

      <SectionHeader
        title="Leverage & health factor heatmap"
        subtitle="Position leverage distribution and HF-collateral density"
        tooltip="Higher leverage amplifies both gains and losses. Time columns split each band's collateral evenly — there is no on-chain HF history feed yet."
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <div className="flex items-center gap-1.5 mb-1">
            <h3 className="text-sm font-bold text-vgray-800">Leverage distribution</h3>
            <InfoTooltip text="Position count and collateral value grouped by leverage range. Positions above 5x are high-risk — a small price drop can push them below the 1.1 HF liquidation threshold." />
          </div>
          <p className="text-[10px] text-vgray-500 mb-4">
            Position count and value by leverage range
          </p>
          <div className="space-y-2.5">
            {levBuckets.map((b) => (
              <div key={b.label}>
                <div className="flex items-center gap-2">
                  <span
                    className="w-[52px] text-[10px] font-mono font-medium shrink-0"
                    style={{ color: b.color }}
                  >
                    {b.label}
                  </span>
                  <span className="w-[90px] text-[9px] shrink-0 text-vgray-400">{b.tag}</span>
                  <div className="flex-1 h-4 rounded overflow-hidden bg-vgray-50">
                    <div
                      className="h-full rounded transition-all duration-500"
                      style={{
                        width: `${(b.count / maxLevCount) * 100}%`,
                        backgroundColor: b.color,
                        opacity: 0.75,
                      }}
                    />
                  </div>
                  <span className="w-7 text-right text-[11px] font-mono font-semibold text-vgray-700">
                    {b.count}
                  </span>
                  <span className="w-[72px] text-right text-[10px] font-mono text-vgray-400">
                    {formatUsd(b.totalCollateral)}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-3 border-t border-vgray-100 flex items-center justify-between text-[10px] font-mono">
            <div>
              <span className="text-vgray-400">Avg leverage: </span>
              <span className="font-semibold text-vgray-800">{leverageStats.avg.toFixed(2)}x</span>
            </div>
            <div>
              <span className="text-vgray-400">Max allowed: </span>
              <span className="font-semibold text-vgray-800">10x</span>
            </div>
            <div>
              <span className="text-vgray-400">High-risk (&gt;5x): </span>
              <span className="font-semibold text-rose-400">{leverageStats.highRisk}</span>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-1.5 mb-1">
            <h3 className="text-sm font-bold text-vgray-800">HF heatmap</h3>
            <InfoTooltip text="Collateral density by health factor range over time. Darker cells indicate heavier collateral concentration — watch for buildup in low-HF bands." />
          </div>
          <p className="text-[10px] text-vgray-500 mb-4">
            Collateral density by health factor range over time
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="text-left text-[9px] font-mono pb-2 pr-2 text-vgray-400">
                    HF range
                  </th>
                  {HEATMAP_TIME_LABELS.map((lbl) => (
                    <th
                      key={lbl}
                      className="text-center text-[9px] font-mono pb-2 px-1 text-vgray-400"
                    >
                      {lbl}
                    </th>
                  ))}
                  <th className="text-right text-[9px] font-mono pb-2 pl-2 text-vgray-400">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {HEATMAP_HF_RANGES.map((range, ri) => (
                  <tr key={range}>
                    <td className="text-[10px] font-mono py-1 pr-2 text-vgray-600">{range}</td>
                    {heatmapData[ri].cells.map((val, ci) => {
                      const intensity = val / heatmapMax;
                      return (
                        <td key={ci} className="py-1 px-1">
                          <div
                            className="rounded h-7 flex items-center justify-center text-[8px] font-mono"
                            style={{
                              backgroundColor: `rgba(${cc.violet === "#703AE6" ? "112, 58, 230" : "139, 92, 246"}, ${0.08 + intensity * 0.72})`,
                              color: intensity > 0.4 ? (cc.violet === "#703AE6" ? "#ffffff" : "#f1f5f9") : cc.axisText,
                            }}
                          >
                            {formatUsd(val)}
                          </div>
                        </td>
                      );
                    })}
                    <td className="text-right text-[10px] font-mono py-1 pl-2 font-semibold text-vgray-700">
                      {formatUsd(heatmapData[ri].rowTotal)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-2 mt-3 pt-2 border-t border-vgray-100">
            <span className="text-[9px] text-vgray-400">Low</span>
            <div
              className="flex-1 h-2 rounded-full overflow-hidden"
              style={{
                background: cc.violet === "#703AE6"
                  ? "linear-gradient(to right, rgba(112,58,230,0.08), rgba(112,58,230,0.80))"
                  : "linear-gradient(to right, rgba(139,92,246,0.08), rgba(139,92,246,0.80))",
              }}
            />
            <span className="text-[9px] text-vgray-400">High</span>
          </div>
        </Card>
      </div>

      <SectionHeader
        title="Position Lookup"
        subtitle="Search all wallets — click any row for a full portfolio breakdown"
        tooltip="Browse every active position. Use the search bar to filter by wallet address. Click a row to open the detailed portfolio view."
      />

      {/* Search bar */}
      <div className="relative max-w-lg">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-vgray-300 pointer-events-none" width="15" height="15" viewBox="0 0 15 15" fill="none">
          <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by wallet address…"
          className="w-full bg-surface border border-vgray-100 rounded-r2 pl-9 pr-9 py-2.5 text-[13px] text-vgray-700 placeholder:text-vgray-300 focus:outline-none focus:border-violet-300 focus:ring-1 focus:ring-violet-200 shadow-vanna"
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-vgray-300 hover:text-vgray-500 transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M2 2L11 11M11 2L2 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>

      {/* Wallets table */}
      <Card className="!p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="bg-vgray-50 border-b border-vgray-100">
                <th className="px-4 py-3 text-left font-semibold text-vgray-400 w-8">#</th>
                <th className="px-4 py-3 text-left font-semibold text-vgray-400">Address</th>
                <th className="px-4 py-3 text-left font-semibold text-vgray-400">Primary Asset</th>
                <th className="px-4 py-3 text-right font-semibold text-vgray-400">Collateral</th>
                <th className="px-4 py-3 text-right font-semibold text-vgray-400">Debt</th>
                <th className="px-4 py-3 text-center font-semibold text-vgray-400">Leverage</th>
                <th className="px-4 py-3 text-right font-semibold text-vgray-400">Health Factor</th>
                <th className="px-4 py-3 text-center font-semibold text-vgray-400">Status</th>
                <th className="px-4 py-3 w-6" />
              </tr>
            </thead>
            <tbody>
              {filteredWallets.map((w, i) => {
                const statusLabel = w.hf < 1.0 ? "Liquidatable" : w.hf < 1.1 ? "Critical" : w.hf < 1.2 ? "Warning" : w.hf < 1.5 ? "Caution" : "Safe";
                const statusCls = w.hf < 1.0
                  ? "bg-red-50 text-red-600 border-red-200"
                  : w.hf < 1.1 ? "bg-rose-50 text-rose-600 border-rose-200"
                  : w.hf < 1.2 ? "bg-violet-50 text-violet-600 border-violet-200"
                  : w.hf < 1.5 ? "bg-amber-50 text-amber-600 border-amber-200"
                  : "bg-teal-50 text-teal-600 border-teal-200";
                return (
                  <tr
                    key={w.address + i}
                    onClick={() => router.push(`/positions/${encodeURIComponent(w.address)}`)}
                    className="border-t border-vgray-100 hover:bg-violet-50/30 cursor-pointer transition-colors group"
                  >
                    <td className="px-4 py-3 font-mono text-vgray-300">{i + 1}</td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-[11px] text-vgray-700 group-hover:text-violet-600 transition-colors">{w.address}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <CoinIcon symbol={w.primaryAsset} size={14} />
                        <span className="font-medium text-vgray-700">{w.primaryAsset}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-vgray-700">{formatUsd(w.collateral)}</td>
                    <td className="px-4 py-3 text-right font-mono text-vgray-700">{formatUsd(w.debt)}</td>
                    <td className="px-4 py-3 text-center font-mono font-semibold text-vgray-700">{w.leverageX.toFixed(1)}×</td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-mono font-semibold" style={{ color: hfColor(w.hf) }}>{w.hf.toFixed(3)}</span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={cn("text-[10px] font-semibold px-2 py-0.5 rounded-full border", statusCls)}>
                        {statusLabel}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <svg className="text-vgray-200 group-hover:text-violet-400 transition-colors" width="13" height="13" viewBox="0 0 13 13" fill="none">
                        <path d="M4.5 3L8 6.5L4.5 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filteredWallets.length === 0 && (
            <div className="py-14 text-center text-vgray-300 text-sm">
              No wallets match &ldquo;{search}&rdquo;
            </div>
          )}
        </div>
        <div className="px-4 py-2.5 border-t border-vgray-100 bg-vgray-50/50 flex items-center justify-between">
          <span className="text-[10px] text-vgray-400">{filteredWallets.length} wallets</span>
          {search && <span className="text-[10px] text-vgray-400">filtered from {wallets.length} total</span>}
        </div>
      </Card>
    </div>
  );
}
