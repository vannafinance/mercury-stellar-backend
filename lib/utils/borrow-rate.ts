// Single source of truth for the borrow-rate curve. Shared by pool-stats and
// account-snapshot so the APR shown on Earn matches the rate fed into HF math.

/**
 * Borrow APR derived from a lending pool's live utilization.
 *
 * Industry-standard two-slope ("kinked") rate curve (Compound v2 / Aave v2):
 *   - Below optimal utilization, rate grows linearly with a gentle slope so
 *     idle liquidity stays cheap to borrow.
 *   - Above optimal, the slope steepens sharply to discourage running the
 *     pool dry and incentivise deposits.
 *
 * The constants below approximate Vanna's testnet target — tune in one place
 * once the team publishes the real RateModel parameters.
 */
export const RATE_MODEL_PARAMS = {
  baseRate: 2,        // % APR at 0% utilization
  optimalUtil: 80,    // % utilization at the kink
  slope1: 4,          // % APR added linearly from 0 → optimalUtil
  slope2: 60,         // % APR added linearly from optimalUtil → 100%
} as const;

/**
 * Convert a utilization percentage (0–100) to a borrow APR percentage.
 * Caps utilization at 100 so abnormal on-chain values don't return absurd APRs.
 */
export function computeBorrowApr(
  utilizationPct: number,
  params: typeof RATE_MODEL_PARAMS = RATE_MODEL_PARAMS,
): number {
  if (!Number.isFinite(utilizationPct) || utilizationPct <= 0) {
    return params.baseRate;
  }
  const util = Math.min(100, utilizationPct);

  if (util <= params.optimalUtil) {
    return params.baseRate + (util / params.optimalUtil) * params.slope1;
  }

  const overflow = (util - params.optimalUtil) / (100 - params.optimalUtil);
  return params.baseRate + params.slope1 + overflow * params.slope2;
}
