"use client";

/**
 * Earn chart (port of earn.js's live SvgChart replica): smooth line + violet gradient, y-axis
 * labels on the right with round ticks, x labels at the ends, hover crosshair + tooltip. Draws at
 * the container's real pixel width (ResizeObserver), so text is never stretched.
 *
 * `ChartCard` is the design's chart card (label, value, range chips, expand button) with its
 * small-screen tap-to-open variant and the expand modal.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Info, Modal } from "@/components/v3/ui";
import { usd } from "@/components/v3/format";
import { DAY, TFS, type SeriesPoint, type Tf } from "./earn-series";
import { Chips, SV } from "./earn-ui";
import { dLabel, fP } from "./earn-format";

const PAD = { top: 16, right: 58, bottom: 32, left: 4 };
const STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 7.5, 8, 10];

/** "dep" / "net" / "my" are USD; "apy" is a percent; "curve" is APY over utilization. */
export type ChartKind = "dep" | "net" | "my" | "apy" | "curve";

/** Four equal round steps covering the data (the design's `scale`). */
function scale(pts: SeriesPoint[], kind: ChartKind) {
  const vals = pts.map((p) => p.v);
  let mn = Math.min(...vals);
  let mx = Math.max(...vals);
  if (mn === mx || (kind !== "apy" && kind !== "curve" && mx - mn < Math.abs(mx) * 0.02)) mn = Math.min(0, mn);
  if (kind === "curve") mn = Math.min(0, mn);
  if (!(mx > mn)) mx = mn + 1;
  let mag = Math.pow(10, Math.floor(Math.log10((mx - mn) / 4)));
  let step = 0;
  let lo = 0;
  for (let k = 0; k < 6 && !step; k++, mag *= 10) {
    step = STEPS.map((x) => x * mag).find((x) => Math.floor(mn / x + 1e-9) * x + 4 * x >= mx - 1e-9) || 0;
    if (step) lo = Math.floor(mn / step + 1e-9) * step;
  }
  return { lo, step, hi: lo + 4 * step };
}

