"use client";

import { useRef, useState, useCallback, useMemo, useEffect } from "react";

const PAD = { top: 16, right: 58, bottom: 32, left: 4 };
const Y_TICKS = 4;

export interface SvgChartProps {
  data: Record<string, number>;
  lineColor?: string;
  gradientColors?: [string, string];
  height?: number;
  formatYAxisLabel?: (v: number) => string;
  textColor?: string;
  gridColor?: string;
  chartId?: string;
}

// Format X-axis tick label so it scales with the actual date range. A 4-day
// span shouldn't print "Apr Apr Apr Apr" — that's what users were seeing
// when all data points landed in the same month.
const fmtXLabel = (dateStr: string, allDates: string[]) => {
  const d = new Date(dateStr);
  if (allDates.length < 2) {
    return d.toLocaleString("en-US", { month: "short", day: "numeric" });
  }
  const sorted = [...allDates].map((s) => new Date(s).getTime()).sort((a, b) => a - b);
  const spanMs = sorted[sorted.length - 1] - sorted[0];
  const oneDay = 24 * 60 * 60 * 1000;
  const spanDays = spanMs / oneDay;

  if (spanDays > 365) {
    const month = d.toLocaleString("en-US", { month: "short" });
    const yearShort = String(d.getFullYear()).slice(-2);
    return `${month} '${yearShort}`;
  }
  if (spanDays > 90) {
    return d.toLocaleString("en-US", { month: "short" });
  }
  if (spanDays > 1) {
    return d.toLocaleString("en-US", { month: "short", day: "numeric" });
  }
  // Sub-day spans: include date so labels don't look like "12:41 AM" floating
  // without context. Mirrors how mature DEXes label intraday charts.
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

export const SvgChart = ({
  data,
  lineColor = "#703AE6",
  gradientColors = ["rgba(112,58,230,0.35)", "rgba(112,58,230,0)"],
  height = 180,
  formatYAxisLabel = (v) => v.toFixed(2),
  textColor = "#777777",
  gridColor = "rgba(200,200,200,0.2)",
  chartId = "sg",
}: SvgChartProps) => {
  // ── All hooks unconditionally at the top ──────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const [cw, setCw] = useState(0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Keep latest n and W in refs so useCallback doesn't need to depend on them
  const nRef = useRef(0);
  const WRef = useRef(0);
  const cwRef = useRef(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setCw(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const points = useMemo(() => {
    return Object.entries(data)
      .map(([date, value]) => ({ date, value }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [data]);

  // Stable mouse handler — reads latest values via refs
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const n = nRef.current;
      const W = WRef.current;
      const cwCurrent = cwRef.current;
      if (!n || !W) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (cwCurrent / rect.width) - PAD.left;
      const idx = Math.max(0, Math.min(n - 1, Math.round((mx / W) * (n - 1))));
      setHoverIdx(idx);
    },
    [] // no deps — uses refs
  );

  const handleMouseLeave = useCallback(() => setHoverIdx(null), []);
  // ─────────────────────────────────────────────────────────────────────────

  // Early return after all hooks
  if (!cw || points.length < 2) {
    return (
      <div ref={containerRef} className="w-full flex items-center justify-center" style={{ height }}>
        {cw > 0 && <span style={{ color: textColor, fontSize: 12 }}>No data</span>}
      </div>
    );
  }

  const n = points.length;
  const W = cw - PAD.left - PAD.right;
  const H = height - PAD.top - PAD.bottom;

  // Update refs for mouse handler
  nRef.current = n;
  WRef.current = W;
  cwRef.current = cw;

  const minV = Math.min(...points.map((p) => p.value));
  const maxV = Math.max(...points.map((p) => p.value));
  // When all values are equal (flat line) anchor at 0 so the line renders at
  // ~80% height instead of at the bottom with a meaningless Y range above it.
  const effectiveMin = minV === maxV ? 0 : minV;
  const vRange = maxV - effectiveMin || 1;

  const gx = (i: number) => PAD.left + (i / (n - 1)) * W;
  const gy = (v: number) => PAD.top + H - ((v - effectiveMin) / vRange) * H;

  // Smooth cubic bezier
  const linePath = points.reduce((acc, p, i) => {
    const x = gx(i);
    const y = gy(p.value);
    if (i === 0) return `M${x},${y}`;
    const px = gx(i - 1);
    const py = gy(points[i - 1].value);
    const t = 0.35;
    return `${acc} C${px + (x - px) * t},${py} ${x - (x - px) * t},${y} ${x},${y}`;
  }, "");

  const areaPath = `${linePath} L${gx(n - 1)},${PAD.top + H} L${gx(0)},${PAD.top + H} Z`;

  const yTicks = Array.from({ length: Y_TICKS + 1 }, (_, i) => {
    const v = effectiveMin + (vRange * i) / Y_TICKS;
    return { v, y: gy(v) };
  });

  const xCount = Math.min(4, n);
  const xIdxs = Array.from({ length: xCount }, (_, i) =>
    Math.round((i / (xCount - 1)) * (n - 1))
  );
  const allDates = points.map((p) => p.date);

  const hp = hoverIdx !== null ? points[hoverIdx] : null;
  const hx = hoverIdx !== null ? gx(hoverIdx) : 0;
  const hy = hp ? gy(hp.value) : 0;
  const tipLeft = hx > cw * 0.65 ? hx - 120 : hx + 12;
  const tipTop = Math.max(4, hy - 40);
  const gradId = `grad-${chartId}`;

  return (
    <div ref={containerRef} className="relative w-full" style={{ height }}>
      <svg
        viewBox={`0 0 ${cw} ${height}`}
        style={{ width: "100%", height, display: "block" }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={gradientColors[0]} />
            <stop offset="100%" stopColor={gradientColors[1]} stopOpacity={0} />
          </linearGradient>
        </defs>

        {yTicks.map(({ y }, i) => (
          <line key={i} x1={PAD.left} y1={y} x2={PAD.left + W} y2={y}
            stroke={gridColor} strokeWidth={1} />
        ))}

        <path d={areaPath} fill={`url(#${gradId})`} />
        <path d={linePath} fill="none" stroke={lineColor} strokeWidth={2}
          strokeLinejoin="round" strokeLinecap="round" />

        {yTicks.map(({ v, y }, i) => (
          <text key={i} x={PAD.left + W + 6} y={y + 4}
            fontSize={11} fill={textColor} textAnchor="start"
            style={{ fontFamily: "inherit" }}>
            {formatYAxisLabel(v)}
          </text>
        ))}

        {xIdxs.map((idx, i) => (
          <text key={i} x={gx(idx)} y={height - 5}
            fontSize={11} fill={textColor}
            textAnchor={i === 0 ? "start" : i === xCount - 1 ? "end" : "middle"}
            style={{ fontFamily: "inherit" }}>
            {fmtXLabel(points[idx].date, allDates)}
          </text>
        ))}

        {hp && hoverIdx !== null && (
          <>
            <line x1={hx} y1={PAD.top} x2={hx} y2={PAD.top + H}
              stroke={lineColor} strokeWidth={1} strokeDasharray="3 2" opacity={0.5} />
            <circle cx={hx} cy={hy} r={7} fill={lineColor} opacity={0.12} />
            <circle cx={hx} cy={hy} r={3.5} fill={lineColor} />
          </>
        )}
      </svg>

      {hp && (
        <div
          className="absolute pointer-events-none rounded-lg px-2.5 py-1.5 border shadow-xl z-10"
          style={{
            left: tipLeft,
            top: tipTop,
            background: "#1A1A1A",
            borderColor: "#333333",
            whiteSpace: "nowrap",
          }}
        >
          <div style={{ color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>
            {formatYAxisLabel(hp.value)}
          </div>
          <div style={{ color: "#A7A7A7", fontSize: 11, fontFamily: "inherit" }}>
            {new Date(hp.date).toLocaleDateString("en-US", {
              month: "short", day: "numeric", year: "numeric",
            })}
          </div>
        </div>
      )}
    </div>
  );
};
