"use client";

/**
 * Earn table (port of earn.js `liveTable`): grid rows on desktop (≥ 1280 px), accordion rows below,
 * sortable columns, optional hidden columns ("Customize"), row click / "View Details".
 */
import { useState, type ReactNode } from "react";
import { Info } from "@/components/v3/ui";
import { Icon, IC } from "@/components/v3/icons";
import { Pie, SV, Tag } from "./earn-ui";
import { fP } from "./earn-format";

export interface Col {
  id: string;
  label: string;
  sort?: boolean;
  tip?: string;
}

/** One cell; `t` is the main line, `d` the sub line, `tags` small chips below. */
export interface Cell {
  t: ReactNode;
  /** Plain text of `t`, for search / sort fallback. */
  text?: string;
  /** Sort value. */
  v?: number;
  d?: ReactNode;
  /** Token logo before the value. */
  ic?: string;
  /** Show the Stellar chain badge before the logo. */
  chain?: boolean;
  /** Status tags (first column). */
  st?: string[];
  tip?: string;
  tags?: string[];
  pie?: number;
  bar?: { pct: number; v: string };
  /** Free-form content instead of the standard layout. */
  node?: ReactNode;
}

export interface Row {
  key: string;
  cells: Cell[];
  onClick?: () => void;
  cls?: string;
}

