"use client";

/**
 * Portfolio → Balances: every token the user holds, split between the connected wallet and the margin
 * account, with amounts and USD values. Wallet balances come from the wallet store (on-chain reads:
 * XLM from Horizon, BLUSDC / AQUSDC / SOUSDC from their SAC contracts — the store's USDC and
 * BLEND_USDC keys mirror the same Blend USDC, shown once as BLUSDC); margin holdings from the margin
 * store (the same rows the health factor values, Blend supply / LP tracking positions included).
 */
import { useMemo, useState } from "react";
import { IC, Icon } from "@/components/v3/icons";
import { tokFmt, usd } from "@/components/v3/format";
import { isTrackingSymbol } from "@/lib/account-snapshot";
import { canonicalMarginPositionToken } from "@/lib/margin-position-attribution";
import type { Portfolio } from "./use-portfolio";
import { TOKEN_NAMES } from "./portfolio-math";
import { Ct, Grid } from "./pf-ui";

type View = "wallet" | "margin";

interface BalanceRow {
  symbol: string;
  name: string;
  wallet: number;
  walletUsd: number;
  margin: number;
  marginUsd: number;
  /** A farm tracking position (Blend supply / LP receipt): no oracle price of its own. */
  receipt?: boolean;
}

/** "BLEND_XLM" → "Blend XLM supply", "AQ_XLM_USDC" → "Aquarius XLM/USDC LP", "SS_…" → Soroswap. */
const nameOf = (sym: string) => {
  if (TOKEN_NAMES[sym]) return TOKEN_NAMES[sym];
  const u = sym.toUpperCase();
  if (u.startsWith("BLEND_")) return `Blend ${u.slice(6)} supply`;
  if (u.startsWith("AQ_")) return `Aquarius ${u.slice(3).split("_").join("/")} LP`;
  if (u.startsWith("SS_")) return `Soroswap ${u.slice(3).split("_").join("/")} LP`;
  return sym;
};
/** Logo for a balance row: tracking positions show their venue. */
const logoOf = (sym: string) => {
  const u = sym.toUpperCase();
  return u.startsWith("BLEND_") ? "BLEND" : u.startsWith("AQ_") ? "AQUARIUS" : u.startsWith("SS_") ? "SOROSWAP" : sym;
};

export function Balances({ p }: { p: Portfolio }) {
  const [view, setView] = useState<View>("wallet");
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    const by = new Map<string, BalanceRow>();
    const row = (sym: string) => {
      let r = by.get(sym);
      if (!r) by.set(sym, (r = { symbol: sym, name: nameOf(sym), wallet: 0, walletUsd: 0, margin: 0, marginUsd: 0 }));
      return r;
    };
    for (const [sym, amt] of Object.entries(p.wallet)) {
      if (!(amt > 0)) continue;
      const r = row(sym);
      r.wallet = amt;
      r.walletUsd = amt * p.priceOf(sym);
    }
    // Margin balances, deduped by canonical symbol (largest leg wins, as the snapshot does).
    const seen = new Map<string, number>();
    for (const [raw, b] of Object.entries(p.store.collateralBalances)) {
      const amt = parseFloat(b.amount || "0") || 0;
      if (!(amt > 0)) continue;
      const tracking = isTrackingSymbol(raw);
      const sym = tracking ? raw.toUpperCase() : canonicalMarginPositionToken(raw);
      if ((seen.get(sym) ?? 0) >= amt) continue;
      seen.set(sym, amt);
      const r = row(sym);
      r.margin = amt;
      r.marginUsd = parseFloat(b.usdValue || "0") || (tracking ? 0 : amt * p.priceOf(sym));
      r.receipt = tracking;
    }
    return [...by.values()].sort((a, b) => b.walletUsd + b.marginUsd - (a.walletUsd + a.marginUsd));
  }, [p]);

  const walletTotal = rows.reduce((t, r) => t + r.walletUsd, 0);
  const marginTotal = rows.reduce((t, r) => t + r.marginUsd, 0);
  const inView = (r: BalanceRow, v: View) => (v === "wallet" ? r.wallet > 0 : r.margin > 0);
  const shown = rows
    .filter((r) => inView(r, view) && (!q || `${r.symbol} ${r.name}`.toLowerCase().includes(q.toLowerCase())))
    // Each view sorts by the value it shows.
    .sort((a, b) => (view === "wallet" ? b.walletUsd - a.walletUsd : b.marginUsd - a.marginUsd));
  const amt = (v: number, sym: string) => (v > 0 ? tokFmt(v, sym) : "0");
  const price = (r: BalanceRow) =>
    r.receipt ? (r.margin > 0 ? usd(r.marginUsd / r.margin) : usd(0)) : usd(p.priceOf(r.symbol));
  const tiles: [string, number, string][] = [
    ["Wallet", walletTotal, `${rows.filter((r) => r.wallet > 0).length} tokens`],
    ["Margin account", marginTotal, `${rows.filter((r) => r.margin > 0).length} holdings · debt not subtracted`],
    ["Total", walletTotal + marginTotal, `${rows.length} assets`],
  ];

  return (
    <>
      <div className="pf-bal-sum">
        {tiles.map(([k, v, sub]) => (
          <div key={k} className="pf-bal-t">
            <span>{k}</span>
            <b className="num">{usd(v)}</b>
            <small>{sub}</small>
          </div>
        ))}
      </div>
      <section className="pf-tbl">
        <div className="pf-tbar">
          <nav className="pf-seg" role="tablist" aria-label="Balances of">
            {(
              [
                ["wallet", "Wallet"],
                ["margin", "Margin account"],
              ] as [View, string][]
            ).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={view === k} className={view === k ? "on" : ""} onClick={() => setView(k)}>
                {l}
              </button>
            ))}
          </nav>
          <label className="search pf-search">
            {IC.search}
            <input placeholder="Search tokens" aria-label="Search tokens" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
        </div>
        <Grid
          cols="1.6fr 1.3fr 1fr 1fr"
          heads={["Token", view === "wallet" ? "Wallet balance" : "Margin balance", "Price", "Value"]}
          empty={q ? "No tokens match" : view === "wallet" ? "Your wallet holds no tokens yet. Use the Faucet." : "Your margin account holds nothing yet."}
          rows={shown.map((r) => {
            const bal = view === "wallet" ? r.wallet : r.margin;
            const value = view === "wallet" ? r.walletUsd : r.marginUsd;
            return {
              key: r.symbol,
              cells: [
                <Ct key="t" desc={r.name !== r.symbol ? r.name : undefined}>
                  <Icon sym={logoOf(r.symbol)} className="ico pf-i16" />
                  {r.symbol}
                </Ct>,
                <Ct key="b">{amt(bal, r.receipt ? "" : r.symbol).trim()}</Ct>,
                <Ct key="p">{price(r)}</Ct>,
                <Ct key="v">
                  <b>{usd(value)}</b>
                </Ct>,
              ],
            };
          })}
        />
      </section>
    </>
  );
}
