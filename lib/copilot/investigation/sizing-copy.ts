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
  "The Margin page snapshot and the contract liquidation snapshot disagree, so I did not quote a borrow size. Tokens sitting in the margin account that are not posted as collateral, and liquidity-pool receipts, count toward the figure shown on the Margin page, but not toward what the liquidation engine sees.";

/**
 * The plan sizer's own disagreement copy — informational, not a refusal.
 *
 * The app counts everything the account holds; the contract counts only what is posted.
 * By design those permanently disagree on any account holding an unposted balance or an
 * LP receipt — waiting for them to "agree" waits for a state most funded accounts never
 * reach. `computeSizingBasis` already sizes from the contract regardless (the one number
 * that liquidates you), so the gap is not a sizing problem; it is the amount the contract
 * does not count, and it is worth naming. Returns null when the app reads AT OR BELOW the
 * contract — that direction is the app under-reporting, not "extra funds", and sizing from
 * the contract is already the more permissive, more correct answer there.
 *
 * Measured 7 Oct 2026 on the test account (gap $1,049.13): $906 was a token balance held in
 * the account but absent from the contract's collateral ledger, $194 was Aquarius/Soroswap LP
 * receipts (ledger balance 0), less ~$51 where the contract values the Blend receipts higher.
 * So the gap is not only "unposted tokens", and the wording must not call an LP receipt that.
 * Nor may it say the amount can be withdrawn without moving the health factor: the Margin
 * page counts it, so taking it out lowers the figure the user is shown.
 */
export function unpostedCollateralNote(
  app: { grossCollateralUsd: string },
  contract: { grossCollateralUsd: string },
): string | null {
  const gapWad = decimalWad(app.grossCollateralUsd) - decimalWad(contract.grossCollateralUsd);
  if (gapWad <= ZERO) return null;
  const gap = Number(formatWad(gapWad)).toFixed(2);
  return `$${gap} of what the Margin page counts as collateral — tokens held in the account that are not posted as collateral, and liquidity-pool receipts — is not counted by the liquidation engine, so it does not back borrowing.`;
}
