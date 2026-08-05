/**
 * Leverage sizing — one engine for every "collateral + Nx + borrow asset" ask.
 *
 * ## Why this is a module and not four copies
 *
 * The same arithmetic was inlined in handle.ts (twice), multi-leg-agent.ts (twice)
 * and mcp-write.ts, and every copy made the same two assumptions: that a borrow is
 * denominated in the collateral's units, and that the borrow asset IS the collateral
 * asset. Both are false the moment someone says "deposit 500 AQUSDC at 3x and borrow
 * XLM" — a sentence the margin UI handles without asking anything. The copilot asked
 * for a borrow size it had every input to compute, and then asked which USDC the user
 * meant when the user had said XLM.
 *
 * So the rule lives here once, and the call sites route through it. A new surface
 * that forgets to is a bug in that surface, not another silent divergence.
 *
 * ## The math is the site's math
 *
 * components/margin/leverage-assets-tab.tsx:
 *
 *     borrowAmountUsd    = totalCollateralUsd * (leverage - 1)
 *     borrowAmountTokens = borrowAmountUsd / borrowTokenPrice
 *
 * Same-asset is the special case where the two prices cancel and it degenerates to
 * `deposit * (L - 1)` — which is why the old code looked correct for years.
 *
 * "Nx" means TOTAL POSITION is N times equity, so borrow is (N−1)× equity. 3× on 500
 * is borrow 1000, total 1500. It is not borrow = 3 × 500.
 *
 * ## What this does not do
 *
 * It does not decide whether the borrow is SAFE. `can_borrow` and the risk gate still
 * run afterwards and may reject the size this computes. Sizing first and checking
 * second is the same order the UI uses: a user who asked for 3× should be told 3× is
 * too much, not asked how much they wanted.
 */

import { marginCollateralSymbol } from "./mcp-write";
import { resolveAssetDef } from "./registry/assets";
import type { MCPClient } from "./mcp-client";

/**
 * Assets the oracle quotes. The three USDC SACs are distinct TOKENS but one PRICE —
 * they are all dollar stablecoins, and the oracle carries a single USDC feed. Keeping
 * the token identity separate from the price identity is what lets "deposit AQUSDC,
 * borrow BLUSDC" price correctly without pretending the two tokens are the same.
 */
export function oraclePriceSymbol(asset?: string | null): string {
  const def = resolveAssetDef(asset);
  if (def) return def.oracleSymbol;
  // Unknown or ambiguous input falls back to the dollar feed, as it always has. This
  // is wrong for an unsupported ticker — it prices DOGE at $1 — but changing it here
  // would be a behaviour change inside a refactor. Tracked separately.
  return "USDC";
}

/** True when one unit is a dollar, so no oracle round-trip is needed to price it. */
export function isDollarStable(asset?: string | null): boolean {
  return oraclePriceSymbol(asset) === "USDC";
}

/** Same token, however the user spelled it (BLUSDC and USDC are one SAC here). */
export function sameAsset(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return marginCollateralSymbol(a) === marginCollateralSymbol(b);
}

export interface LeverageSlots {
  collateralAsset?: string | null;
  collateralAmount?: number | null;
  leverage?: number | null;
  /** Absent means "borrow the same asset" — the common single-asset case. */
  borrowAsset?: string | null;
  /** An explicit figure from the user always wins over the leverage multiple. */
  borrowAmount?: number | null;
}

export interface LeveragePlan {
  collateralAsset: string;
  collateralAmount: number;
  borrowAsset: string;
  borrowAmount: number;
  leverage: number;
  crossAsset: boolean;
  collateralUsd: number | null;
  borrowUsd: number | null;
  /** The size came from the user, not from leverage. */
  borrowExplicit: boolean;
}

/**
 * Why sizing could not be computed. Each maps to a DIFFERENT thing to say — which is
 * the point: "how much do you want to borrow?" was being used for all of them, and it
 * is the right question for none.
 */
export type LeverageGap =
  | "missing_collateral_amount"
  | "missing_leverage"
  | "missing_price";

