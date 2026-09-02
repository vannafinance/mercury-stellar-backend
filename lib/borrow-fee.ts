/**
 * SmartAccount borrow credits are net of an on-chain origination fee.
 *
 * The origination fee was set to 0% on all 4 lending pools live on 2026-08-09
 * (see deploy/testnet.env's ORIGINATION_FEE_U128 and the `update_origination_fee`
 * calls made that day) — the margin account is now credited the FULL requested
 * borrow amount, no haircut. `BORROW_ORIGINATION_FEE_BUFFER` is just a hair under
 * 1.0 to absorb WAD/7-dec rounding drift (mul/div truncation across a few hops),
 * not a fee anymore — it used to be 0.9965 to shave the real 0.3%/1% fee that
 * existed before. Any follow-up that spends the borrowed free balance (Blend
 * supply, LP add, swap) must still use the net amount, or a rounding overshoot
 * can trip HostError #10 "balance is not sufficient to spend".
 */

export const BORROW_ORIGINATION_FEE_BUFFER = 0.9999;

/** Gross borrow → spendable free balance after origination fee (+ rounding floor). */
export function netOfOriginationFee(grossAmount: number): number {
  if (!(grossAmount > 0) || !Number.isFinite(grossAmount)) return 0;
  // Floor to 7 decimals (Stellar SAC precision) so we never ask for more than credited.
  return Math.floor(grossAmount * BORROW_ORIGINATION_FEE_BUFFER * 1e7) / 1e7;
}

/**
 * Cap a spend-from-C-account amount to live free balance.
 * Returns the safe amount (possibly reduced) and whether it was capped.
 */
export function capToFreeBalance(
  requested: number,
  freeBalance: number | null | undefined,
): { amount: number; capped: boolean; free: number | null } {
  if (!(requested > 0) || !Number.isFinite(requested)) {
    return { amount: 0, capped: false, free: freeBalance ?? null };
  }
  if (freeBalance == null || !Number.isFinite(freeBalance)) {
    // No live read — still apply fee haircut defensively when caller passes null
    // after a borrow; callers that know the source was a borrow should haircut first.
    return { amount: requested, capped: false, free: null };
  }
  if (freeBalance <= 1e-7) {
    return { amount: 0, capped: true, free: freeBalance };
  }
  const safeFree = Math.floor(freeBalance * 1e7) / 1e7;
  if (requested <= safeFree + 1e-9) {
    return { amount: requested, capped: false, free: safeFree };
  }
  return { amount: safeFree, capped: true, free: safeFree };
}
