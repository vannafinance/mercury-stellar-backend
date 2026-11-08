/**
 * "After this action" simulation for the Margin screen's Leverage / Repay / Transfer tabs.
 *
 * Every function here edits a copy of the program-exact {@link ModelState} (lib/account-model.ts,
 * built by `useV3Account`) and lets `accountNumbers` / `healthFactor` value the result, so the
 * before → after rows use the same valuation as the health factor shown everywhere else
 * (HF = Σ collateral / Σ debt, unweighted; liquidatable at ≤ 1.10).
 *
 * The borrow / withdraw LIMITS on Stellar are not taken from this model: they stay the pre-sign
 * checks the app already had ({@link riskEngineMaxBorrowUsd} here, `maxMarginWithdrawal` in
 * lib/utils/margin-withdraw.ts), computed from the margin store's RiskEngine-aligned totals.
 *
 * Token moves are applied in USD at today's on-chain prices. Borrowed tokens land in the margin
 * vault and count as collateral, so a borrow raises both sides of the ratio.
 */
import { LIQ_HF, SAFE_HF, accountNumbers, healthFactor, isStable, priceKey, type AccountNumbers, type ModelState } from "@/lib/account-model";

/** A brand-new (or not yet loaded) margin account. */
export const EMPTY_STATE: ModelState = { collateral: [], debts: [], phoenixCollateral: 0, perps: [] };

/** Adds `usd` (may be negative) to `symbol`'s line in `rows`, dropping a line that reaches zero. */
function bump(rows: { symbol: string; usd: number }[], symbol: string, usd: number) {
  const out = rows.map((r) => ({ ...r }));
  const row = out.find((r) => r.symbol === symbol);
  if (row) row.usd = Math.max(0, row.usd + usd);
  else if (usd > 0) out.push({ symbol, usd });
  return out.filter((r) => r.usd > 1e-9);
}

/** One token move, in USD. */
export interface Move {
  symbol: string;
  usd: number;
}

/** Deposits from the wallet into the margin account. */
export const withDeposits = (s: ModelState, deps: Move[]): ModelState =>
  deps.reduce((acc, d) => ({ ...acc, collateral: bump(acc.collateral, d.symbol, d.usd) }), s);

/** Borrows: debt opens and the borrowed tokens sit in the margin vault. */
export const withBorrows = (s: ModelState, bors: Move[]): ModelState =>
  bors.reduce((acc, b) => ({ ...acc, collateral: bump(acc.collateral, b.symbol, b.usd), debts: bump(acc.debts, b.symbol, b.usd) }), s);

/** Repay `usd` of `symbol` debt, paid from the margin vault or from the wallet. */
export const withRepay = (s: ModelState, m: Move, from: "margin" | "wallet"): ModelState => ({
  ...s,
  collateral: from === "margin" ? bump(s.collateral, m.symbol, -m.usd) : s.collateral,
  debts: bump(s.debts, m.symbol, -m.usd),
});

/** Withdraw `usd` of `symbol` from the margin vault to the wallet. */
export const withWithdraw = (s: ModelState, m: Move): ModelState => ({ ...s, collateral: bump(s.collateral, m.symbol, -m.usd) });

/**
 * The Stellar pre-sign borrow check (unchanged from the previous Leverage tab): the RiskEngine
 * accepts a borrow while (gross + borrow) / (debt + borrow) > 1.10, so the largest additional
 * borrow is (gross − 1.10 × debt) / 0.10. `gross` is the store's grossCollateralValue (plus any
 * deposit going in with the borrow), `debt` the store's totalBorrowedValue.
 */
export const riskEngineMaxBorrowUsd = (gross: number, debt: number) => Math.max(0, (gross - LIQ_HF * debt) / (LIQ_HF - 1));

/** Collateral above the 1.10 liquidation line: holdings − 1.10 × debt (never below 0). */
export const liqBuffer = (n: AccountNumbers) => Math.max(0, n.holdings - LIQ_HF * n.debt);

/** True when the account owes nothing worth showing. */
export const noDebt = (n: AccountNumbers) => !(n.debt > 1e-6);

/**
 * Largest x in [0, hi] with ok(x) true, for ok monotone (true, then false). With `hi` omitted the
 * upper bound is found by doubling.
 */
export function bisect(ok: (x: number) => boolean, hi?: number): number {
  if (!ok(0)) return 0;
  let top = hi ?? 1000;
  if (hi === undefined) {
    let n = 0;
    while (ok(top) && n++ < 40) top *= 2;
    if (ok(top)) return top;
  } else if (ok(top)) return top;
  let lo = 0;
  for (let j = 0; j < 60; j++) {
    const m = (lo + top) / 2;
    if (ok(m)) lo = m;
    else top = m;
  }
  return lo;
}

/**
 * Safe borrow limit (USD) after `deps`: the largest total borrow, split over `symbols` in equal USD
 * shares, that keeps the health factor at or above SAFE_HF.
 */
export function maxBorrowUsd(s: ModelState, deps: Move[], symbols: string[]): number {
  const base = withDeposits(s, deps);
  if (!symbols.length) return 0;
  const ok = (b: number) => healthFactor(withBorrows(base, symbols.map((symbol) => ({ symbol, usd: b / symbols.length })))) >= SAFE_HF;
  return bisect(ok);
}

/** Largest USD of `symbol` withdrawable while the health factor stays at or above SAFE_HF (≤ `vaultUsd`). */
export function maxWithdrawUsd(s: ModelState, symbol: string, vaultUsd: number): number {
  if (!Number.isFinite(healthFactor(s))) return vaultUsd;
  return bisect((x) => healthFactor(withWithdraw(s, { symbol, usd: x })) >= SAFE_HF, vaultUsd);
}

/**
 * Every volatile price key the account is exposed to (volatile collateral, volatile debt, perps),
 * largest exposure first — the assets that get a liquidation-price row.
 */
export function exposedVolatile(s: ModelState): string[] {
  const exp = new Map<string, number>();
  const add = (key: string, usd: number) => exp.set(key, (exp.get(key) ?? 0) + Math.abs(usd));
  for (const c of s.collateral) if (!isStable(c.symbol)) add(priceKey(c.symbol), c.usd);
  for (const d of s.debts) if (!isStable(d.symbol)) add(priceKey(d.symbol), d.usd);
  for (const p of s.perps) add(p.key, p.tokens * p.index);
  return [...exp.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

export { accountNumbers };
