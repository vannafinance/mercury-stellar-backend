import { healthFactor, isStable, liqMultiplier, liqRoom, priceKey, type ModelState } from "@/lib/account-model";
import { isTrackingSymbol, type MarginSnapshot } from "@/lib/account-snapshot";
import { PAGE_BASIS_SOURCE } from "./health-basis";
import type { Observation } from "./types";

/**
 * The price at which the account is liquidated, as the Margin pages state it.
 *
 * "What is my XLM liquidation price?" had no read behind it, so the model called a single price
 * "not defined" or stalled. The pages already compute it - `liqMultiplier` in lib/account-model.ts
 * is what the swap page's liquidation price is built from - so this is that function, over the same
 * model state, built from the snapshot the turn already holds. No read of its own: no MCP call, no
 * RPC call, no second model turn; a scan of a few hundred evaluations over a handful of rows.
 *
 * The state is built the way the pages build it (hooks/use-v3-account.ts): one line per token with
 * a balance or a value, in USD. Only assets with a market price of their own are reported; a Blend
 * receipt or LP token follows no market price, so "its liquidation price" would be meaningless.
 */

/** The lowest price multiplier the scan reaches ("fell to near zero"), as `liqMultiplier` scans. */
const NEAR_ZERO = 0.001;

const lines = (balances: MarginSnapshot["collateralBalances"]) =>
  Object.entries(balances)
    .map(([symbol, balance]) => ({ symbol, usd: Number(balance.usdValue) || 0, amount: Number(balance.amount) || 0 }))
    .filter((line) => line.amount > 0 || line.usd > 0);

/** Today's USD price of a price key, from the account's own valuation (usd / amount) of a line that follows it. */
function priceOfKey(key: string, rows: ReadonlyArray<{ symbol: string; usd: number; amount: number }>): number | null {
  const row = rows.find((line) => priceKey(line.symbol) === key && line.amount > 0 && line.usd > 0);
  return row ? row.usd / row.amount : null;
}

const fixed = (value: number, places: number) => value.toFixed(places);
const priceText = (value: number) => (value < 1 ? fixed(value, 6) : fixed(value, 4));

export function liquidationObservation(snapshot: MarginSnapshot, observedAt: number): Observation {
  const collateral = lines(snapshot.collateralBalances);
  const debts = lines(snapshot.borrowedBalances);
  const state: ModelState = {
    collateral: collateral.map(({ symbol, usd }) => ({ symbol, usd })),
    debts: debts.map(({ symbol, usd }) => ({ symbol, usd })),
    phoenixCollateral: 0,
    perps: [],
  };
  const base = { id: "liquidation-price", capability: "account_liquidation", args: {}, observedAt, status: "ok" as const };
  const header = { source: PAGE_BASIS_SOURCE };
  const room = liqRoom(state);
  if (room.state === "nodebt") return { ...base, data: { ...header, state: "nodebt", has_debt: false, exposures: [], all_together: { falling_pct: null } } };
  if (room.state === "now") return { ...base, data: { ...header, state: "now", has_debt: true, exposures: [], all_together: { falling_pct: null } } };

  const all = [...collateral, ...debts];
  // Volatile keys the account is exposed to, each with a market price of its own.
  const keys = [...new Set(all.filter((line) => !isTrackingSymbol(line.symbol) && !isStable(line.symbol))
    .map((line) => priceKey(line.symbol)))];
  const exposures = keys.flatMap((key) => {
    const price = priceOfKey(key, all);
    if (price === null) return [];
    const move = (side: "long" | "short") => {
      const multiplier = liqMultiplier(state, key, side);
      return multiplier === null ? null : { price_usd: priceText(price * multiplier), change_pct: fixed((multiplier - 1) * 100, 2) };
    };
    const falling = move("long");
    const rising = move("short");
    const nearZero = healthFactor(state, (k) => (k === key ? NEAR_ZERO : 1));
    return [{
      symbol: key, price_usd: priceText(price), falling, rising,
      health_factor_if_near_zero: falling === null && Number.isFinite(nearZero) ? fixed(nearZero, 4) : null,
    }];
  });
  // Dollar-pegged tokens the account holds or owes. The page holds them at $1 and moves no price for them
  // (lib/account-model.ts), so no move of theirs liquidates the account; listing them is what lets a question
  // about one of them be answered as exactly that, instead of with whatever else was read.
  const pegged = [...new Set(all.filter((line) => !isTrackingSymbol(line.symbol) && isStable(line.symbol)).map((line) => line.symbol))]
    .map((symbol) => ({ symbol }));
  return {
    ...base,
    data: {
      ...header, state: room.state, has_debt: true, exposures, pegged,
      all_together: { falling_pct: room.state === "ok" && room.all !== null && room.all < 0 ? fixed(room.all, 2) : null },
    },
  };
}

const isBalances = (value: unknown): value is MarginSnapshot["collateralBalances"] =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `liquidationObservation`, or null when the snapshot is not a full one or the model cannot be
 * built from it. A derived extra must never fail the turn it decorates: the answer stands without it.
 */
export function tryLiquidationObservation(snapshot: MarginSnapshot | null | undefined, observedAt: number): Observation | null {
  if (!snapshot || !isBalances(snapshot.collateralBalances) || !isBalances(snapshot.borrowedBalances)) return null;
  try {
    return liquidationObservation(snapshot, observedAt);
  } catch {
    return null;
  }
}
