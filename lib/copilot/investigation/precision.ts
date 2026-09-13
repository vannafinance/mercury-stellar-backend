/**
 * Token precision, as the protocol reports it — never assumed.
 *
 * Every SAC line in `vanna_get_wallet_balance`, the vToken line in
 * `vanna_get_vtoken_balance`, and `vanna_get_token_balance` carry `decimals` straight from
 * the contract. A transaction amount with more places than that is refused at simulation,
 * so the resolver cuts every amount it emits to the read's figure. When no read this
 * investigation stated a token's precision, the caller asks for the wallet read (it lists
 * every protocol SAC) rather than guessing — the Notion reference, for instance, lists the
 * USDC family at 6 places while the deployed SACs report 7.
 */

import { isRecord } from "./decision";
import type { Observation } from "./types";

export type DecimalsMap = ReadonlyMap<string, number>;

/** `symbol → decimals` from every row of every successful read that states both. `XLM_SAC` speaks for `XLM`. */
export function decimalsFrom(observations: readonly Observation[]): DecimalsMap {
  const found = new Map<string, number>();
  const visit = (node: unknown, depth: number) => {
    if (depth > 5) return;
    if (Array.isArray(node)) { node.forEach((item) => visit(item, depth + 1)); return; }
    if (!isRecord(node)) return;
    const decimals = Number(node.decimals);
    if (Number.isInteger(decimals) && decimals >= 0 && decimals <= 18) {
      for (const key of ["symbol", "vtoken_symbol", "pool_symbol"]) {
        const symbol = node[key];
        if (typeof symbol !== "string" || !symbol) continue;
        found.set(symbol, decimals);
        if (symbol.endsWith("_SAC")) found.set(symbol.slice(0, -4), decimals);
      }
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };
  for (const observation of observations) {
    if (observation.status !== "ok" || !observation.data) continue;
    visit(observation.data, 0);
  }
  return found;
}

/** Cut, never round up: an amount at exactly the token's precision, with trailing zeros dropped. */
export function truncateToDecimals(amount: string, decimals: number): string {
  const [whole, fraction = ""] = amount.split(".");
  const kept = fraction.slice(0, decimals).replace(/0+$/, "");
  return kept ? `${whole}.${kept}` : whole;
}
