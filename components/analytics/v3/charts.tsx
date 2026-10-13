"use client";

/**
 * Dependency-free SVG/HTML charts. Every chart receives measured values or explicitly labelled
 * calculated values - never placeholders. Hover/focus details come from `data-tip` (TooltipHost).
 */
import type { ReactNode } from "react";

export const TONE_VAR: Record<string, string> = {
  danger: "var(--danger-bar)", critical: "var(--critical-bar)", warn: "var(--warn-bar)", ok: "var(--ok-bar)", accent: "var(--c1)", neutral: "var(--c5)",
};
export const SERIES = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)"];

function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * exp >= v) return m * exp;
  return 10 * exp;
}

export interface ColumnItem { key?: string; label: string; value: number; color?: string; tip?: string; aria?: string; active?: boolean }

/** Vertical columns with a baseline-anchored rounded end, light grid and an optional boundary marker. */
export function ColumnChart({ items, height = 230, yFmt, divider, ariaLabel, onPick }: {
  items: ColumnItem[]; height?: number; yFmt: (v: number) => string; divider?: { after: number; label: string }; ariaLabel: string; onPick?: (key: string) => void;
}) {
  const W = 640, H = height, L = 58, R = 10, T = 22, B = 36;
  const pw = W - L - R, ph = H - T - B;
  const max = niceMax(Math.max(0, ...items.map((i) => i.value)));
  const slot = pw / Math.max(items.length, 1), bw = Math.min(slot * 0.62, 56);
  const y = (v: number) => T + ph - (v / max) * ph;
  return (
    <svg className="an-chart" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={ariaLabel}>
      {[0, 1, 2, 3, 4].map((i) => {
        const t = (max * i) / 4;
        return (
          <g key={i}>
            <line className="an-grid-line" x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
            <text x={L - 8} y={y(t) + 4} textAnchor="end">{yFmt(t)}</text>
          </g>
        );
      })}
      {items.map((it, i) => {
        const cx = L + slot * i + slot / 2;
        const h = it.value > 0 ? Math.max(3, (it.value / max) * ph) : 0;
        const x = cx - bw / 2, top = T + ph - h, r = Math.min(4, bw / 2, h);
        const path = h ? `M${x},${T + ph}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${T + ph}Z` : "";
        const clickable = !!(it.key && onPick);
        return (
          <g key={it.label} className="an-mark" tabIndex={0} role={clickable ? "button" : "img"} aria-label={`${it.label}: ${it.aria ?? yFmt(it.value)}`}
            data-tip={it.tip ?? `${it.label}\n${yFmt(it.value)}`}
            onClick={clickable ? () => onPick!(it.key!) : undefined}
            onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick!(it.key!); } } : undefined}>
            <rect className="an-hit" x={cx - slot / 2} y={T} width={slot} height={ph + B - 6} />
            {path && <path d={path} fill={it.color ?? "var(--c1)"} opacity={it.active === false ? 0.35 : 1} />}
            {it.value > 0 && items.length <= 9 && <text x={cx} y={top - 6} textAnchor="middle" style={{ fill: "var(--ink-2)", fontWeight: 600 }}>{yFmt(it.value)}</text>}
            <text x={cx} y={H - 14} textAnchor="middle">{it.label}</text>
          </g>
        );
      })}
      {divider && (
        <>
          <line className="an-threshold" x1={L + slot * divider.after} y1={T - 8} x2={L + slot * divider.after} y2={T + ph} />
          <text className="an-threshold-label" x={L + slot * divider.after - 6} y={T - 10} textAnchor="end">{divider.label}</text>
        </>
      )}
    </svg>
  );
}

export interface DonutSeg { label: string; value: number; color: string; tip?: string }