const textOf = (c: Cell | undefined) => (c ? (c.text ?? (typeof c.t === "string" || typeof c.t === "number" ? String(c.t) : "")) : "");
const numOf = (s: string): number | null => {
  const m = s.replace(/,/g, "").match(/(-?\d+\.?\d*)\s*([KMB%])?/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const k = (m[2] || "").toUpperCase();
  return v * (k === "K" ? 1e3 : k === "M" ? 1e6 : k === "B" ? 1e9 : 1);
};

function CellView({ c, mobile }: { c: Cell | undefined; mobile: boolean }) {
  if (!c) return <div className="earn-c" />;
  if (c.node) return <div className="earn-c">{c.node}</div>;
  if (c.bar) {
    return (
      <div className="earn-c wide">
        <div className="earn-prog">
          <i style={{ width: `${Math.min(100, c.bar.pct)}%` }} />
        </div>
        <div className="earn-barv">
          <span className="num">{fP(c.bar.pct)}</span>
          <span className="num">{c.bar.v}</span>
        </div>
      </div>
    );
  }
  const st = (c.st ?? []).map((s) => (
    <Tag key={s} kind={s === "Active" ? "st" : "pv"}>
      {s}
    </Tag>
  ));
  return (
    <div className="earn-c">
      <div className="earn-cv">
        {c.chain && <Icon sym="XLM" className="earn-chain" />}
        {c.ic && <Icon sym={c.ic} className="earn-i16" />}
        {c.pie !== undefined && <Pie pct={c.pie} />}
        <span className="earn-ct num">
          {c.t}
          {mobile && st.length > 0 && (
            <span className="earn-tags in">
              {st}
              {c.tip && <Info text={c.tip} />}
            </span>
          )}
        </span>
      </div>
      {c.d !== undefined && c.d !== null && c.d !== "" && <span className="earn-cd num">{c.d}</span>}
      {!mobile && st.length > 0 && (
        <div className="earn-tags">
          {st}
          {c.tip && <Info text={c.tip} />}
        </div>
      )}
      {c.tags && c.tags.length > 0 && (
        <div className="earn-tags">
          {c.tags.map((x) => (
            <Tag key={x}>{x}</Tag>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Sortable table. `hidden` lists column ids not shown (first column always shows).
 * `noHead` drops the header row (cap-usage tables in the design have their own).
 */
export function LiveTable({ cols, rows, hidden = [], cls = "", noHead }: { cols: Col[]; rows: Row[]; hidden?: string[]; cls?: string; noHead?: boolean }) {
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" } | null>(null);
  const [acc, setAcc] = useState<Record<string, boolean>>({});

  const keep = cols.map((c, i) => i === 0 || !hidden.includes(c.id));
  const vCols = cols.filter((_, i) => keep[i]);
  let vRows = rows.map((r) => ({ ...r, cells: r.cells.filter((_, i) => keep[i]) }));
  if (sort) {
    const ci = vCols.findIndex((c) => c.id === sort.col);
    if (ci >= 0) {
      vRows = vRows.slice().sort((a, b) => {
        const A = a.cells[ci];
        const B = b.cells[ci];
        const x = A?.v ?? numOf(textOf(A));
        const y = B?.v ?? numOf(textOf(B));
        const r = x !== null && y !== null ? x - y : textOf(A).localeCompare(textOf(B));
        return sort.dir === "desc" ? -r : r;
      });
    }
  }
  const clickSort = (id: string) => setSort((s) => (s && s.col === id ? { col: id, dir: s.dir === "asc" ? "desc" : "asc" } : { col: id, dir: "asc" }));

  return (
    <div className={`earn-tw ${cls}`}>
      <div className="earn-tbl" role="table" style={{ ["--n" as string]: vCols.length }}>
        {!noHead && (
          <div className="earn-trh" role="row">
            {vCols.map((c) => (
              <div key={c.id} className="earn-th" role="columnheader">
                {c.sort && (
                  <button
                    type="button"
                    className={`earn-sort${sort?.col === c.id ? " on" : ""}${sort?.col === c.id && sort.dir === "desc" ? " desc" : ""}`}
                    aria-label={`Sort by ${c.label}`}
                    onClick={() => clickSort(c.id)}
                  >
                    {SV.sort}
                  </button>
                )}
                {c.label}
                {c.tip && <Info text={c.tip} />}
              </div>
            ))}
          </div>
        )}
        <div className="earn-tbody">
          {vRows.map((r) => (
            <div key={r.key} className={`earn-tr${r.onClick ? " go" : ""}${r.cls ? ` ${r.cls}` : ""}`} role="row" onClick={r.onClick}>
              {r.cells.map((c, i) => (
                <CellView key={i} c={c} mobile={false} />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="earn-mtbl">
        {vRows.map((r) => {
          const open = !!acc[r.key];
          return (
            <div key={r.key} className={`earn-mr${r.cls ? ` ${r.cls}` : ""}`}>
              <button type="button" className="earn-mh" aria-expanded={open} onClick={() => setAcc((a) => ({ ...a, [r.key]: !a[r.key] }))}>
                <CellView c={r.cells[0]} mobile />
                <span className={`earn-mchev${open ? " on" : ""}`}>{SV.chev14}</span>
              </button>
              {open && (
                <>
                  <div className="earn-mx">
                    {r.cells.slice(1).map((c, i) => (
                      <div key={i} className="earn-mk">
                        <span>{vCols[i + 1]?.label}</span>
                        <span className="earn-mv num">
                          {c ? (c.bar ? `${fP(c.bar.pct)} · ${c.bar.v}` : (c.node ?? c.t)) : ""}
                          {c?.d !== undefined && c?.d !== null && c?.d !== "" && <small>{c.d}</small>}
                          {c?.tags?.map((x) => (
                            <Tag key={x} kind="sm">
                              {x}
                            </Tag>
                          ))}
                        </span>
                      </div>
                    ))}
                  </div>
                  {r.onClick && (
                    <button type="button" className="earn-mgo" onClick={r.onClick}>
                      View Details {IC.arrow}
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Column picker ("Customize"): toggles which columns a LiveTable shows. */
export function Customize({ cols, hidden, onChange, open, onToggle, popId }: { cols: Col[]; hidden: string[]; onChange: (h: string[]) => void; open: boolean; onToggle: () => void; popId: string }) {
  return (
    <div className="earn-ddw" data-earn-pop={popId}>
      <button type="button" className="earn-dd" aria-expanded={open} onClick={onToggle}>
        {SV.eye}
        <span>Customize</span>
        <span className="earn-ddc">{SV.chev}</span>
      </button>
      {open && (
        <div className="pop earn-pop r" role="dialog" aria-label="Columns">
          <div className="earn-selh">
            <span>Columns shown</span>
            {hidden.length > 0 && (
              <button type="button" onClick={() => onChange([])}>
                Show all
              </button>
            )}
          </div>
          <div className="earn-opts">
            {cols.slice(1).map((c) => {
              const on = !hidden.includes(c.id);
              return (
                <button key={c.id} type="button" className="earn-opt" role="checkbox" aria-checked={on} onClick={() => onChange(on ? [...hidden, c.id] : hidden.filter((x) => x !== c.id))}>
                  <span className={`earn-cb${on ? " on" : ""}`}>{on ? SV.check : null}</span>
                  <span>{c.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** "1 of 2" pager. */
export function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  return (
    <div className="earn-pager">
      <button type="button" className="earn-pgb" aria-label="Previous page" disabled={page <= 0} onClick={() => onPage(page - 1)}>
        {SV.chevLs}
      </button>
      <span className="earn-pgi num">
        {page + 1} of {pages}
      </span>
      <button type="button" className="earn-pgb" aria-label="Next page" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
        {SV.chevR}
      </button>
    </div>
  );
}
