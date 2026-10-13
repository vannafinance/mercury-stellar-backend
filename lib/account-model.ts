/**
 * The Vanna margin account as the Soroban RiskEngine values it, for every V3 page's numbers (health
 * factor, account leverage, room before liquidation, liquidation prices). Mirrors the chain and
 * lib/margin-health.ts:
 *
 * - health factor = Σ collateral value / Σ debt value, unweighted; liquidatable at ≤ 1.10;
 * - Stellar has no perps venue, so `phoenixCollateral` / `perps` are always empty here; the perp
 *   helpers are kept so the model stays identical to the Solana app's.
 *
 * Price moves are scanned (not solved in closed form) so the venue's zero floor and debt in the same
 * asset are handled exactly.
 */

/** At or below this the account can be liquidated (BALANCE_TO_BORROW_THRESHOLD). */
export const LIQ_HF = 1.1;
/** Orders that would leave the account below this are blocked (the app's safety buffer). */
export const SAFE_HF = 1.15;
/** Between SAFE_HF and this, orders are allowed with a warning. */
export const WARN_HF = 1.25;

const STABLES = new Set(["USDC", "USDT"]);

/**
 * Which price a holding follows: the venue USDC wrappers (BLUSDC / AQUSDC / SOUSDC) follow USDC;
 * everything else by symbol.
 */
export const priceKey = (symbol: string) => {
  const u = symbol.toUpperCase();
  if (u === "BLUSDC" || u === "AQUSDC" || u === "SOUSDC" || u === "BLEND_USDC" || u === "AQUIRESUSDC" || u === "SOROSWAPUSDC") return "USDC";
  return u === "XLM" ? "XLM" : symbol;
};
export const isStable = (symbol: string) => STABLES.has(priceKey(symbol));

export interface ModelPerp {
  /** Market key ("SOL", "ETH", …). */
  key: string;
  /** Signed size in base tokens (+ long, − short). */
  tokens: number;
  entry: number;
  /** Oracle index price, USD. */
  index: number;
  /** Funding owed (−) or earned (+) so far, USD. */
  fundingUsd: number;
  /** Phoenix taker fee (fraction). */
  takerFee: number;
}

export interface ModelState {
  /** Token collateral lines (the venue excluded), USD at today's prices. */
  collateral: { symbol: string; usd: number }[];
  debts: { symbol: string; usd: number }[];
  /** USDC (phUSD) collateral in the Phoenix trader account. */
  phoenixCollateral: number;
  perps: ModelPerp[];
}

/** Price multiplier per price key (1 = today). */
type Move = (key: string) => number;
const NO_MOVE: Move = () => 1;

/** One position's equity at `index`, as the oracle values it. */
export function perpEquity(p: ModelPerp, index = p.index): number {
  return p.tokens * (index - p.entry) + p.fundingUsd - Math.abs(p.tokens * index) * p.takerFee;
}

export function venueValue(s: ModelState, move: Move = NO_MOVE): number {
  return Math.max(0, s.phoenixCollateral + s.perps.reduce((t, p) => t + perpEquity(p, p.index * move(p.key)), 0));
}

function totals(s: ModelState, move: Move = NO_MOVE) {
  const tokens = s.collateral.reduce((t, c) => t + c.usd * (isStable(c.symbol) ? 1 : move(priceKey(c.symbol))), 0);
  const holdings = tokens + venueValue(s, move);
  const debt = s.debts.reduce((t, d) => t + d.usd * (isStable(d.symbol) ? 1 : move(priceKey(d.symbol))), 0);
  return { holdings, debt };
}

export function healthFactor(s: ModelState, move: Move = NO_MOVE): number {
  const { holdings, debt } = totals(s, move);
  return debt > 1e-9 ? holdings / debt : Infinity;
}

export interface AccountNumbers {
  holdings: number;
  debt: number;
  equity: number;
  hf: number;
  /**
   * Gross position value ÷ equity: every token held (stables and idle borrowed funds included) plus
   * the larger of the Phoenix account's value and its open perp notional. 1× with no debt; a 5× perp
   * reads 5×. Same basis as Analytics (collateral ÷ equity).
   */
  leverage: number;
  perpsValue: number;
}

export function accountNumbers(s: ModelState): AccountNumbers {
  const { holdings, debt } = totals(s);
  const equity = holdings - debt;
  const tokens = s.collateral.reduce((t, c) => t + c.usd, 0);
  const notional = s.perps.reduce((t, p) => t + Math.abs(p.tokens * p.index), 0);
  const exposure = tokens + Math.max(venueValue(s), notional);
  return {
    holdings,
    debt,
    equity,
    hf: debt > 1e-9 ? holdings / debt : Infinity,
    leverage: equity > 0 ? exposure / equity : exposure > 0 ? Infinity : 0,
    perpsValue: venueValue(s),
  };
}

/**
 * First multiplier along `path` (from 1 outward) where the health factor reaches LIQ_HF, refined by
 * bisection; null when none on the path.
 */
function crossing(hfAt: (x: number) => number, path: number[]): number | null {
  let prev = 1;
  for (const x of path) {
    if (hfAt(x) <= LIQ_HF) {
      let a = prev;
      let b = x;
      for (let j = 0; j < 48; j++) {
        const m = (a + b) / 2;
        if (hfAt(m) <= LIQ_HF) b = m;
        else a = m;
      }
      return (a + b) / 2;
    }
    prev = x;
  }
  return null;
}
const DOWN = Array.from({ length: 100 }, (_, i) => 1 - ((i + 1) / 100) * 0.999);
const UP = Array.from({ length: 62 }, (_, i) => Math.pow(1.05, i + 1));