export function Donut({ segments, size = 188, center, thickness = 22 }: { segments: DonutSeg[]; size?: number; center: [string, string]; thickness?: number }) {
  const r = size / 2 - thickness / 2 - 2, C = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  const live = segments.filter((s) => s.value > 0);
  const gap = live.length > 1 ? 3 : 0;
  let offset = 0;
  return (
    <svg className="an-chart" style={{ maxWidth: size, margin: "0 auto" }} viewBox={`0 0 ${size} ${size}`} role="group" aria-label={center[0]}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--track)" strokeWidth={thickness} />
      {total > 0 && live.map((s) => {
        const len = (s.value / total) * C, dash = Math.max(0.1, len - gap);
        const el = (
          <circle key={s.label} className="an-mark" cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={thickness}
            strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={-offset} transform={`rotate(-90 ${size / 2} ${size / 2})`} tabIndex={0} role="img" aria-label={s.label} data-tip={s.tip ?? s.label} />
        );
        offset += len;
        return el;
      })}
      <text x={size / 2} y={size / 2 - 6} textAnchor="middle" style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: ".04em" }}>{center[0]}</text>
      <text x={size / 2} y={size / 2 + 16} textAnchor="middle" style={{ fill: "var(--ink)", fontSize: 19, fontWeight: 700 }}>{center[1]}</text>
    </svg>
  );
}

