import { decimalWad, formatWad, ZERO } from "./fixed";

/**
 * User-facing copy when sizing refuses because the Margin page and the
 * liquidation engine are answering different collateral questions.
 *
 * Settled against RiskEngine.get_current_total_balance_internal (posted
 * tokens only). The app snapshot also adds unposted SAC on the same
 * C-address — see docs/copilot/OWNER-collateral-definition.md.
 */
export const SIZING_SOURCES_DISAGREE_WARNING =
  "The Margin page snapshot and the contract liquidation snapshot disagree, so I did not quote a borrow size. Tokens sitting in the margin account that are not posted as collateral count toward the figure shown on the Margin page, but not toward what the liquidation engine sees.";

/**
 * The plan sizer's own disagreement copy — informational, not a refusal.
 *
 * The app counts everything the account holds; the contract counts only what is posted.
 * By design those permanently disagree on any account holding an unposted balance or an
 * LP receipt — waiting for them to "agree" waits for a state most funded accounts never
 * reach. `computeSizingBasis` already sizes from the contract regardless (the one number
 * that liquidates you), so the gap is not a sizing problem; it is the unposted amount, and
 * it is worth naming. Returns null when the app reads AT OR BELOW the contract — that
 * direction is the app under-reporting, not "extra unposted funds", and sizing from the
 * contract is already the more permissive, more correct answer there.
 */
export function unpostedCollateralNote(
  app: { grossCollateralUsd: string },
  contract: { grossCollateralUsd: string },
): string | null {
  const gapWad = decimalWad(app.grossCollateralUsd) - decimalWad(contract.grossCollateralUsd);
  if (gapWad <= ZERO) return null;
  const gap = Number(formatWad(gapWad)).toFixed(2);
  return `$${gap} in your account is not posted as collateral — it does not back borrowing, and it can be withdrawn without touching your health factor.`;
}
