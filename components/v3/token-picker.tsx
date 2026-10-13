"use client";

/**
 * Shared "Select a Token" dialog (the Spot swap picker's design, centered on screen): search by symbol
 * or name, optional Popular chips, and the token list with a value on the right (a balance, or what
 * can be borrowed). `TokenPickButton` is the token pill that opens it. Pure UI: callers pass the
 * tokens and the right-hand values they want shown; nothing is read or stored here.
 */
import { useState, type ReactNode } from "react";
import "./token-picker.css";
import { Modal } from "./ui";
import { IC, Icon } from "./icons";

export interface PickerRow {
  symbol: string;
  name: string;
  /** Right-hand value, e.g. "200.00". */
  value?: ReactNode;
  /** Small line under the value, e.g. "4.36% APY". */
  valueSub?: ReactNode;
}

export function TokenPickerDialog({
  title = "Select a Token",
  rows,
  popular,
  selected,
  valueLabel,
  onSelect,
  onClose,
}: {
  title?: string;
  rows: PickerRow[];
  /** Symbols shown as chips above the list (hidden while searching). */
  popular?: string[];
  /** Currently selected symbol (marked in the list). */
  selected?: string;
  /** What the right-hand column is, e.g. "Wallet balance". */
  valueLabel?: string;
  onSelect: (symbol: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const list = rows.filter((r) => !query || r.symbol.toLowerCase().includes(query) || r.name.toLowerCase().includes(query));
  const chips = (popular ?? []).filter((s) => rows.some((r) => r.symbol === s));
  return (
    <Modal onClose={onClose} className="tp-modal">
      <div className="tp">
        <h2>{title}</h2>
        <label className="tp-search">
          {IC.search}
          <input placeholder="Search by name or symbol" value={q} autoFocus aria-label="Search tokens" onChange={(e) => setQ(e.target.value)} />
        </label>
        {!query && chips.length > 0 && (
          <div className="tp-pop">
            <p>Popular</p>
            <div>
              {chips.map((s) => (
                <button key={s} type="button" className={s === selected ? "on" : ""} onClick={() => onSelect(s)}>
                  <Icon sym={s} className="tp-ico s20" />
                  <b>{s}</b>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="tp-head">
          <span>Token</span>
          {valueLabel && <span>{valueLabel}</span>}
        </div>
        <div className="tp-list">
          {list.length ? (
            list.map((r) => (
              <button key={r.symbol} type="button" className={`tp-row ${r.symbol === selected ? "on" : ""}`} aria-pressed={r.symbol === selected} onClick={() => onSelect(r.symbol)}>
                <Icon sym={r.symbol} className="tp-ico s36" />
                <span className="tp-n">
                  <b>{r.symbol}</b>
                  <small>{r.name}</small>
                </span>
                {(r.value !== undefined || r.valueSub !== undefined) && (
                  <span className="tp-v num">
                    {r.value !== undefined && <em>{r.value}</em>}
                    {r.valueSub !== undefined && <small>{r.valueSub}</small>}
                  </span>
                )}
              </button>
            ))
          ) : (
            <p className="tp-none">No tokens found</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** The token pill (icon, symbol, chevron) that opens {@link TokenPickerDialog}. */
export function TokenPickButton({
  sym,
  className = "",
  iconClassName = "",
  chevron,
  ...dialog
}: {
  sym: string;
  /** Pill classes from the page (e.g. Margin's `mg-tok`). */
  className?: string;
  iconClassName?: string;
  chevron?: ReactNode;
} & Omit<Parameters<typeof TokenPickerDialog>[0], "onClose" | "selected">) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <Icon sym={sym} className={iconClassName} />
        <span>{sym}</span>
        {chevron}
      </button>
      {open && (
        <TokenPickerDialog
          {...dialog}
          selected={sym}
          onSelect={(s) => {
            dialog.onSelect(s);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