/** Stellar carries 7 decimals; anything finer is noise the contract drops anyway. */
function roundUnits(n: number): number {
  return Math.round(n * 1e7) / 1e7;
}

/**
 * Which oracle symbols must be read before {@link planLeverage} can size this.
 *
 * Empty when both sides are dollar stables — a stable-to-stable 3× needs no network
 * call at all, so the common case stays as fast as the arithmetic it replaced.
 */
export function leveragePriceSymbols(slots: LeverageSlots): string[] {
  const borrowAsset = slots.borrowAsset || slots.collateralAsset;
  const needed = new Set<string>();
  for (const asset of [slots.collateralAsset, borrowAsset]) {
    if (asset && !isDollarStable(asset)) needed.add(oraclePriceSymbol(asset));
  }
  return [...needed];
}

/** A price in USD for one unit of `asset`, or null when it is not known. */
export function priceOf(asset: string, prices: Record<string, number>): number | null {
  if (isDollarStable(asset)) return 1;
  const p = prices[oraclePriceSymbol(asset)];
  return Number.isFinite(p) && p > 0 ? p : null;
}

/**
 * Size a leveraged position, or say precisely what is missing.
 *
 * Never guesses a price. A missing oracle read returns `missing_price` so the caller
 * can say the oracle is unavailable — inventing 1.0 for XLM would size a borrow ~11×
 * too large and hand it to a signature prompt.
 */
export function planLeverage(
  slots: LeverageSlots,
  prices: Record<string, number> = {},
): { plan: LeveragePlan } | { gap: LeverageGap; symbol?: string } {
  const collateralAsset = slots.collateralAsset || "XLM";
  const borrowAsset = slots.borrowAsset || collateralAsset;
  const collateralAmount = slots.collateralAmount ?? null;

  if (collateralAmount == null || !(collateralAmount > 0)) {
    return { gap: "missing_collateral_amount" };
  }

  const crossAsset = !sameAsset(collateralAsset, borrowAsset);
  const collateralPrice = priceOf(collateralAsset, prices);
  const borrowPrice = priceOf(borrowAsset, prices);
  const collateralUsd = collateralPrice != null ? collateralAmount * collateralPrice : null;

  // An explicit figure is the user's own answer — never overwrite it with leverage.
  if (slots.borrowAmount != null && slots.borrowAmount > 0) {
    const borrowAmount = roundUnits(slots.borrowAmount);
    const borrowUsd = borrowPrice != null ? borrowAmount * borrowPrice : null;
    return {
      plan: {
        collateralAsset,
        collateralAmount,
        borrowAsset,
        borrowAmount,
        // Report the leverage that figure actually represents, so the plan copy and
        // the risk gate describe the same position the user asked for.
        leverage:
          collateralUsd != null && borrowUsd != null && collateralUsd > 0
            ? roundUnits(1 + borrowUsd / collateralUsd)
            : (slots.leverage ?? 2),
        crossAsset,
        collateralUsd,
        borrowUsd,
        borrowExplicit: true,
      },
    };
  }

  const leverage = slots.leverage;
  if (leverage == null || !(leverage > 1)) return { gap: "missing_leverage" };

  // Same asset: the prices cancel, so this works even with the oracle down.
  if (!crossAsset) {
    const borrowAmount = roundUnits(collateralAmount * (leverage - 1));
    return {
      plan: {
        collateralAsset,
        collateralAmount,
        borrowAsset,
        borrowAmount,
        leverage,
        crossAsset: false,
        collateralUsd,
        borrowUsd: collateralUsd != null ? roundUnits(collateralUsd * (leverage - 1)) : null,
        borrowExplicit: false,
      },
    };
  }

  if (collateralPrice == null) {
    return { gap: "missing_price", symbol: oraclePriceSymbol(collateralAsset) };
  }
  if (borrowPrice == null) {
    return { gap: "missing_price", symbol: oraclePriceSymbol(borrowAsset) };
  }

  const borrowUsd = collateralAmount * collateralPrice * (leverage - 1);
  return {
    plan: {
      collateralAsset,
      collateralAmount,
      borrowAsset,
      borrowAmount: roundUnits(borrowUsd / borrowPrice),
      leverage,
      crossAsset: true,
      collateralUsd: roundUnits(collateralAmount * collateralPrice),
      borrowUsd: roundUnits(borrowUsd),
      borrowExplicit: false,
    },
  };
}

