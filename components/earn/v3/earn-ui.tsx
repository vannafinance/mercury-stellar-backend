"use client";

/**
 * Small Earn V3 building blocks (ports of earn.js's SV icons, `tag`, `pie`, `chips`, and its
 * one-popover-at-a-time behaviour). Styled by ./earn-v3.css under the page's `.v3` root.
 */
import { useEffect, useState, type ReactNode } from "react";

/** The design's Earn line icons (SV in earn.js). */
export const SV = {
  sort: (
    <svg width="12" height="13" viewBox="0 0 12 13" aria-hidden="true">
      <path d="M6.866 2.733a.625.625 0 0 0 .883 0l.6-.6v8.492a.625.625 0 1 0 1.25 0V2.133l.6.6a.625.625 0 1 0 .883-.883L9.416.183a.625.625 0 0 0-.884 0L6.866 1.85a.625.625 0 0 0 0 .883zM2.932 10.783l.6-.6a.625.625 0 1 1 .884.883L2.749 12.733a.625.625 0 0 1-.884 0L.2 11.066a.625.625 0 1 1 .883-.883l.6.6V2.291a.625.625 0 0 1 1.25 0v8.492z" fill="currentColor" />
    </svg>
  ),
  chev: (
    <svg width="12" height="7" viewBox="0 0 12 7" aria-hidden="true">
      <path d="M.833.833l5 5 5-5" stroke="currentColor" strokeWidth="1.67" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  chev14: (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M19.5 8.25l-7.5 7.5-7.5-7.5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  chevL: (
    <svg width="8" height="14" viewBox="0 0 9 16" aria-hidden="true">
      <path d="M8 1L1 8l7 7" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  chevR: (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  chevLs: (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M7.5 2.5L4 6l3.5 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  search: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7.2" cy="7.2" r="5.4" stroke="currentColor" strokeWidth="1.3" fill="none" />
      <path d="M11.2 11.2L15 15" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  filter: (
    <svg width="17" height="12" viewBox="0 0 17 12" aria-hidden="true">
      <path d="M0 .833C0 .373.373 0 .833 0h15c.46 0 .834.373.834.833 0 .46-.373.834-.834.834h-15A.833.833 0 0 1 0 .833zM2.083 5.833c0-.46.373-.833.834-.833H13.75c.46 0 .833.373.833.833 0 .46-.373.834-.833.834H2.917a.833.833 0 0 1-.834-.834zM5.833 10a.833.833 0 0 0 0 1.667h5a.833.833 0 0 0 0-1.667h-5z" fill="currentColor" />
    </svg>
  ),
  filt14: (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6h16M8 12h8M11 18h2" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
    </svg>
  ),
  expand: (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M1 4V1h3M8 1h3v3M11 8v3H8M4 11H1V8" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  check: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-6.5" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  copy: (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.1" fill="none" />
      <path d="M8.5 2V1.8c0-.7-.6-1.3-1.3-1.3H2.3c-.7 0-1.3.6-1.3 1.3v4.9c0 .7.6 1.3 1.3 1.3h.2" stroke="currentColor" strokeWidth="1.1" fill="none" />
    </svg>
  ),
  link: (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M5 2H2v8h8V7M7 2h3v3M10 2L5.5 6.5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  clock: (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8" fill="none" />
      <path d="M12 6v6l4 2" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
    </svg>
  ),
  layers: (
    <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  eye: (
    <svg width="14" height="10" viewBox="0 0 14 10" aria-hidden="true">
      <path d="M6.67 7.27a2.73 2.73 0 1 0 0-5.45 2.73 2.73 0 0 0 0 5.45zm0-1.09a1.64 1.64 0 1 1 0-3.27 1.64 1.64 0 0 1 0 3.27zM6.67 9.09A7 7 0 0 1 0 4.55a7 7 0 0 1 13.33 0 7 7 0 0 1-6.66 4.54z" fill="currentColor" />
    </svg>
  ),
};

/** Small rounded tag; `kind` "st" = solid violet status, "pv" = soft violet. */
export function Tag({ children, kind = "" }: { children: ReactNode; kind?: string }) {
  return <span className={`earn-tag ${kind}`}>{children}</span>;
}

/** Donut ring showing `pct` (0–100). */
export function Pie({ pct, size = 24, stroke = 4 }: { pct: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct || 0));
  return (
    <svg className="earn-pie" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} style={{ stroke: "var(--earn-pie-track)" }} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${((c * p) / 100).toFixed(2)} ${c.toFixed(2)}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ stroke: "var(--earn-violet)" }}
      />
    </svg>
  );
}

/** Time-range chips (`.earn-chips`). */
export function Chips<T extends string>({ list, value, onChange, sm }: { list: readonly T[]; value: T; onChange: (v: T) => void; sm?: boolean }) {
  return (
    <nav className={`earn-chips${sm ? " sm" : ""}`} aria-label="Time Range Selection">
      {list.map((x) => (
        <button key={x} type="button" className={x === value ? "on" : ""} aria-pressed={x === value} onClick={() => onChange(x)}>
          {x}
        </button>
      ))}
    </nav>
  );
}

/**
 * One open popover at a time (the design's `S.open`): an outside mousedown or Escape closes it.
 * Each popover's wrapper carries `data-earn-pop="<id>"`.
 */
export function usePop() {
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.(`[data-earn-pop="${open}"]`)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, toggle: (id: string) => setOpen((o) => (o === id ? null : id)), close: () => setOpen(null) };
}

/** Empty-table placeholder (`.earn-nodata`). */
export function NoData({ text = "No data available" }: { text?: ReactNode }) {
  return (
    <section className="earn-nodata">
      <p>{text}</p>
    </section>
  );
}
