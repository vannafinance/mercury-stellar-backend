/**
 * Portfolio V3 maths (Stellar) — pure functions over the app's existing on-chain / Mercury reads,
 * so every Portfolio number is computed one way. Nothing here invents a figure: where the chain
 * can't back a number (an asset whose supply history isn't indexed, a debt with no borrow event)
 * the result is `null` and the page shows the zero form.
 */
import {
  buildNetBorrowCashByToken,
  calculateAccruedBorrowInterest,
  canonicalMarginPositionToken,
  type AttributionHistoryEntry,
} from "@/lib/margin-position-attribution";

/** USD price of a display symbol (XLM, BLUSDC, AQUSDC, SOUSDC, …); 0 when unknown. */
export type PriceOf = (symbol: string) => number;

/** The Stellar lending pools (earn hook keys), with the symbol each is shown / priced as. */
export const LEND_ASSETS = [
  { asset: "XLM", sym: "XLM", route: "XLM" },
  { asset: "USDC", sym: "BLUSDC", route: "BLUSDC" },
  { asset: "AQUARIUS_USDC", sym: "AQUSDC", route: "AqUSDC" },
  { asset: "SOROSWAP_USDC", sym: "SOUSDC", route: "SoUSDC" },
] as const;
export type LendAsset = (typeof LEND_ASSETS)[number]["asset"];

/** Display symbol of a lending-pool asset key (earn history rows carry the pool key). */
export const lendSym = (asset: string) => LEND_ASSETS.find((a) => a.asset === asset)?.sym ?? asset;

/** Human names for the token keys the Stellar app uses. */
export const TOKEN_NAMES: Record<string, string> = {
  XLM: "Stellar Lumens",
  BLUSDC: "Blend USDC",
  AQUSDC: "Aquarius USDC",
  SOUSDC: "Soroswap USDC",
  USDC: "USD Coin",
};

/**
 * The wallet's spendable tokens keyed by display symbol. `USDC` and `BLEND_USDC` in the wallet
 * store intentionally mirror the SAME Blend USDC balance (see ContractService.getAllTokenBalances),
 * so they collapse into one BLUSDC line — summing both would count that USDC twice.
 */
export function walletHoldings(tokenBalances: Record<string, string | undefined>): Record<string, number> {
  const n = (k: string) => parseFloat(tokenBalances[k] ?? "0") || 0;
  return {
    XLM: n("XLM"),
    BLUSDC: Math.max(n("BLEND_USDC"), n("USDC")),
    AQUSDC: n("AQUARIUS_USDC"),
    SOUSDC: n("SOROSWAP_USDC"),
  };
}

/** Wallet tokens at oracle prices, USD. */
export function walletUsd(holdings: Record<string, number>, priceOf: PriceOf): number {
  return Object.entries(holdings).reduce((t, [sym, amt]) => t + amt * priceOf(sym), 0);
}

export interface EarnTx {
  type: "supply" | "withdraw";
  asset: string;
  amount: string;
}

/**
 * Lending interest earned per pool asset, in tokens: current supply value − net principal
 * (Σ supply − Σ withdraw from the connected wallet's own Mercury / RPC history; withdraw amounts
 * are the contract's `asset_amount`, the real underlying transferred). Same calculation as the
 * previous Portfolio and the Earn page's "Net Earnings":
 * - an asset with NO history entry is `null` (unknown principal) — defaulting it to 0 would
 *   misreport the ENTIRE deposit as earned yield whenever Mercury hasn't indexed that supply yet;
 * - a non-positive difference reads 0.
 */
export function lendingEarnedByAsset(
  deposited: Record<string, number>,
  transactions: EarnTx[],
): Record<string, number | null> {
  const principal: Record<string, number> = {};
  for (const tx of transactions) {
    const amt = parseFloat(tx.amount) || 0;
    if (!(amt > 0)) continue;
    principal[tx.asset] = (principal[tx.asset] ?? 0) + (tx.type === "supply" ? amt : -amt);
  }
  const out: Record<string, number | null> = {};
  for (const { asset } of LEND_ASSETS) {
    if (!Object.prototype.hasOwnProperty.call(principal, asset)) {
      out[asset] = null;
      continue;
    }
    const diff = (deposited[asset] ?? 0) - Math.max(0, principal[asset]);
    out[asset] = diff > 0 ? diff : 0;
  }
  return out;
}

/** Σ provable lending interest × price, USD (unknown assets left out). */
export function lendingEarnedUsd(earned: Record<string, number | null>, priceOf: PriceOf): number {
  return Object.entries(earned).reduce((t, [asset, v]) => t + (v ?? 0) * priceOf(lendSym(asset)), 0);
}

/**
 * Borrow interest accrued on the open debts, USD: per canonical debt token, current on-chain debt
 * − net cash borrowed (Σ borrow − Σ repay from the margin's own history). A token with no borrow
 * event is left out (unknown). Same maths as the Margin Positions table.
 */
export function interestAccruedUsd(
  history: AttributionHistoryEntry[],
  borrowedBalances: Record<string, { amount: string }>,
  priceOf: PriceOf,
): number {
  const net = buildNetBorrowCashByToken(history);
  const debt = new Map<string, number>();
  for (const [raw, b] of Object.entries(borrowedBalances)) {
    const sym = canonicalMarginPositionToken(raw);
    const amt = parseFloat(b.amount || "0") || 0;
    if (amt > (debt.get(sym) ?? 0)) debt.set(sym, amt);
  }
  let usd = 0;
  for (const [sym, amt] of debt) {
    const i = calculateAccruedBorrowInterest(amt, net.get(sym));
    if (i !== null) usd += i * priceOf(sym);
  }
  return usd;
}
