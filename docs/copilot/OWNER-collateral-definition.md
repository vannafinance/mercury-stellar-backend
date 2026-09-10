# Owner finding — two collateral definitions, one labelled “health factor”

**Raised:** 10 Sep 2026, Phase 3 Pass B.
**Do not change the app maths in this phase.** This note is the product decision.

## What the contract actually counts

Settled against `risk_engine.rs` on `vannafinance/Protocol_V1_Soroban` branch **`testnet`** @ `1d333fb` (10 Sep 2026), `get_current_total_balance_internal`:

```rust
let collateral_token_symbols: Vec<Symbol> =
    smart_account_contract_client.get_all_collateral_tokens();
...
for token in collateral_token_symbols.iter() {
```

It walks **only the tokens registered as collateral on the smart account** — skipping revoked tokens and frozen tracking positions, valuing LP and Blend positions through their helpers. Nothing else is counted. `liquidation_snapshot` is the same posted basis: that is the number that liquidates you.

## What the app adds

`lib/account-snapshot.ts` (line ~384):

```ts
let grossCollateralValue = farmPositionValue + rawAssetValue + nonSacCollateralValue;
```

`rawAssetValue` comes from `reconcileMarginRawSacCollateral(marginAccountAddress, …)` — raw SAC balances held by the **same margin account** (the C-address), never posted as collateral. Both sides read the same account. The app counts unposted balances; the contract does not.

This is not G-wallet cash. It is money already in the margin account that has not been pledged.

## Recorded figures (Pass A, bound account `CAHLZ…GLLJ`)

Debt agreed to four decimal places, so this is not ledger drift.

| | Collateral | Debt | Health factor |
|---|---|---|---|
| App (Margin page, copilot display) | $4,083.87 | $1,650.09 | **2.47** |
| Contract (`liquidation_snapshot`) | $3,051.15 | $1,650.09 | **1.85** |

The $1,032.72 gap is real unposted SAC. A user at a true 1.85 who believes they are at 2.47 will borrow more than they should.

## Question for the product

The contract has already answered which definition governs liquidation. The only remaining question is what the product should *show*. Only one number can be labelled “health factor” without misleading.

**Recommended answer — show both, labelled honestly, and compute health from posted only:**

| Line | Value (recorded account) | Meaning |
|---|---|---|
| Posted collateral | $3,051.15 | backs the loan; what the risk engine counts |
| In account, not posted | $1,032.72 | yours, in the margin account, **not** pledged |
| Health factor | **1.85** | posted ÷ debt — the number that liquidates you |

That stops overstating safety and turns the gap into an action: post the unposted AQUSDC (or whatever is sitting there) and health factor moves from 1.85 toward 2.47. A copilot that can say that is more useful than one quoting 2.47 as though it were already true.

## Live confirmation on the owner account (Pass B, ledger-pinned)

`CBOQAN…G5XY` at ledger **4603116** (`docs/copilot/phase-3-passB-liquidation-reconcile.json`):

| | Collateral | Debt | Health factor |
|---|---|---|---|
| App (Margin page) | $1,087.20 | $278.91 | **3.90** |
| Contract (`liquidation_snapshot`) | $953.80 | $278.91 | **3.42** |

Same pattern: debt agrees, unposted SAC is ~$133.40, and the page is the friendlier number.

## Copilot behaviour until the page changes

Pass A stands: refuse to quote a sized borrow when the two sources disagree; keep displaying the Margin-page figure so the card matches the page. The refusal now says *why* (unposted margin-account balances vs posted collateral).
