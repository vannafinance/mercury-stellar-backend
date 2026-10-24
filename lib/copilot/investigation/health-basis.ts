/**
 * Two figures are both called "health factor" and they differ for one account: the risk engine's
 * counts collateral POSTED to the contract, the Margin page's counts everything the account HOLDS.
 * The user is told the page's. These name the two sources so a read can be classified by what it
 * says about itself, never by how the question was worded.
 */

/** The app's own Margin-page read (`computeMarginSnapshot`), carried on `account_position`. */
export const PAGE_BASIS_SOURCE = "vanna_app_margin_snapshot";
