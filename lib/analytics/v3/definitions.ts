/**
 * Plain-language definitions shown in hover/focus tooltips. Static explanatory copy only: no
 * figures or product values live here (those come from the chain reads).
 */
export const definitions = {
  supplied: ["Supplied by lenders", "Assets lenders have put into the pool, including what is currently lent out, valued at the Reflector price."],
  borrowed: ["Borrowed", "What borrowers owe the pool, with interest accrued up to now."],
  cash: ["Available to withdraw", "Cash sitting in the pool that lenders can withdraw right now. It is smaller than supply whenever assets are lent out."],
  utilization: ["Utilization", "Borrowed ÷ supplied for one pool. The higher it is, the less cash is left to withdraw."],
  ratio: ["Borrowed share", "Total borrowed ÷ total supplied across all pools, in dollars."],
  borrowApr: ["Borrow APR", "The yearly rate borrowers pay at the pool's current utilization, read from the on-chain rate model."],
  supplyApr: ["Supply APR", "The yearly rate lenders earn: borrow rate × utilization, less the protocol's share."],
  health: ["Health factor", "Account value ÷ debt. Higher is safer. At or below the liquidation line the account can be liquidated."],
  status: ["Account status", "Safe - well above the liquidation line\nAt risk - a price drop could make it liquidatable\nLiquidatable - at or below the line\nNo debt - owes nothing"],
  liquidatable: ["Can be liquidated", "Health is at or below the liquidation line, so a liquidator may close the account. It has not necessarily been liquidated."],
  countedCollateral: ["Held in accounts", "Tokens and positions held by margin accounts, as each account reports them on-chain."],
  accountValue: ["Account value", "Everything in the account before debt: deposited collateral, idle borrowed funds, Blend deposits and Aquarius / Soroswap liquidity positions."],
  eligibleDebt: ["Debt that can be liquidated", "Debt of the accounts a liquidator can act on now. It is exposure, not realised loss."],
  collateralAtRisk: ["Collateral at risk", "Collateral in accounts with health under 1.50, including those already liquidatable."],
  averageLeverage: ["Average leverage", "Collateral ÷ equity, weighted by debt, across accounts with debt and positive equity."],
  totalDebt: ["Total debt", "What all margin accounts owe, accrued to now."],
  accountsAtRisk: ["Accounts at risk / active", "Left: accounts with health under 1.50. Right: active accounts (holding collateral or owing money). Empty accounts are not counted."],
  averageHealth: ["Average health", "Total collateral ÷ total debt across accounts that owe money."],
  shortfall: ["Bad debt (estimated)", "Debt that collateral no longer covers, added up across accounts. An estimate, not a realised loss."],
  coverage: ["Account coverage", "Margin accounts are listed from the Registry contract and read one by one on Soroban. Recent events come from the last ~24 hours of ledgers."],
  composition: ["What collateral is made of", "Collateral by how it is held: tokens in the account, Blend deposits, and Aquarius / Soroswap liquidity positions."],
  buffer: ["Room before liquidation", "How much collateral value could disappear, with debt unchanged, before the liquidation line."],
  hfDistribution: ["Accounts by health", "Debt at each health level. Bars left of the red line can be liquidated. Click a bar to filter the table."],
  leverageDistribution: ["Debt by leverage", "Debt grouped by leverage (collateral ÷ equity). Groups are display ranges, not protocol limits."],
  oracleFresh: ["Price freshness", "Whether the Reflector oracle returned a usable price for the asset on the latest read."],
  hhi: ["Concentration index", "From 0 (debt spread across many borrowers) to 10,000 (one borrower). Higher means more concentrated."],
  simulation: ["What-if calculation", "Your assumptions are applied to the current snapshot of accounts, on demand. Results are estimates, never transactions."],
  eligibility: ["Liquidatable vs loss", "Liquidatable: a liquidator may close it. Bad debt: collateral no longer covers what is owed. They are different states."],
} as const;
export type DefinitionKey = keyof typeof definitions;
