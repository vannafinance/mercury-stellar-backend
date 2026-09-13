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

/**
 * A row whose `decimals` describes its token is one that states an amount OF that token —
 * a balance, a raw or human figure, a supply, a redeemable amount — by the MCP's own field
 * conventions (`balance*`, `raw*`, `*_raw`, `human`, `*_human`, `total_*`, `redeemable*`).
 * A price row states a price, and its `decimals` is the price's.
 */
const AMOUNT_FIELD = /^(balance|raw|human|redeemable|total_supply|total_borrow|total_liquidity|total_assets)|(_raw|_human)$/;

/**
 * `symbol → decimals` from every row of every successful read that states a token amount
 * beside its `decimals`. `XLM_SAC` speaks for `XLM`. A price row also says `decimals` —
 * the PRICE's precision (the oracle reports XLM at 14) — and must not be mistaken for the
 * token's: 13 Sep, an XLM repay was cut to 14 places, which the SAC would refuse. When
 * reads disagree the coarsest wins: cutting to fewer places never breaks a contract.
 */
export function decimalsFrom(observations: readonly Observation[]): DecimalsMap {
  const found = new Map<string, number>();
  const record = (symbol: string, decimals: number) => {
    const known = found.get(symbol);
    if (known === undefined || decimals < known) found.set(symbol, decimals);
  };
  const visit = (node: unknown, depth: number) => {
    if (depth > 5) return;
    if (Array.isArray(node)) { node.forEach((item) => visit(item, depth + 1)); return; }
    if (!isRecord(node)) return;
    const decimals = Number(node.decimals);
    const describesToken = Object.entries(node).some(([key, value]) => AMOUNT_FIELD.test(key) && value !== undefined && value !== null);
    if (describesToken && Number.isInteger(decimals) && decimals >= 0 && decimals <= 18) {
      for (const key of ["symbol", "vtoken_symbol", "pool_symbol"]) {
        const symbol = node[key];
        if (typeof symbol !== "string" || !symbol) continue;
        record(symbol, decimals);
        if (symbol.endsWith("_SAC")) record(symbol.slice(0, -4), decimals);
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
