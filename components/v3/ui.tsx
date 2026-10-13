"use client";

/**
 * Shared V3 design components (ports of the prototype's core.js helpers), styled by app/v3.css:
 * Info tooltip, AreaChart, StatStrip, Banner (promo carousel), Modal, Seg (segmented control),
 * HfMeter. Every V3 page root carries the `v3` class so these styles apply.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { hfPos, LIQ_HF } from "@/lib/account-model";
import { nf, pct, usd } from "./format";
import { IC } from "./icons";

// ---------------------------------------------------------------------------------------------
// All app help icons share the same viewport-aware, accessible overlay.
// ---------------------------------------------------------------------------------------------
export function Info({ text, label }: { text: string; label?: string }) {
  return <InfoTooltip content={text} label={label ?? text} triggerClassName="info-i" size="regular" />;
}

// ---------------------------------------------------------------------------------------------
// Area / line chart (the design's areaChart): stretches to its container, HTML axis labels,
// hover shows every series' value at that point.
// ---------------------------------------------------------------------------------------------
export interface ChartSeries {
  name?: string;
  color: string;
  pts: number[];
  fill?: boolean;
  dash?: boolean;
}
const AC_FMT: Record<string, (v: number) => string> = {
  usd: (v) => usd(v),
  usd0: (v) => usd(v, 0),
  pct: (v) => pct(v),
  pct1: (v) => pct(v, 1),
  num: (v) => nf(v, 2),
};

export function AreaChart({
  series,
  h = 220,
  yFmt,
  xLabels,
  xTips,
  min,
  max,
  ticks = 4,
  fmtKey = "usd",
}: {
  series: ChartSeries[];
  h?: number;
  yFmt?: (v: number) => string;
  xLabels?: string[];
  xTips?: string[];
  min?: number;
  max?: number;
  ticks?: number;
  fmtKey?: keyof typeof AC_FMT;
}) {
  const uid = useId().replace(/:/g, "");
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const W = 1000;
  const ser = series.filter((s) => s.pts.length);
  const geo = useMemo(() => {
    if (!ser.length) return null;
    const all = ser.flatMap((s) => s.pts);
    let mn = min ?? Math.min(...all);
    let mx = max ?? Math.max(...all);
    if (mx - mn < 1e-9) {
      mx += 1;
      mn -= 1;
    }
    // Round ("nice") ticks: 0 / 40 / 80 / 120, never 42.42 / 84.85.
    const raw = (mx - mn) / ticks;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw) ?? 10 * mag;
    if (min === undefined) mn = Math.floor(mn / step + 1e-9) * step;
    if (max === undefined) mx = Math.ceil(mx / step - 1e-9) * step;
    if (mx - mn < step * 0.999) mx = mn + step;
    const tk = Math.max(1, Math.round((mx - mn) / step));
    const n = Math.max(...ser.map((s) => s.pts.length));
    const X = (i: number) => (n > 1 ? (i / (n - 1)) * W : 0);
    const Y = (v: number) => h - ((v - mn) / (mx - mn)) * h;
    const grid = Array.from({ length: tk + 1 }, (_, i) => mn + ((mx - mn) * i) / tk);
    return { n, X, Y, grid };
  }, [ser, min, max, ticks, h]);
  if (!geo) return null;
  const fmt = yFmt ?? ((v: number) => nf(v, 0));
  const tipFmt = AC_FMT[fmtKey] ?? AC_FMT.usd;
  const tips = xTips ?? xLabels ?? [];

  return (
    <div
      className="ac"
      ref={box}
      style={{ ["--h" as string]: `${h}px` }}
      onMouseMove={(e) => {
        const svg = box.current?.querySelector("svg");
        if (!svg) return;
        const r = svg.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right) return setHover(null);
        const bb = box.current!.getBoundingClientRect();
        const i = Math.max(0, Math.min(geo.n - 1, Math.round(((e.clientX - r.left) / r.width) * (geo.n - 1))));
        setHover({ i, x: e.clientX - bb.left, y: e.clientY - bb.top });
      }}
      onMouseLeave={() => setHover(null)}
    >
      <svg viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none" style={{ height: h }} aria-hidden="true">
        {geo.grid.map((v, k) => (
          <line key={k} x1="0" x2={W} y1={geo.Y(v).toFixed(1)} y2={geo.Y(v).toFixed(1)} stroke="var(--grid)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        {ser.map((s, si) => {
          const d = s.pts.map((v, i) => `${i ? "L" : "M"}${geo.X(i).toFixed(1)} ${geo.Y(v).toFixed(1)}`).join("");
          return (
            <g key={si}>
              <defs>
                <linearGradient id={`${uid}g${si}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor={s.color} stopOpacity=".22" />
                  <stop offset="1" stopColor={s.color} stopOpacity="0" />
                </linearGradient>
              </defs>
              {s.fill !== false && <path d={`${d}L${geo.X(s.pts.length - 1).toFixed(1)} ${h}L0 ${h}Z`} fill={`url(#${uid}g${si})`} />}
              <path d={d} fill="none" stroke={s.color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeDasharray={s.dash ? "5 4" : undefined} />
            </g>
          );
        })}
        {hover && (
          <line x1={((hover.i / Math.max(1, geo.n - 1)) * W).toFixed(1)} x2={((hover.i / Math.max(1, geo.n - 1)) * W).toFixed(1)} y1="0" y2={h} stroke="var(--axis)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      <div className="ac-y">
        {geo.grid
          .slice()
          .reverse()
          .map((v, k) => (
            <span key={k} className="num">
              {fmt(v)}
            </span>
          ))}
      </div>
      {xLabels && xLabels.length > 0 && (
        <div className="ac-x">
          {xLabels.map((l, k) => (
            <span key={k}>{l}</span>
          ))}
        </div>
      )}
      {hover && (
        <div className="ac-tip" style={{ left: hover.x, top: hover.y }}>
          {tips[hover.i] && <span>{tips[hover.i]}</span>}
          {ser.map((s, si) =>
            s.pts[hover.i] === undefined ? null : (
              <b key={si} className="num">
                <i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: s.color, marginRight: 6 }} />
                {s.name ?? ""} {tipFmt(s.pts[hover.i])}
              </b>
            ),
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Stats strip (the design's statStrip / live AccountStats).
// ---------------------------------------------------------------------------------------------
export interface StatItem {
  icon: ReactNode;
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  valueClass?: string;
}
/** `center`: the Margin page's strip look (icon + label on one centered line, centered value). */
export function StatStrip({ items, n, center = false }: { items: StatItem[]; n?: number; center?: boolean }) {
  return (
    <section className={`fs ${items.length % 2 ? "odd" : ""} ${center ? "c" : ""}`} style={{ ["--n" as string]: n ?? items.length }}>
      {items.map((it, k) => (
        <article key={k}>
          <div className="hd">
            <span className="ic">{it.icon}</span>
            <span className="k">{it.label}</span>
          </div>
          <div className={`v num ${it.valueClass ?? ""}`}>{it.value}</div>
          {it.sub !== undefined && <div className="s num">{it.sub}</div>}
        </article>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Promo carousel (the design's liveBanner): one slide at a time, dots, auto-advance every 5 s,
// paused while hovered.
// ---------------------------------------------------------------------------------------------
export const BANNER_SLIDES: Record<"earn" | "margin" | "farm", [string, string][]> = {
  earn: [
    ["Earn Yield on Your Assets", "Supply liquidity to Vanna vaults and earn yield from margin borrowers. No lockups — withdraw anytime while liquidity is available."],
    ["Multi-Collateral Vaults", "Deposit multiple assets as collateral and borrow against them. Diversify risk while maximizing capital efficiency."],
    ["Transparent & On-Chain", "Every rate, balance and position shown here is read directly from the Vanna Soroban contracts on Stellar."],
  ],
  margin: [
    ["Multicollateral Loans", "Don't want to sell your XLM and stablecoins? Borrow against them! Add multiple collaterals at the same time and draw a loan from Vanna's lending pools — then do whatever you want with that loan."],
    ["Flexible Borrowing", "Access instant liquidity without selling your assets. Use your crypto holdings as collateral and maintain your long-term positions while getting the funds you need today."],
    ["Maximize Capital", "Leverage your portfolio to its full potential. Borrow against multiple assets simultaneously and use the funds for trading, investing, or any other purpose you choose."],
  ],
  farm: [
    ["Farm DeFi Yields", "Provide liquidity to Blend, Aquarius and Soroswap straight from your margin account and earn their yield."],
    ["Leveraged Liquidity", "Deposit or borrow on the Margin page, then add your margin balance to a pool in one click."],
    ["Powered by Vanna Protocol", "LP positions stay in your Vanna margin account and count toward its health factor."],
  ],
};

const CAP = (
  <svg viewBox="0 0 44 37" aria-hidden="true">
    <path
      d="M22 0L0 12.3333L8 16.8144V29.1478L22 37L36 29.1478V16.8144L40 14.5739V28.7778H44V12.3333L22 0ZM35.64 12.3333L22 19.98L8.36 12.3333L22 4.68667L35.64 12.3333ZM32 26.7222L22 32.3133L12 26.7222V19.055L22 24.6667L32 19.055V26.7222Z"
      fill="var(--bn-cap)"
    />
  </svg>
);

export function Banner({ page, slides }: { page: keyof typeof BANNER_SLIDES | string; slides?: [string, string][] }) {
  const list = slides ?? BANNER_SLIDES[page as keyof typeof BANNER_SLIDES] ?? [];
  const [i, setI] = useState(0);
  const [phase, setPhase] = useState<"" | "bn-out" | "bn-pre">("");
  const hovered = useRef(false);
  const go = useCallback(
    (k: number) => {
      if (list.length < 2) return;
      setPhase("bn-out");
      setTimeout(() => {
        setI(((k % list.length) + list.length) % list.length);
        setPhase("bn-pre");
        requestAnimationFrame(() => requestAnimationFrame(() => setPhase("")));
      }, 400);
    },
    [list.length],
  );
  useEffect(() => {
    if (list.length < 2) return;
    const id = setInterval(() => {
      if (!hovered.current && !document.hidden) go(i + 1);
    }, 5000);
    return () => clearInterval(id);
  }, [i, go, list.length]);
  if (!list.length) return null;
  const [t, d] = list[i];
  return (
    <section className="bn" aria-roledescription="carousel" aria-label={list[0][0]} onMouseEnter={() => (hovered.current = true)} onMouseLeave={() => (hovered.current = false)}>
      <span className="bn-tx" aria-hidden="true" />
      <div className="bn-in" role="region" aria-label="Carousel" aria-live="polite">
        <div className="bn-l">
          <span className="bn-ic">{CAP}</span>
          <div className={`bn-t ${phase}`}>{t}</div>
        </div>
        <span className="bn-d" aria-hidden="true" />
        <div className={`bn-x ${phase}`}>{d}</div>
      </div>
      {list.length > 1 && (
        <div className="bn-dots" role="tablist" aria-label="Carousel navigation">
          {list.map((s, k) => (
            <button key={k} type="button" role="tab" className={k === i ? "on" : ""} aria-selected={k === i} aria-label={`Go to slide ${k + 1}: ${s[0]}`} onClick={() => go(k)} />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Modal (the design's openModal): backdrop click / Escape / × close it.
// ---------------------------------------------------------------------------------------------
export function Modal({ children, onClose, wide, className = "", noClose }: { children: ReactNode; onClose: () => void; wide?: boolean; className?: string; noClose?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !noClose && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose, noClose]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="v3">
      <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && !noClose && onClose()}>
        <div className={`modal ${wide ? "wide" : ""} ${className}`} role="dialog" aria-modal="true">
          {!noClose && (
            <button type="button" className="modal-x" onClick={onClose} aria-label="Close">
              {IC.x}
            </button>
          )}
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------------------------
// Segmented control (`.seg`).
// ---------------------------------------------------------------------------------------------
export function Seg<T extends string>({ value, options, onChange, small, className = "" }: { value: T; options: [T, ReactNode][]; onChange: (v: T) => void; small?: boolean; className?: string }) {
  return (
    <div className={`seg ${small ? "sm" : ""} ${className}`} role="tablist">
      {options.map(([v, l]) => (
        <button key={v} type="button" role="tab" aria-selected={value === v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Health-factor meter (`.hfbar`): liquidation tick at 1.10 and the account's marker.
// ---------------------------------------------------------------------------------------------
export function HfMeter({ hf, after }: { hf: number; after?: number | null }) {
  return (
    <div className="hfbar" aria-hidden="true">
      <i style={{ left: `${hfPos(LIQ_HF)}%`, background: "var(--danger)" }} />
      <i style={{ left: `${hfPos(hf)}%`, opacity: after !== undefined && after !== null ? 0.4 : 1 }} />
      {after !== undefined && after !== null && <i style={{ left: `${hfPos(after)}%` }} />}
    </div>
  );
}