const short = (v: number) => (+v.toFixed(6)).toLocaleString("en-US", { maximumFractionDigits: 4 });
function yFmt(kind: ChartKind, v: number) {
  if (kind === "apy" || kind === "curve") return `${short(v)}%`;
  const a = Math.abs(v);
  if (a >= 1e6) return `${short(v / 1e6)}M`;
  if (a >= 1000) return `${short(v / 1000)}K`;
  return short(v);
}
function xFmt(t: number, ts: number[], kind: ChartKind) {
  if (kind === "curve") return `${Math.round(t)}%`;
  const span = (ts[ts.length - 1] - ts[0]) / DAY;
  const d = new Date(t);
  if (ts.length < 2) return d.toLocaleString("en-US", { month: "short", day: "numeric" });
  if (span > 365) return `${d.toLocaleString("en-US", { month: "short" })} '${String(d.getFullYear()).slice(-2)}`;
  if (span > 90) return d.toLocaleString("en-US", { month: "short" });
  if (span > 1) return d.toLocaleString("en-US", { month: "short", day: "numeric" });
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The SVG chart itself; `empty` shows when there are fewer than two points. */
export function EarnChart({ pts, kind, h, empty, tipSub }: { pts: SeriesPoint[]; kind: ChartKind; h: number; empty?: ReactNode; tipSub?: (p: SeriesPoint) => string }) {
  const uid = useId().replace(/:/g, "");
  const box = useRef<HTMLDivElement>(null);
  const [cw, setCw] = useState(0);
  const [hov, setHov] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCw(Math.floor(el.clientWidth)));
    ro.observe(el);
    setCw(Math.floor(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const n = pts.length;
  if (n < 2 || !cw) {
    return (
      <div className="earn-ch" ref={box} style={{ height: h }}>
        {cw > 0 && <div className="earn-chempty">{empty ?? "No data available"}</div>}
      </div>
    );
  }
  const W = cw - PAD.left - PAD.right;
  const Hh = h - PAD.top - PAD.bottom;
  const sc = scale(pts, kind);
  const range = sc.hi - sc.lo;
  const gx = (i: number) => PAD.left + (n > 1 ? (i / (n - 1)) * W : 0);
  const gy = (v: number) => PAD.top + Hh - ((v - sc.lo) / range) * Hh;
  const line = pts.reduce((acc, p, i) => {
    const x = gx(i);
    const y = gy(p.v);
    if (!i) return `M${x.toFixed(2)},${y.toFixed(2)}`;
    const px = gx(i - 1);
    const py = gy(pts[i - 1].v);
    return `${acc} C${(px + (x - px) * 0.35).toFixed(2)},${py.toFixed(2)} ${(x - (x - px) * 0.35).toFixed(2)},${y.toFixed(2)} ${x.toFixed(2)},${y.toFixed(2)}`;
  }, "");
  const base = PAD.top + Hh;
  const ticks = Array.from({ length: 5 }, (_, i) => sc.lo + sc.step * i);
  const xc = Math.min(4, n);
  const xi = Array.from({ length: xc }, (_, i) => Math.round((i / Math.max(1, xc - 1)) * (n - 1)));
  const ts = pts.map((p) => p.t);
  const money = kind === "dep" || kind === "net" || kind === "my";
  const hp = hov !== null ? pts[hov] : null;
  const hx = hov !== null ? gx(hov) : 0;
  const hy = hp ? gy(hp.v) : 0;

  return (
    <div className="earn-ch" ref={box} style={{ height: h }}>
      <svg
        className="earn-svg"
        viewBox={`0 0 ${cw} ${h}`}
        width={cw}
        height={h}
        aria-hidden="true"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const mxp = (e.clientX - r.left) * (cw / r.width) - PAD.left;
          setHov(Math.max(0, Math.min(n - 1, Math.round((mxp / W) * (n - 1)))));
        }}
        onMouseLeave={() => setHov(null)}
      >
        <defs>
          <linearGradient id={`egr${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--earn-ch-g0)" }} />
            <stop offset="100%" style={{ stopColor: "var(--earn-ch-g1)", stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        {ticks.map((v, k) => (
          <line key={k} x1={PAD.left} y1={gy(v).toFixed(2)} x2={(PAD.left + W).toFixed(2)} y2={gy(v).toFixed(2)} strokeWidth="1" style={{ stroke: "var(--earn-ch-grid)" }} />
        ))}
        <path d={`${line} L${gx(n - 1).toFixed(2)},${base} L${gx(0).toFixed(2)},${base} Z`} fill={`url(#egr${uid})`} />
        <path d={line} fill="none" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" style={{ stroke: "var(--earn-ch-line)" }} />
        {ticks.map((v, k) => (
          <text key={k} x={(PAD.left + W + 6).toFixed(2)} y={(gy(v) + 4).toFixed(2)} fontSize="11" textAnchor="start" style={{ fill: "var(--earn-ch-text)" }}>
            {yFmt(kind, v)}
          </text>
        ))}
        {xi.map((ix, i) => (
          <text key={i} x={gx(ix).toFixed(2)} y={h - 5} fontSize="11" textAnchor={i === 0 ? "start" : i === xc - 1 ? "end" : "middle"} style={{ fill: "var(--earn-ch-text)" }}>
            {xFmt(pts[ix].t, ts, kind)}
          </text>
        ))}
        {hp && (
          <g>
            <line x1={hx} x2={hx} y1={PAD.top} y2={base} strokeWidth="1" strokeDasharray="3 2" opacity=".5" style={{ stroke: "var(--earn-ch-line)" }} />
            <circle cx={hx} cy={hy} r="7" opacity=".12" style={{ fill: "var(--earn-ch-line)" }} />
            <circle cx={hx} cy={hy} r="3.5" style={{ fill: "var(--earn-ch-line)" }} />
          </g>
        )}
      </svg>
      {hp && (
        <div className="earn-tip" style={hx > cw * 0.65 ? { right: cw - hx + 12, top: Math.max(4, hy - 40) } : { left: hx + 12, top: Math.max(4, hy - 40) }}>
          <b>{kind === "apy" || kind === "curve" ? fP(hp.v) : money ? usd(hp.v) : yFmt(kind, hp.v)}</b>
          <span>{tipSub ? tipSub(hp) : dLabel(hp.t)}</span>
        </div>
      )}
    </div>
  );
}

/** Chart card with range chips, expand modal and the small-screen collapsible variant. */
export function ChartCard({
  label,
  value,
  tip,
  tf,
  onTf,
  pts,
  kind,
  h = 209,
  mobile = true,
  empty,
  note,
  className = "",
}: {
  label: string;
  value: ReactNode;
  tip?: string;
  tf: Tf;
  onTf: (t: Tf) => void;
  pts: SeriesPoint[];
  kind: ChartKind;
  h?: number;
  /** Render the tap-to-open variant below 640 px (list dashboard only). */
  mobile?: boolean;
  empty?: ReactNode;
  /** Small caveat under the chart (partial history etc.). */
  note?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const expandBtn = (sm?: boolean) => (
    <button type="button" className={`earn-exp${sm ? " sm" : ""}`} aria-label={`Expand ${label} chart`} onClick={() => setExpanded(true)}>
      {SV.expand}
    </button>
  );
  return (
    <>
      <div className={`earn-cc ${className}`}>
        <div className="earn-cch">
          <div>
            <h2>
              {label}
              {tip && <Info text={tip} />}
            </h2>
            <p className="num">{value}</p>
          </div>
          {expandBtn()}
        </div>
        <div className="earn-ccr">
          <Chips list={TFS} value={tf} onChange={onTf} />
        </div>
        <EarnChart pts={pts} kind={kind} h={h} empty={empty} />
        {note && <p className="earn-note">{note}</p>}
      </div>
      {mobile && (
        <div className={`earn-cm${open ? " on" : ""}`}>
          <button type="button" className="earn-cmh" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <span>
              <small>{label}</small>
              <b className="num">{value}</b>
            </span>
            <span className="earn-cmc">{SV.chev14}</span>
          </button>
          {open && (
            <div className="earn-cmb">
              <div className="earn-ccr">
                <Chips list={TFS} value={tf} onChange={onTf} sm />
                {expandBtn(true)}
              </div>
              <EarnChart pts={pts} kind={kind} h={180} empty={empty} />
              {note && <p className="earn-note">{note}</p>}
            </div>
          )}
        </div>
      )}
      {expanded && (
        <Modal wide className="earn-xmodal" onClose={() => setExpanded(false)}>
          <div className="earn earn-xm">
            <div className="earn-xmh">
              <div>
                <h2>{label}</h2>
                <p className="num">{value}</p>
              </div>
              <Chips list={TFS} value={tf} onChange={onTf} />
            </div>
            <EarnChart pts={pts} kind={kind} h={450} empty={empty} />
          </div>
        </Modal>
      )}
    </>
  );
}
