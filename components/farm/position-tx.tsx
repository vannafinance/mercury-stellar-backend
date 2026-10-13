"use client";

/**
 * The pool page's "All Transactions" panel (/farm/:id — Blend, Aquarius and Soroswap pools all
 * look the same): a position summary (value / receipt balance / LP share), the "Your Position"
 * header with a type filter and column Customize menu, and the
 * Current Position | Position History table. Callers pass already-built cells; this owns only the
 * layout, filtering and column visibility.
 */
import { useState, type ReactNode } from "react";
import { IC } from "@/components/v3/icons";
import { Seg } from "@/components/v3/ui";
import { CheckDropdown, useOutside } from "./fm-ui";

export type TxTab = "current" | "history";
/** Column label + grid track width, per tab. */
export type TxCols = Record<TxTab, readonly (readonly [string, string])[]>;

export interface HistoryRow {
  /** The type label the filter matches ("Supply", "Withdraw", "Add Liquidity" …). */
  label: string;
  cells: ReactNode[];
}

export function PositionTxPanel({
  summary,
  cols,
  current,
  history,
  typeOptions,
  emptyCurrent = "No position in this pool yet",
}: {
  /** [label, value, optional small note] for the summary row. */
  summary: [string, ReactNode, ReactNode?][];
  cols: TxCols;
  current: ReactNode[][];
  history: HistoryRow[];
  typeOptions: string[];
  emptyCurrent?: string;
}) {
  const [tab, setTab] = useState<TxTab>("current");
  const [types, setTypes] = useState<string[]>([]);
  const [hide, setHide] = useState<Record<TxTab, string[]>>({ current: [], history: [] });
  const [custOpen, setCustOpen] = useState(false);
  const [cq, setCq] = useState("");
  const custRef = useOutside(custOpen, () => setCustOpen(false));

  const cells = { current, history: history.filter((r) => !types.length || types.includes(r.label)).map((r) => r.cells) };
  const show = cols[tab].map((c, i) => [c, i] as const).filter(([c]) => !hide[tab].includes(c[0]));
  const grid = { gridTemplateColumns: show.map(([c]) => c[1]).join(" "), minWidth: Math.max(240, show.length * 110) };
  const rows = cells[tab];
  const empty = tab === "current" ? emptyCurrent : types.length ? `No ${types.join(" or ").toLowerCase()} in this pool yet` : "No activity in this pool yet";
  const custCols = cols[tab].filter(([l]) => !cq.trim() || l.toLowerCase().includes(cq.trim().toLowerCase()));

  return (
    <>
      <dl className="fm-position-summary num">
        {summary.map(([l, v, note]) => (
          <div key={l}>
            <dt>{l}</dt>
            <dd>{v}</dd>
            {note && <small>{note}</small>}
          </div>
        ))}
      </dl>
      <div className="fm-ath">
        <h2>{tab === "current" ? "Your Position" : "Position History"}</h2>
        <div className="fm-athr">
          <span className="fm-vl">{types.length ? types.join(", ") : "All"}:</span>
          <CheckDropdown
            right
            withIcons={false}
            options={typeOptions}
            selected={types}
            onChange={(next) => {
              setTypes(next);
              if (next.length) setTab("history");
            }}
            placeholder="Search types"
            trigger={(open, toggle) => (
              <button type="button" className={`fm-all ${types.length ? "set" : ""}`} aria-haspopup="listbox" aria-expanded={open} aria-label="Filter transactions by type" onClick={toggle}>
                <svg width="17" height="12" viewBox="0 0 17 12" aria-hidden="true">
                  <path d="M1 1h15M4 6h9M7 11h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            )}
          />
          <span className="fm-ddw" ref={custRef}>
            <button type="button" className="fm-cust" aria-haspopup="menu" aria-expanded={custOpen} onClick={() => setCustOpen((o) => !o)}>
              {EYE}Customize {IC.chev}
            </button>
            {custOpen && (
              <div className="pop r fm-cpop" role="menu">
                <label className="fm-psearch">
                  {IC.search}
                  <input placeholder="Search for customize" value={cq} onChange={(e) => setCq(e.target.value)} aria-label="Search columns" autoComplete="off" />
                </label>
                <div className="fm-cl">
                  {custCols.length ? (
                    custCols.map(([l]) => {
                      const on = !hide[tab].includes(l);
                      return (
                        <button
                          key={l}
                          type="button"
                          className={`fm-co eye ${on ? "on" : ""}`}
                          role="menuitemcheckbox"
                          aria-checked={on}
                          onClick={() => setHide((h) => ({ ...h, [tab]: on ? h[tab].concat(l) : h[tab].filter((z) => z !== l) }))}
                        >
                          {on ? EYE : EYE_OFF}
                          {l}
                        </button>
                      );
                    })
                  ) : (
                    <p className="fm-cnone">No match</p>
                  )}
                </div>
              </div>
            )}
          </span>
        </div>
      </div>
      <Seg<TxTab>
        className="fm-seg-l"
        value={tab}
        options={[
          ["current", "Current Position"],
          ["history", "Position History"],
        ]}
        onChange={setTab}
      />
      <section className="fm-itbl">
        {!show.length ? (
          <p className="fm-it-e">All columns are hidden. Turn one on in Customize.</p>
        ) : rows.length ? (
          <>
            <div className="fm-it-h" style={grid}>
              {show.map(([c]) => (
                <span key={c[0]}>{c[0]}</span>
              ))}
            </div>
            {rows.map((r, k) => (
              <div key={k} className="fm-it-r num" style={grid}>
                {show.map(([, i]) => r[i])}
              </div>
            ))}
          </>
        ) : (
          <p className="fm-it-e">{empty}</p>
        )}
      </section>
    </>
  );
}

const EYE = (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M1 8s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5z" stroke="currentColor" strokeWidth="1.4" fill="none" />
    <circle cx="8" cy="8" r="2" fill="currentColor" />
  </svg>
);
const EYE_OFF = (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M1 8s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5z" stroke="currentColor" strokeWidth="1.4" fill="none" opacity=".45" />
    <path d="M2.5 13.5l11-11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);