/**
 * Multiplier of `key`'s price (everything else held) at which the account reaches LIQ_HF. `side`
 * limits the scan to the adverse direction of a position (down for a long, up for a short); without
 * it the nearer crossing either way. 1 = liquidatable now, null = no debt / no such price.
 */
export function liqMultiplier(s: ModelState, key: string, side?: "long" | "short"): number | null {
  const hfAt = (x: number) => healthFactor(s, (k) => (k === key ? x : 1));
  const h0 = hfAt(1);
  if (!Number.isFinite(h0)) return null;
  if (h0 <= LIQ_HF) return 1;
  const dn = side === "short" ? null : crossing(hfAt, DOWN);
  const up = side === "long" ? null : crossing(hfAt, UP);
  if (dn === null) return up;
  if (up === null) return dn;
  return 1 - dn <= up - 1 ? dn : up;
}

/** Every price key the account is exposed to (volatile collateral, volatile debt, perps). */
function exposedKeys(s: ModelState): string[] {
  const keys = new Set<string>();
  for (const c of s.collateral) if (!isStable(c.symbol)) keys.add(priceKey(c.symbol));
  for (const d of s.debts) if (!isStable(d.symbol)) keys.add(priceKey(d.symbol));
  for (const p of s.perps) keys.add(p.key);
  return [...keys];
}

export type LiqRoom =
  | { state: "nodebt" }
  | { state: "now"; hf: number }
  | { state: "none"; all: number | null }
  /** `pct` < 0: the price falling by |pct|% liquidates; > 0: rising. `all`: every volatile price together, same sign. */
  | { state: "ok"; key: string; pct: number; all: number | null };

/** Room before liquidation: the smallest single-price move that liquidates the account, plus all prices together. */
export function liqRoom(s: ModelState): LiqRoom {
  const h0 = healthFactor(s);
  if (!Number.isFinite(h0)) return { state: "nodebt" };
  if (h0 <= LIQ_HF) return { state: "now", hf: h0 };
  let best: { key: string; pct: number } | null = null;
  for (const key of exposedKeys(s)) {
    const m = liqMultiplier(s, key);
    if (m === null) continue;
    const pct = (m - 1) * 100;
    if (!best || Math.abs(pct) < Math.abs(best.pct)) best = { key, pct };
  }
  const vol = new Set(exposedKeys(s));
  const allAt = (x: number) => healthFactor(s, (k) => (vol.has(k) ? x : 1));
  const dn = crossing(allAt, DOWN);
  const up = crossing(allAt, UP);
  const all = dn === null && up === null ? null : up === null || (dn !== null && 1 - dn <= up - 1) ? (dn! - 1) * 100 : (up - 1) * 100;
  return best ? { state: "ok", ...best, all } : { state: "none", all };
}

/** Position liquidation price (adverse direction only), null = None. */
export function positionLiqPrice(s: ModelState, key: string, side: "long" | "short"): number | null {
  const p = s.perps.find((x) => x.key === key);
  const m = liqMultiplier(s, key, side);
  return p && m !== null ? p.index * m : null;
}

export interface SimOrder {
  key: string;
  side: "long" | "short";
  /** Base tokens filled. */
  qty: number;
  /** Average fill price. */
  entry: number;
  /** Oracle index price of the market. */
  index: number;
  /** USDC moved from the margin into Phoenix. */
  collateral: number;
  takerFee: number;
}

/** The account after a market order fills (Phoenix charges the open fee from its collateral). */
export function withOrder(s: ModelState, o: SimOrder): ModelState {
  const signed = o.side === "long" ? o.qty : -o.qty;
  const openFee = o.qty * o.entry * o.takerFee;
  const collateral = s.collateral.map((c) => (c.symbol === "USDC" ? { ...c, usd: Math.max(0, c.usd - o.collateral) } : c));
  const existing = s.perps.find((p) => p.key === o.key);
  let perps: ModelPerp[];
  if (existing) {
    const tokens = existing.tokens + signed;
    // Same direction: average the entry; reducing / flipping keeps the old entry for what stays open.
    const sameDir = Math.sign(existing.tokens) === Math.sign(signed);
    const entry = sameDir && tokens !== 0 ? (existing.tokens * existing.entry + signed * o.entry) / tokens : Math.abs(signed) > Math.abs(existing.tokens) ? o.entry : existing.entry;
    perps = s.perps.map((p) => (p === existing ? { ...p, tokens, entry } : p));
  } else {
    perps = [...s.perps, { key: o.key, tokens: signed, entry: o.entry, index: o.index, fundingUsd: 0, takerFee: o.takerFee }];
  }
  return { ...s, collateral, phoenixCollateral: s.phoenixCollateral + o.collateral - openFee, perps };
}

// ---- formatting shared by the terminal ----

export const hfZone = (h: number) => (!Number.isFinite(h) || h >= 1.5 ? "z-ok" : h >= 1.25 ? "z-caution" : h > LIQ_HF ? "z-warn" : "z-danger");
/** Position of a health factor on the 1.0 – 2.5 meter, %. */
export const hfPos = (h: number) => (Number.isFinite(h) ? Math.max(0, Math.min(100, ((h - 1) / 1.5) * 100)) : 100);
