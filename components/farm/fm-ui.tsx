"use client";

/**
 * Small building blocks of the V3 Farm screen (ports of the design's farm.js helpers): table cells,
 * sortable header row, venue labels / tags, boxed tabs, range chips, tiles, the yield list, the
 * "How it works" card, the back link and the checkbox dropdown. Styled by ./farm-v3.css.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Icon, IC } from "@/components/v3/icons";
import { Info } from "@/components/v3/ui";

/** Venue name → logo key (public/logos-v3). */
const VSYM: Record<string, string> = { Blend: "BLEND", Aquarius: "AQUARIUS", Soroswap: "SOROSWAP" };

/** One table cell: value line plus optional mini chips. */
export function Cell({ v, mini, cls = "" }: { v: ReactNode; mini?: ReactNode | ReactNode[]; cls?: string }) {
  const minis = mini === undefined || mini === null || mini === "" ? [] : Array.isArray(mini) ? mini : [mini];
  return (
    <span className="fm-cell">
      <span className={`fm-cv ${cls}`}>{v}</span>
      {minis.length > 0 && (
        <span className="fm-cs">
          {minis.map((m, k) => (
            <span key={k} className="fm-mini">
              {m}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/** "Blend" / "Aquarius" / "Soroswap" with the venue's logo. */
export function Venue({ name, cls = "fm-ico16" }: { name: string; cls?: string }) {
  return (
    <span className="fm-ven">
      {name.split(" · ").map((n) => (VSYM[n] ? <Icon key={n} sym={VSYM[n]} className={cls} /> : null))}
      <span>{name}</span>
    </span>
  );
}

/** Violet header tag with the venue logo. */
export function VTag({ name }: { name: string }) {
  return (
    <span className="fm-tag">
      {VSYM[name] && <Icon sym={VSYM[name]} className="fm-ico14 t" />}
      {name}
    </span>
  );
}

export type SortState = { k: string; dir: 1 | -1 } | null;

/** Header row; each label sorts the rows (click again to flip). cols: [label, key, tip?]. */
export function SortHead({ cols, cls, sort, onSort }: { cols: [string, string, string?][]; cls: string; sort: SortState; onSort: (s: SortState) => void }) {
  return (
    <div className={`fm-tr fm-th ${cls}`}>
      {cols.map(([l, k, tip]) => (
        <span key={k} className="fm-thc">
          <button
            type="button"
            className={`fm-thb ${sort?.k === k ? "on" : ""}`}
            aria-label={`Sort by ${l}`}
            onClick={() => onSort(sort?.k === k ? { k, dir: sort.dir === 1 ? -1 : 1 } : { k, dir: -1 })}
          >
            <i className="fm-sort">{IC.sort}</i>
            {l}
          </button>
          {tip && <Info text={tip} />}
        </span>
      ))}
    </div>
  );
}

/** Sort rows by `v[key]` (numbers numerically, strings alphabetically). */
export function sortRows<T extends { v: Record<string, string | number> }>(items: T[], sort: SortState): T[] {
  if (!sort) return items;
  return items.slice().sort((a, b) => {
    const x = a.v[sort.k];
    const y = b.v[sort.k];
    return (typeof x === "string" ? String(x).localeCompare(String(y)) : (Number(x) || 0) - (Number(y) || 0)) * sort.dir;
  });
}

/** The vault pages' boxed tabs (h48, gradient border on the active one). */
export function TabsBox<T extends string>({ items, value, onChange }: { items: [T, string][]; value: T; onChange: (v: T) => void }) {
  return (
    <nav className="fm-tabs" role="tablist">
      {items.map(([k, l]) => (
        <button key={k} type="button" role="tab" aria-selected={value === k} className={value === k ? "on" : ""} onClick={() => onChange(k)}>
          {l}
        </button>
      ))}
    </nav>
  );
}

/** Range chips (1 Week / 1 Month / …). */
export function Chips({ value, options, onChange }: { value: number; options: [number, string][]; onChange: (v: number) => void }) {
  return (
    <div className="fm-chips">
      {options.map(([d, l]) => (
        <button key={d} type="button" className={value === d ? "on" : ""} onClick={() => onChange(d)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Tiles({ items }: { items: [string, ReactNode][] }) {
  return (
    <div className="fm-tiles num">
      {items.map(([k, v]) => (
        <div key={k} className="fm-tile">
          <span>{k}</span>
          <b>{v}</b>
        </div>
      ))}
    </div>
  );
}

export function YieldList({ rows }: { rows: [string, ReactNode, string?][] }) {
  return (
    <div className="fm-yp num">
      {rows.map(([k, v, c]) => (
        <div key={k}>
          <span>{k}</span>
          <span className={c ?? ""}>{v}</span>
        </div>
      ))}
    </div>
  );
}

export function HowItWorks({ steps }: { steps: [string, string][] }) {
  return (
    <div className="fm-how">
      <p>How it works</p>
      {steps.map(([b, s], i) => (
        <div key={b} className="fm-step">
          <i>{i + 1}</i>
          <div>
            <b>{b}</b>
            <span>{s}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

const BACK_ICON = (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M7.5 9.5L4 6l3.5-3.5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export function BackLink({ href = "/farm" }: { href?: string }) {
  return (
    <Link className="fm-back" href={href}>
      {BACK_ICON}Back to pools
    </Link>
  );
}

/** Close a popover on an outside click or Escape. */
export function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

/**
 * The design's checkbox dropdown (All Pools / Vaults / transaction type): a search field and a
 * multi-select list. `trigger` renders the button; `right` aligns the popover to the right edge.
 */
export function CheckDropdown({
  options,
  selected,
  onChange,
  placeholder,
  trigger,
  right,
  withIcons = true,
}: {
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  right?: boolean;
  withIcons?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useOutside(open, () => setOpen(false));
  const list = options.filter((o) => !q.trim() || o.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <span className="fm-ddw" ref={ref}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div className={`pop ${right ? "r" : ""} fm-cpop`} role="listbox" aria-multiselectable="true">
          <label className="fm-psearch">
            {IC.search}
            <input placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} aria-label={placeholder} autoComplete="off" />
          </label>
          <div className="fm-cl">
            {list.length ? (
              list.map((a) => {
                const on = selected.includes(a);
                return (
                  <button
                    key={a}
                    type="button"
                    className={`fm-co ${on ? "on" : ""}`}
                    role="option"
                    aria-selected={on}
                    onClick={() => onChange(on ? selected.filter((z) => z !== a) : selected.concat(a))}
                  >
                    <span className="fm-cb">{on ? IC.check : null}</span>
                    {withIcons && <Icon sym={a} className="fm-ico16" />}
                    {a}
                  </button>
                );
              })
            ) : (
              <p className="fm-cnone">No match</p>
            )}
          </div>
          {selected.length > 0 && (
            <button type="button" className="fm-reset" onClick={() => onChange([])}>
              Show all
            </button>
          )}
        </div>
      )}
    </span>
  );
}
