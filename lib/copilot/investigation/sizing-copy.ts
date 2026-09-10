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
