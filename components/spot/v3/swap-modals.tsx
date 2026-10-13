"use client";

/**
 * The swap card's two dialogs in the V3 design (spot.js settingsModal / tokenModal): slippage
 * settings (Auto | Custom with presets) and the token picker (search, Popular chips, the whole
 * DEX's swappable tokens with each token's margin-account balance). Pure UI — the card owns the state.
 */
import { useState } from "react";
import { Modal } from "@/components/v3/ui";
import { IC, Icon } from "@/components/v3/icons";
import type { Token } from "../spot-nonorderbook/types";

/** Slippage used when the selector is on "auto". */
export const AUTO_SLIPPAGE_PERCENT = "0.5";
const PRESETS = ["0.1", "0.5", "1.0"];

/** Swap Settings: slippage tolerance. */
export function SwapSettingsModal({
  slippage,
  onSlippageChange,
  mode,
  onModeChange,
  onClose,
}: {
  slippage: string;
  onSlippageChange: (v: string) => void;
  mode: "auto" | "custom";
  onModeChange: (m: "auto" | "custom") => void;
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose} className="sp-modal-s">
      <div className="sp-set">
        <h2>Swap Settings</h2>
        <div className="sp-sdiv" />
        <div className="sp-sl">
          <span className="sp-cap">Slippage Tolerance</span>
          <div className="sp-srow">
            <span className="sp-seg2">
              <button type="button" className={mode === "auto" ? "on" : ""} onClick={() => onModeChange("auto")}>
                Auto
              </button>
              <button type="button" className={mode === "custom" ? "on" : ""} onClick={() => onModeChange("custom")}>
                Custom
              </button>
            </span>
            {mode === "custom" && (
              <>
                <span className="sp-pre">
                  {PRESETS.map((v) => (
                    <button key={v} type="button" className={parseFloat(slippage) === parseFloat(v) ? "on" : ""} onClick={() => onSlippageChange(v)}>
                      {v}%
                    </button>
                  ))}
                </span>
                <label className="sp-sin">
                  <input
                    inputMode="decimal"
                    value={slippage}
                    aria-label="Custom slippage"
                    onChange={(e) => onSlippageChange(e.target.value.replace(/[^0-9.]/g, ""))}
                  />
                  <span>%</span>
                </label>
              </>
            )}
          </div>
          {mode === "custom" && parseFloat(slippage) > 3 && <p className="sp-swarn">High slippage may result in an unfavorable trade.</p>}
        </div>
        <p className="sp-snote">Auto uses {AUTO_SLIPPAGE_PERCENT}%. The tolerance sets the Min. Received shown with each quote.</p>
      </div>
    </Modal>
  );
}

/** Select a Token: search by symbol, name or contract address; Popular chips; balances in the margin account. */
export function TokenPickerModal({
  tokens,
  popular,
  balances,
  exclude,
  onSelect,
  onClose,
}: {
  tokens: Token[];
  popular: Token[];
  /** Margin-account balance per token id, formatted; omitted when no wallet. */
  balances?: Record<string, string>;
  /** Token on the other side (picking it would flip the pair, so it isn't listed). */
  exclude?: string;
  onSelect: (t: Token) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const list = tokens.filter(
    (t) => t.id !== exclude && (!query || t.symbol.toLowerCase().includes(query) || t.name.toLowerCase().includes(query) || t.id.toLowerCase() === query),
  );
  return (
    <Modal onClose={onClose} className="sp-modal-t">
      <div className="sp-tm">
        <h2>Select a Token</h2>
        <label className="sp-tsearch">
          {IC.search}
          <input placeholder="Search by name or paste address" value={q} autoFocus aria-label="Search tokens" onChange={(e) => setQ(e.target.value)} />
        </label>
        {!query && (
          <>
            <div className="sp-tpop">
              <p>Popular</p>
              <div>
                {popular
                  .filter((t) => t.id !== exclude)
                  .map((t) => (
                    <button key={t.id} type="button" onClick={() => onSelect(t)}>
                      <Icon sym={t.symbol} className="sp-ico s20" />
                      <b>{t.symbol}</b>
                    </button>
                  ))}
              </div>
            </div>
            <div className="sp-tdiv" />
          </>
        )}
        <div className="sp-tl">
          {list.length ? (
            list.map((t) => (
              <button key={t.id} type="button" className="sp-trow" onClick={() => onSelect(t)}>
                <Icon sym={t.symbol} className="sp-ico s36" />
                <span>
                  <b>{t.symbol}</b>
                  <small>{t.name}</small>
                </span>
                {balances && <em className="num">{balances[t.id] ?? "0"}</em>}
              </button>
            ))
          ) : (
            <p className="sp-tnone">No tokens found</p>
          )}
        </div>
      </div>
    </Modal>
  );
}
