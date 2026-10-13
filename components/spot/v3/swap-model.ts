/**
 * Spot's "after this swap" simulation on the program-exact account model (lib/account-model.ts):
 * a margin swap sells `inUsd` of one collateral line and adds `outUsd` to another; debts are unchanged
 * (the margin swap never borrows). Symbols are the margin store's keys (XLM, AQUSDC, SOUSDC, …). Health factor, leverage, room before liquidation and liquidation
 * prices of the result come from the same functions every V3 page uses.
 */
import { accountNumbers, liqMultiplier, liqRoom, priceKey, type AccountNumbers, type LiqRoom, type ModelState } from "@/lib/account-model";

/** What the swap card is about to do, for the account panel's "now → after". */
export interface SwapPreview {
  /** Paying token (UI symbol). */
  from: string;
  /** Receiving token. */
  to: string;
  /** Value of the paid amount at on-chain prices, USD (0 without a quote). */
  inUsd: number;
  /** Value of the quoted output at on-chain prices, USD (0 without a quote). */
  outUsd: number;
  /** True when there is a live quote (inUsd / outUsd are meaningful). */
  quoted: boolean;
  /** Display symbol of the paying token (e.g. "SoUSDC"); falls back to `from`. */
  fromLabel?: string;
  /** Paying token's swappable balance in the margin account, as the swap card reads it on-chain. */
  fromAmount?: number;
}

/** The account after the swap: `from` collateral − inUsd, `to` collateral + outUsd. */
export function withSwap(s: ModelState, from: string, inUsd: number, to: string, outUsd: number): ModelState {
  const collateral = s.collateral.map((c) => ({ ...c }));
  const line = (sym: string) => {
    let c = collateral.find((x) => x.symbol === sym);
    if (!c) collateral.push((c = { symbol: sym, usd: 0 }));
    return c;
  };
  const a = line(from);
  a.usd = Math.max(0, a.usd - inUsd);
  line(to).usd += outUsd;
  return { ...s, collateral: collateral.filter((c) => c.usd > 1e-9) };
}

export interface AccountView {
  numbers: AccountNumbers;
  room: LiqRoom;
  /** Liquidation price of `sym` (adverse side), USD; null = none. */
  liqPrice: (sym: string, price: number, side?: "long" | "short") => number | null;
}

/** Numbers of a model state, with a liquidation-price helper bound to it. */
export function viewOf(s: ModelState): AccountView {
  return {
    numbers: accountNumbers(s),
    room: liqRoom(s),
    liqPrice: (sym, price, side) => {
      const m = liqMultiplier(s, priceKey(sym), side);
      return m !== null && price > 0 ? price * m : null;
    },
  };
}
