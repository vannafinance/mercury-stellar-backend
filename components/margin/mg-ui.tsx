"use client";

/**
 * Small building blocks of the V3 Margin screen (ports of the design's margin.js helpers):
 * token dropdown, % chips, price-ratio pill, before → after preview rows, the leverage slider and
 * the screen's own icons. Styled by ./margin-v3.css (classes `mg-*`). Pure UI — no chain reads.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Info } from "@/components/v3/ui";
import { Icon, IC } from "@/components/v3/icons";
import { nf, usd } from "@/components/v3/format";

// ---------------------------------------------------------------------------------------------
// Icons (the design's margin.js svgs)
// ---------------------------------------------------------------------------------------------
const P = { stroke: "currentColor", fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
export const MI = {
  chev16: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 6l4 4 4-4" {...P} strokeWidth="1.6" />
    </svg>
  ),
  swap9: (
    <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3.5 1.5v9M1.5 8.5l2 2 2-2M8.5 10.5v-9M6.5 3.5l2-2 2 2" {...P} strokeWidth="1.3" />
    </svg>
  ),
  plus11: (
    <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
      <path d="M5.33.67V10M.67 5.33H10" stroke="currentColor" strokeWidth="1.33" strokeLinecap="round" />
    </svg>
  ),
  pen: (
    <svg width="10" height="10" viewBox="0 0 13 14" aria-hidden="true">
      <path d="M0 13.33V10.9h12.12v2.43zM1.21 9.7V7.12L8 .35a1.2 1.2 0 0 1 1.72.01l.84.85a1.2 1.2 0 0 1 0 1.71L3.79 9.7zm7.64-6.79l.85-.85-.85-.85-.85.85z" fill="currentColor" />
    </svg>
  ),
  dash: (
    <svg width="10" height="3" viewBox="0 0 14 3" aria-hidden="true">
      <path d="M13.38 2.18H0V0h13.38z" fill="currentColor" />
    </svg>
  ),
  copy: (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M8.5 3.5V2.5a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h1" stroke="currentColor" strokeWidth="1.2" fill="none" />
    </svg>
  ),
  chev13: (
    <svg width="12" height="7" viewBox="0 0 13 8" aria-hidden="true">
      <path d="M11.91 0l1.06 1.06-5.78 5.78a1 1 0 0 1-1.41 0L0 1.06 1.06 0l5.43 5.43z" fill="currentColor" />
    </svg>
  ),
  prev: (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M7.5 9L4.5 6l3-3" {...P} strokeWidth="1.5" />
    </svg>
  ),
  next: (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4.5 9l3-3-3-3" {...P} strokeWidth="1.5" />
    </svg>
  ),
  alert: (
    <svg width="24" height="24" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M8.26 3.1a2 2 0 0 1 3.48 0l5.58 9.92A2 2 0 0 1 15.58 16H4.42a2 2 0 0 1-1.74-2.98zM11 13a1 1 0 1 0-2 0 1 1 0 0 0 2 0zm-1-8a1 1 0 0 0-1 1v3a1 1 0 0 0 2 0V6a1 1 0 0 0-1-1z" fill="currentColor" />
    </svg>
  ),
  thumb: (
    <svg width="26" height="26" viewBox="0 0 36 36" aria-hidden="true">
      <rect width="36" height="36" rx="18" className="mg-thc" />
      <path fill="#fff" d="M18.09 8.35a1.72 1.72 0 0 1 1.88.04l.33.23a1.72 1.72 0 0 1 .68 1.76l-1.14 5.07-2.11 9.38 8.09-5.19 1.84 1.29a.2.2 0 0 1-.01.47l-9.74 6.25a1.72 1.72 0 0 1-1.88-.04l-.33-.23a1.72 1.72 0 0 1-.68-1.76l1.14-5.07 2.11-9.38-8.09 5.19-1.84-1.29a.2.2 0 0 1 .01-.47z" />
      <path fill="#fff" d="M10.18 16.36l2.02 1.42-.68 3.03 2.62-1.67 2.02 1.42-4.38 2.81a1.72 1.72 0 0 1-1.88-.04l-.18-.13a1.72 1.72 0 0 1-.68-1.75z" />
      <path fill="#fff" d="M25.82 19.64l-2.02-1.42.68-3.03-2.62 1.67-2.02-1.42 4.38-2.81a1.72 1.72 0 0 1 1.88.04l.18.13a1.72 1.72 0 0 1 .68 1.75z" />
    </svg>
  ),
};

/** AccountStats glyphs (violet shapes with cut-out strokes in the strip's circle colour). */
const cut = { className: "mg-cut" };
export const SIC = {
  health: (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1" y="1" width="14" height="14" rx="4" fill="currentColor" />
      <path d="M3.4 8.6h2.1l1.5-3.2 2 5.4 1.5-2.8h2.1" {...cut} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  liq: (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1" y="2.5" width="14" height="11" rx="2.2" fill="currentColor" />
      <path d="M1.5 5.6h13" {...cut} strokeWidth="1.4" />
      <path d="M10.6 9.8H5.8m0 0l1.6-1.5M5.8 9.8l1.6 1.5" {...cut} strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  dollar: (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="M10.2 5.6c-.4-.7-1.2-1.1-2.2-1.1-1.3 0-2.2.7-2.2 1.7 0 2.3 4.6 1.2 4.6 3.6 0 1-.9 1.7-2.4 1.7-1 0-1.9-.4-2.3-1.2M8 3.4v1.1m0 7v1.1" {...cut} strokeWidth="1.3" fill="none" strokeLinecap="round" />
    </svg>
  ),
  retry: (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.2 2.2h5.6l1 1.6h1.4A1.8 1.8 0 0 1 15 5.6v6.6a1.8 1.8 0 0 1-1.8 1.8H2.8A1.8 1.8 0 0 1 1 12.2V5.6a1.8 1.8 0 0 1 1.8-1.8h1.4z" fill="currentColor" />
      <path d="M5.4 9.6a2.7 2.7 0 1 0 .8-2.2M5.2 6.1v1.6h1.6" {...cut} strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  bag: (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.5 3.6V2.8A1.3 1.3 0 0 1 6.8 1.5h2.4a1.3 1.3 0 0 1 1.3 1.3v.8" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <rect x="1" y="3.8" width="14" height="10.7" rx="2" fill="currentColor" />
      <path d="M8 7.2v3.6M6.2 9h3.6" {...cut} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
};

// ---------------------------------------------------------------------------------------------
// Popover state: one open dropdown per screen, closed by a click outside it or Escape.
// ---------------------------------------------------------------------------------------------
export function usePop() {
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest(`[data-pop="${open}"]`)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, toggle: (k: string) => setOpen((o) => (o === k ? null : k)) };
}
export type Pop = ReturnType<typeof usePop>;

/** The token pill with its option list (the design's `tokDD`). */
export function TokenDropdown({ id, sym, list, pop, onPick, b2 }: { id: string; sym: string; list: readonly string[]; pop: Pop; onPick: (s: string) => void; b2?: boolean }) {
  const open = pop.open === id;
  return (
    <span className="mg-ddw" data-pop={id}>
      <button type="button" className={`mg-tok ${b2 ? "b2" : ""}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => pop.toggle(id)}>
        <Icon sym={sym} className="ico mg-ti" />
        <span>{sym}</span>
        <span className="mg-cv">{MI.chev16}</span>
      </button>
      {open && (
        <div className="pop mg-pop" role="listbox">
          {list.map((s) => (
            <button
              key={s}
              type="button"
              className={`mg-opt ${s === sym ? "on" : ""}`}
              role="option"
              aria-selected={s === sym}
              onClick={() => {
                onPick(s);
                pop.setOpen(null);
              }}
            >
              <Icon sym={s} />
              {s}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

export const PCTS = [10, 25, 50, 100] as const;

/** 10 / 25 / 50 / 100 % quick-fill chips. */
export function PctChips({ value, onPick, label }: { value: number; onPick: (p: number) => void; label: string }) {
  return (
    <div className="mg-chips" role="group" aria-label={label}>
      {PCTS.map((p) => (
        <button key={p} type="button" className={`mg-pc p${p} ${value === p ? "on" : ""}`} aria-pressed={value === p} onClick={() => onPick(p)}>
          {p}%
        </button>
      ))}
    </div>
  );
}

const pxFmt = (v: number) => (v >= 1 ? nf(v, 2) : v >= 0.01 ? nf(v, 4) : nf(v, 6));
const perUsd = (v: number) => (v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toFixed(6));

/** "1 XLM = $0.16" pill; a click flips it to "$1 = 6.25 XLM". */
export function RatioBtn({ sym, price }: { sym: string; price: number }) {
  const [inv, setInv] = useState(false);
  const text = !(price > 0) ? `1 ${sym} = ${usd(0)}` : inv ? `$1 = ${perUsd(1 / price)} ${sym}` : `1 ${sym} = $${pxFmt(price)}`;
  return (
    <button type="button" className="mg-ratio" aria-label="Swap the price direction" onClick={() => setInv((v) => !v)}>
      <span>{text}</span>
      {MI.swap9}
    </button>
  );
}

/** A label whose info icon is glued to its last word (never alone on a line). */
export function LblTip({ k, tip }: { k: string; tip?: string }) {
  if (!tip) return <>{k}</>;
  const i = k.lastIndexOf(" ");
  return (
    <>
      {k.slice(0, i + 1)}
      <span className="mg-nw">
        {k.slice(i + 1)}
        <Info text={tip} />
      </span>
    </>
  );
}

/** One "label   before → after" line of a preview. */
export function PrevRow({ label, b, a, tone, tip }: { label: string; b?: ReactNode; a: ReactNode; tone?: "up" | "dn" | ""; tip?: string }) {
  return (
    <div className="mg-pr">
      <span>
        {label}
        {tip && <Info text={tip} />}
      </span>
      <span className="mg-pv num">
        {b !== undefined && b !== null && (
          <>
            <span className="o">{b}</span>
            <span className="a">{IC.arrow}</span>
          </>
        )}
        <b className={tone ?? ""}>{a}</b>
      </span>
    </div>
  );
}

/** The "Transaction Details" box. */
export function PrevBox({ children, flush }: { children: ReactNode; flush?: boolean }) {
  return (
    <div className={`mg-prev ${flush ? "flush" : ""}`}>
      <h4>Transaction Details</h4>
      {children}
    </div>
  );
}

/** Health-factor tone of a before → after pair. */
export const toneHf = (b: number, a: number): "up" | "dn" => (a >= b - 1e-9 ? "up" : "dn");

/** Slider markers: 1x, whole multiples in between, and the max. */
const markers = (max: number) => {
  const whole = Math.floor(max);
  const stride = whole > 8 ? Math.ceil((whole - 1) / 4) : whole > 5 ? 2 : 1;
  const out: number[] = [];
  for (let m = 1; m < max - 0.25; m += stride) out.push(m);
  out.push(max);
  return out;
};

/** The design's leverage slider: gradient fill, glowing markers, bolt thumb, "nX" labels. */
export function LevSlider({ lev, max, onChange }: { lev: number; max: number; onChange: (v: number) => void }) {
  const v = Math.min(lev, max);
  const pc = (x: number) => (max > 1 ? ((x - 1) / (max - 1)) * 100 : 0);
  const p = pc(v);
  const mk = markers(max);
  const lastP = pc(mk[mk.length - 1]);
  return (
    <div className="mg-sl">
      <input
        type="range"
        className="mg-sl-in"
        min={1}
        max={max}
        step={0.01}
        value={v}
        aria-label="Leverage"
        onChange={(e) => onChange(Math.round(Number(e.target.value) * 100) / 100)}
      />
      <div className="mg-slv">
        <div className="mg-tr">
          <div className="mg-fill" style={{ width: `${p}%` }} />
          {mk.map((m) => {
            const mp = pc(m);
            const on = p >= mp - 1e-6;
            const t = Math.round(mp);
            const c = `color-mix(in srgb,var(--mg-p10) ${t}%,var(--mg-p25))`;
            return <span key={m} className={`mg-mk ${on ? "on" : ""}`} style={{ left: `${mp}%`, ...(on ? { background: c, boxShadow: `0 0 8px color-mix(in srgb,${c} 50%,transparent)` } : {}) }} />;
          })}
          <span className="mg-th" style={{ left: `${p}%` }}>
            {MI.thumb}
          </span>
        </div>
        <div className="mg-lbls">
          {mk.map((m, i) => (
            <span
              key={m}
              className={`${i === 0 ? "first" : i === mk.length - 1 ? "last" : lastP - pc(m) < 14 ? "nl" : ""} ${Math.abs(v - m) < 0.5 ? "on" : ""}`}
              style={{ left: `${pc(m)}%` }}
            >
              {Number.isInteger(m) ? m : m.toFixed(2)}X
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Tooltip copy shared by the screen (the Soroban RiskEngine's real rules, not the design's sample ones). */
export const TIPS = {
  hf: "Health factor: everything in your margin account (collateral, idle borrowed funds and farm positions) divided by everything it owes, unweighted. At 1.10 or below the account can be liquidated, and the RiskEngine rejects any borrow or withdrawal that would take it there.",
  lev: "Account leverage: everything the account holds (borrowed funds included) divided by your equity (holdings minus debt). 1.00x means no borrowing.",
  borrowed: "Borrowed: everything your margin account owes, at today's on-chain oracle prices, including interest accrued so far.",
  equity: "Equity: everything in your margin account minus what it owes.",
  value: "Account value: everything in your margin account (collateral, idle borrowed funds and farm positions) before subtracting debt.",
  buffer: "How much value the account can lose before its health factor reaches 1.10 and it can be liquidated: holdings − 1.10 × debt.",
  room: "Room before liquidation: the smallest single price move that takes the health factor to 1.10, every other price held. The second line moves all volatile prices together.",
  interest: "Interest accrued on your loans: current on-chain debt minus net cash borrowed (borrows − repays from the indexed on-chain events). Unknown loans (opened before indexing) are left out rather than guessed.",
  rate: "The yearly borrow rate of your largest loan's lending pool (its on-chain rate curve).",
  avail: "Selected asset held in your margin account (borrowed tokens included).",
};