export interface StackSeg { label: string; value: number; color: string; tip?: string }
export function StackBar({ segments, tall = false }: { segments: StackSeg[]; tall?: boolean }) {
  return (
    <div className={`an-stack ${tall ? "an-tall" : ""}`} role="img" aria-label={segments.map((s) => s.label).join(", ")}>
      {segments.filter((s) => s.value > 0).map((s) => <i key={s.label} style={{ flex: s.value, background: s.color }} data-tip={s.tip ?? s.label} />)}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return <div className="an-legend">{items.map((i) => <span key={i.label}><i style={{ background: i.color }} />{i.label}</span>)}</div>;
}

export interface HBarRow { key: string; name: ReactNode; segments: { value: number; color: string; tip?: string }[]; valueText: string }
export function HBars({ rows }: { rows: HBarRow[] }) {
  const max = Math.max(1e-12, ...rows.map((r) => r.segments.reduce((s, x) => s + Math.max(0, x.value), 0)));
  return (
    <>
      {rows.map((r) => (
        <div className="an-hbar" key={r.key}>
          <span className="an-name">{r.name}</span>
          <span className="an-track">{r.segments.map((s, i) => <i key={i} style={{ width: `${(Math.max(0, s.value) / max) * 100}%`, background: s.color }} data-tip={s.tip ?? ""} />)}</span>
          <span className="an-val">{r.valueText}</span>
        </div>
      ))}
    </>
  );
}

export function Gauge({ value, label, color = "var(--c1)" }: { value: number | null; label: string; color?: string }) {
  const W = 200, H = 116, cx = 100, cy = 100, r = 78;
  const pt = (a: number): [number, number] => [cx + r * Math.cos(Math.PI - a), cy - r * Math.sin(Math.PI - a)];
  const arc = (a0: number, a1: number) => { const [x0, y0] = pt(a0), [x1, y1] = pt(a1); return `M${x0},${y0}A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1},${y1}`; };
  const v = value === null || !Number.isFinite(value) ? 0 : Math.min(1, Math.max(0, value));
  return (
    <svg className="an-chart" style={{ maxWidth: 200 }} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <path d={arc(0, Math.PI)} fill="none" stroke="var(--track)" strokeWidth={14} strokeLinecap="round" />
      {v > 0 && <path d={arc(0, Math.max(0.02, v * Math.PI))} fill="none" stroke={color} strokeWidth={14} strokeLinecap="round" />}
      <text x={cx} y={cy - 14} textAnchor="middle" style={{ fill: "var(--ink)", fontSize: 24, fontWeight: 700 }}>{value === null ? "-" : `${(value * 100).toFixed(value < 0.1 ? 2 : 1)}%`}</text>
      <text x={cx} y={cy + 6} textAnchor="middle" style={{ fontSize: 11.5 }}>{label}</text>
      <text x={cx - r} y={cy + 18} textAnchor="middle" style={{ fontSize: 10.5 }}>0%</text>
      <text x={cx + r} y={cy + 18} textAnchor="middle" style={{ fontSize: 10.5 }}>100%</text>
    </svg>
  );
}

export interface LinePoint { x: number; y: number; tip?: string }
/** Continuous x/y curve with hover strips and an optional marker for the current point. */
export function LineChart({ points, xFmt, yFmt, marker, color = "var(--c1)", height = 250, ariaLabel, xTicks }: {
  points: LinePoint[]; xFmt: (v: number) => string; yFmt: (v: number) => string; marker?: { x: number; y: number; label: string } | null; color?: string; height?: number; ariaLabel: string; xTicks?: number[];
}) {
  const W = 640, H = height, L = 58, R = 18, T = 26, B = 36, pw = W - L - R, ph = H - T - B;
  const xs = points.map((p) => p.x), x0 = Math.min(...xs), x1 = Math.max(...xs);
  const max = niceMax(Math.max(...points.map((p) => p.y), 0));
  const X = (v: number) => L + (x1 === x0 ? 0.5 : (v - x0) / (x1 - x0)) * pw, Y = (v: number) => T + ph - (v / (max || 1)) * ph;
  const d = points.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
  const area = `${d}L${X(points[points.length - 1].x)},${T + ph}L${X(points[0].x)},${T + ph}Z`;
  const step = pw / Math.max(points.length - 1, 1);
  const gid = `g${ariaLabel.replace(/\W/g, "")}`;
  return (
    <svg className="an-chart" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={ariaLabel}>
      <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".22" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      {[0, 1, 2, 3, 4].map((i) => { const t = (max * i) / 4; return <g key={i}><line className="an-grid-line" x1={L} x2={W - R} y1={Y(t)} y2={Y(t)} /><text x={L - 8} y={Y(t) + 4} textAnchor="end">{yFmt(t)}</text></g>; })}
      {(xTicks ?? [x0, (x0 + x1) / 2, x1]).map((t) => <text key={t} x={X(t)} y={H - 12} textAnchor="middle">{xFmt(t)}</text>)}
      <path d={area} fill={`url(#${gid})`} />
      <path d={d} fill="none" stroke={color} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
      {marker && (
        <>
          <line className="an-threshold" style={{ stroke: "var(--accent)" }} x1={X(marker.x)} x2={X(marker.x)} y1={T} y2={T + ph} />
          <circle cx={X(marker.x)} cy={Y(marker.y)} r={5} fill={color} stroke="var(--surface)" strokeWidth={2} />
          <text x={Math.min(X(marker.x) + 8, W - R - 4)} y={Math.max(T + 12, Y(marker.y) - 10)} textAnchor={X(marker.x) > W - 150 ? "end" : undefined} dx={X(marker.x) > W - 150 ? -16 : 0} style={{ fill: "var(--accent-ink)", fontWeight: 700 }}>{marker.label}</text>
        </>
      )}
      {points.map((p) => <rect key={p.x} className="an-hit" x={X(p.x) - step / 2} y={T} width={step} height={ph} data-tip={p.tip ?? `${xFmt(p.x)}\n${yFmt(p.y)}`} />)}
    </svg>
  );
}

export function Meter({ fraction, tone = "" }: { fraction: number | null; tone?: "" | "warn" | "danger" }) {
  const w = fraction === null ? 0 : Math.min(100, Math.max(0, fraction * 100));
  return <div className={`an-meter ${tone ? `an-${tone}` : ""}`} role="progressbar" aria-valuenow={Math.round(w)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${w}%` }} /></div>;
}

/** Small trend line. Draws nothing unless there are at least 3 real readings that actually differ. */
export function Sparkline({ values, color = "var(--c1)", w = 92, h = 30, label }: { values: number[]; color?: string; w?: number; h?: number; label: string }) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 3) return <span className="an-muted" data-tip="Not enough readings yet. The server records one reading per refresh.">-</span>;
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  if ((hi - lo) / Math.max(Math.abs(hi), 1e-9) < 1e-4) return <span className="an-muted" data-tip="No change across the readings recorded so far.">-</span>;
  const pts = v.map((x, i): [number, number] => [(i / (v.length - 1)) * (w - 6) + 3, h - 4 - ((x - lo) / span) * (h - 8)]);
  const last = pts[pts.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label}: ${v.length} readings`} data-tip={`${label}\n${v.length} readings recorded by this server`}>
      <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={2.6} fill={color} />
    </svg>
  );
}
