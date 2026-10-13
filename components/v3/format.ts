/**
 * V3 design number formatting (the prototype's core formatters): typographic minus, compact USD,
 * signed amounts and percentages, price precision by magnitude, token precision by token.
 * Every V3 page formats through these so the same number reads the same everywhere.
 */
import { LIQ_HF, isStable, type LiqRoom } from "@/lib/account-model";

export const nf = (n: number, d = 0): string => {
  // Unknown / NaN values render as the zero form ("0.00"), never a placeholder dash.
  const v = Number.isFinite(Number(n)) ? Number(n) : 0;
  const t = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  return v < 0 && /[1-9]/.test(t) ? `−${t}` : t;
};
/** $1,234.56 (typographic minus for negatives). */
export const usd = (n: number, d = 2) => `${n < 0 ? "−$" : "$"}${nf(Math.abs(n), d)}`;
/** Compact USD: $1.23M / $4.5K / $120. */
export const usdC = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${nf(a / 1e6, 2)}M` : a >= 1e3 ? `${(+(a / 1e3).toFixed(1)).toLocaleString("en-US")}K` : nf(a, 0);
  return `${n < 0 ? "−$" : "$"}${s}`;
};
/** Compact number: 1.23M / 4.50K / 12.00. */
export const cmp = (n: number) => {
  const a = Math.abs(n);
  return a >= 1e6 ? `${nf(a / 1e6, 2)}M` : a >= 1e3 ? `${nf(a / 1e3, 2)}K` : nf(a, 2);
};
/** Signed USD: +$12.30 / −$4.00. */
export const sUsd = (n: number, d = 2) => `${n >= 0 ? "+$" : "−$"}${nf(Math.abs(n), d)}`;
export const pct = (n: number, d = 2) => `${n < 0 ? "−" : ""}${nf(Math.abs(n), d)}%`;
/** Signed percent: +1.20% / −0.40%. */
export const spct = (n: number, d = 2) => `${n >= 0 ? "+" : "−"}${nf(Math.abs(n), d)}%`;
export const price = (n: number) => (n >= 10 ? nf(n, 2) : nf(n, 4));
export const levFmt = (l: number) => `${nf(Number.isFinite(l) ? l : 0, 2)}x`;
/**
 * Health factor text. "No debt" ONLY when there is no debt (null / non-finite HF); a finite HF is
 * always a number, and very large ones (tiny debt against big collateral) read ">100" — they used to
 * read "No debt", which hid a real loan.
 */
export const hfFmt = (h: number | null | undefined) => (h === null || h === undefined || !Number.isFinite(h) ? "No debt" : h >= 100 ? ">100" : nf(h, 2));
export const hfLabel = (h: number) => (!Number.isFinite(h) || h >= 1.5 ? "Safe" : h >= 1.25 ? "Healthy" : h > LIQ_HF ? "At risk" : "Liquidation");
export const upDn = (v: number) => (v >= 0 ? "pos" : "neg");

/** Token decimals: stables 2, BTC 5, ETH 4, everything else 4 (below 1,000) or 2. */
const tokDec = (sym: string, n: number) => (isStable(sym) ? 2 : sym === "BTC" ? 5 : sym === "ETH" ? 4 : Math.abs(n) >= 1000 ? 2 : 4);
/** 38.50 SOL, 52.5394 SOL, 0.03621 BTC — at least 2 decimals, at most the token's precision. */
export const tokFmt = (n: number, sym: string, withSym = true) => {
  const v = Number.isFinite(Number(n)) ? Number(n) : 0;
  const t = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: Math.max(2, tokDec(sym, v)) });
  return `${v < 0 && /[1-9]/.test(t) ? "−" : ""}${t}${withSym ? ` ${sym}` : ""}`;
};

export const roomText = (r: LiqRoom) =>
  r.state === "nodebt" ? "No debt" : r.state === "now" ? "Liquidatable now" : r.state === "none" ? "None" : `${r.key} ${r.pct < 0 ? "−" : "+"}${nf(Math.abs(r.pct), 1)}%`;
const roomAll = (all: number | null) =>
  all === null ? "no move of all prices together liquidates it" : `all prices ${all < 0 ? "−" : "+"}${nf(Math.abs(all), 1)}% together`;
export const roomSub = (r: LiqRoom) =>
  r.state === "nodebt"
    ? "nothing to liquidate"
    : r.state === "now"
      ? `health factor ${hfFmt(r.hf)}, at or below ${nf(LIQ_HF, 2)}`
      : r.state === "none"
        ? r.all === null
          ? "no price move liquidates it"
          : `no single price move; ${roomAll(r.all)}`
        : roomAll(r.all);
export const roomZone = (r: LiqRoom) => (r.state === "now" ? "z-danger" : r.state === "ok" && Math.abs(r.pct) < 10 ? "z-warn" : "");

/** "Oct 7, 15:00" from unix seconds (local time). */
export const timeFmt = (unixSec: number) =>
  unixSec
    ? new Date(unixSec * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
    : "N/A";