/** Compact number for prose — no trailing zeros, no scientific notation. */
function num(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const fixed = Math.abs(n) >= 1 ? n.toFixed(Math.abs(n) >= 100 ? 2 : 4) : n.toFixed(7);
  return fixed.replace(/\.?0+$/, "") || "0";
}

function usd(n: number | null): string {
  return n == null ? "" : ` (≈$${num(n)})`;
}

/**
 * The plan line shown before signing — with USD equivalents, like the site.
 *
 * Cross-asset gets an explicit conversion sentence because "borrow 11,000 XLM against
 * 500 AQUSDC" looks like a mistake until you see the two dollar figures next to it.
 */
export function describeLeveragePlan(plan: LeveragePlan, labels?: {
  collateral?: string;
  borrow?: string;
}): string {
  const c = labels?.collateral || plan.collateralAsset;
  const b = labels?.borrow || plan.borrowAsset;

  if (plan.borrowExplicit) {
    return `Borrowing ${num(plan.borrowAmount)} ${b}${usd(plan.borrowUsd)} against ${num(plan.collateralAmount)} ${c}${usd(plan.collateralUsd)}.`;
  }

  if (!plan.crossAsset) {
    const total = roundUnits(plan.collateralAmount + plan.borrowAmount);
    return (
      `${plan.leverage}× means total position ≈ ${num(total)} ${c} on ${num(plan.collateralAmount)} ${c} equity ` +
      `(deposit ${num(plan.collateralAmount)} + borrow ${num(plan.borrowAmount)} = ${plan.leverage}×, ` +
      `not borrow ${num(plan.collateralAmount * plan.leverage)}).`
    );
  }

  return (
    `${plan.leverage}× on ${num(plan.collateralAmount)} ${c}${usd(plan.collateralUsd)} means borrowing ` +
    `${usd(plan.borrowUsd).trim().replace(/[()≈]/g, "")} of ${b} — ${num(plan.borrowAmount)} ${b} at the current oracle price.`
  );
}

/**
 * The two signed legs a leveraged position becomes.
 *
 * MCP's combined `deposit_and_borrow` runs `is_borrow_allowed` against CURRENT
 * collateral, so the deposit must land before the borrow is even checked — hence two
 * legs rather than one atomic call.
 *
 * Both legs are FULLY determined here, size and asset. That is the whole of product
 * rule D: whatever runs leg 2 — a next_step hop, a resume, a plan replay — needs no
 * further input from the user, so it cannot reopen a question they already answered.
 */
export function leverageLegs(plan: LeveragePlan): {
  deposit: { op: "deposit_collateral"; asset: string; amount: number };
  borrow: { op: "borrow"; asset: string; amount: number };
} {
  return {
    deposit: {
      op: "deposit_collateral",
      asset: plan.collateralAsset,
      amount: plan.collateralAmount,
    },
    borrow: { op: "borrow", asset: plan.borrowAsset, amount: plan.borrowAmount },
  };
}

/**
 * Oracle prices for the symbols a leverage plan needs.
 *
 * Best-effort by design: a failed read yields an empty map, `planLeverage` reports
 * `missing_price`, and the caller says the oracle is unavailable. That is a worse
 * outcome than sizing, and a much better one than sizing off a guess.
 */
export async function fetchLeveragePrices(
  mcp: MCPClient,
  symbols: string[],
  userId?: string,
): Promise<Record<string, number>> {
  if (!symbols.length) return {};
  try {
    const batch = await mcp.call("vanna_get_prices_batch", { symbols }, userId);
    const raw = (batch.prices || batch) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const symbol of symbols) {
      const row = (raw[symbol] ?? raw[symbol.toLowerCase()]) as
        | { price_usd?: string | number }
        | undefined;
      const p = Number(row?.price_usd);
      if (Number.isFinite(p) && p > 0) out[symbol] = p;
    }
    return out;
  } catch {
    return {};
  }
}
