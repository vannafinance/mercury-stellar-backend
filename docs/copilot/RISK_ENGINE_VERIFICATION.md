# Phase 3 contract verification — 2026-09-08

## Live evidence

Read-only Stellar testnet simulation, with no signing or submission, resolved the
RiskEngine through `Registry.get_risk_engine_address` and read its executable hash.

- Registry: `CBBQQULN3XZDWDZG7D6VYD4UQKBGYH22DOFQEISKENCMZTYUPQ5LDXUO`
- RiskEngine: `CCSCBA4WSUMVGA4CWC7QKBZXXEL4TO2YCCFPGHX5SJCYKHQLQUKAVUAY`
- WASM: `3e9d1180d2fb4efa4629bbd0f06d5de00835246604d45555a4ba9224c741c960`
- Timestamp: `2026-09-08T15:36:25.477Z`
- Probe ledgers: `4571639`–`4571640`

`is_account_healthy(balanceWad, debtWad)` returned:

| Balance (WAD integer) | Debt (WAD integer) | Healthy |
| --- | --- | --- |
| 109000000000000000000 | 100000000000000000000 | false |
| 110000000000000000000 | 100000000000000000000 | false |
| 111000000000000000000 | 100000000000000000000 | true |
| 0 | 0 | true |
| 0 | 9999999999999999 | false |
| 0 | 10000000000000000 | false |

This disproves the Python wrapper's unconditional dust-debt exemption. It also
shows that equality at 1.10 is rejected for the tested amounts. It does not prove
the complete implementation or how the contract values each asset/position.

The first sandbox attempt failed to retrieve contract data; the same read-only
probe outside the sandbox succeeded. Do not interpret that initial failure as a
missing deployment.

Reproduce from the orchestrator root: `node scripts/audit-risk-engine.cjs`.
The script uses only registry lookup, contract-data reads and simulation. It
needs network access, no wallet keys. A changed hash requires renewed verification.

## Changes

- Removed the positive dust-debt shortcut from the MCP RiskEngine wrapper;
  positive debt now preserves the deployed contract's verdict.
- Added `health-path.ts`: exact WAD arithmetic for an explicit user HF floor,
  inclusive/strict boundary handling, checks on every intermediate state,
  freshness, shared baseline ledger, contract identity and executable hash.
- Added regression tests for a one-WAD-unit shortfall, unsafe intermediate state,
  contract rejection, expired evidence, changed code, mixed ledgers and malformed
  amounts. Also added continuation isolation and financial normalization tests.

## Follow-up: valuation reproduced against a live account

Inspected protocol source at revision
[`61ad2653621ba6865d89bec691b4d9e69717a72b`](https://github.com/vannafinance/Protocol_V1_Soroban/blob/61ad2653621ba6865d89bec691b4d9e69717a72b/contracts/RiskEngineContract/src/risk_engine.rs)
and the corresponding SmartAccount balance getter. The getter reads recorded
`CollateralBalanceWAD` storage, not the token contract's current balance.

The source distinguishes three calculations:

| Path | Valuation behavior in inspected source |
| --- | --- |
| `get_current_total_balance` | Recorded collateral plus converted Blend receipts; does not add debt |
| Borrow/withdraw guards | Adds debt to priced collateral; skips listed LP receipts; skips individual token debts below 0.01 token |
| `is_account_healthy(balance, debt)` | Checks supplied totals against a strict 1.10 boundary; no dust shortcut |

The source's total-balance path does not contain the guards' LP skip. Therefore
the old wrapper comment that LPs always contribute zero is not reliable for every
method. LP accounting remains unavailable in the new evaluator.

`risk-engine-live-fixture.json` records a read-only check of the public account
already used in repository tests. Its parallel valuation reads all returned
ledger **4571803**, with the same RiskEngine WASM hash recorded above.
`investigation-valuation.test.ts` reconstructs the total from those inputs and
matches `get_current_total_balance` **exactly**, including both Blend rounding
steps. The recorded `BLEND_USDC` collateral balance was zero, while the separate
tracking-token balance was `377502105` base units. This position must be valued
using its tracking balance, reserve `b_rate`, token decimals and oracle price.

This establishes the raw/Blend valuation recipe for this captured deployment and
account. It does not prove that the Git revision compiled to the deployed WASM,
nor validate every account, LP type, or future contract upgrade.

The new `valuation.ts` rejects unknown/LP collateral, duplicate aliases, missing
prices, invalid receipt rates and arithmetic overflow. Distinct USDC variants
remain separate assets. It does not add debt as another collateral position.

## Product integration and rate comparison

Browser verification found the current Run handler still called the legacy path
for every message. The investigation hook was unreachable. The unified composer
now uses an authenticated Flash dispatch endpoint to select investigation versus
a concrete action's existing handler. Open investigation answers bypass fresh
classification and retain their sealed context. Cancellation, wallet changes,
provider failures and malformed route responses cannot dispatch a late action.
This classifier is not approval or an execution security boundary; existing
action validation and signing policy remain responsible for those decisions.

The investigation service now calculates same-asset Vanna borrow APR versus
Blend supply APR when the understood goal permits borrowing. Results appear in
the existing card using site styles. APR and APY are never subtracted. A positive
spread is explicitly before fees, rewards, rate changes and allocation effects.
No amount is chosen by the model and no strategy is declared executable.

## Remaining gate before sizing/approval

`health-path.ts` is a validator, not a position valuation engine or an execution
permission. Its inputs must come from trusted server-side simulation. Model output
must never supply projected contract balances or assert `contractHealthy`.

Still required:

1. Extend the verified raw/Blend recipe to more account states and establish the
   transition semantics for borrowed proceeds and deployed farm positions. LP
   shares and unpriced assets remain unsupported. Require fresh contract identity
   and state evidence before using the recipe for an executable proposal.
2. Build a simulator that produces sequential projected states from one baseline,
   including fees, swap output bounds, accrued debt and unavailable routes.
3. Bind explicit user constraints and canonical assets to strategy shapes; size
   amounts deterministically and compare net returns on consistent time horizons.
4. Connect validated proposals to server-held approval and settlement verification.

A health check at proposal time cannot promise that market movements will never
breach 1.30 later. Ongoing protection requires a separately authorized, monitored
policy with bounded actions and explicit failure behavior.

## Validation

74 orchestrator tests passed across six investigation suites; TypeScript and
targeted lint checked separately. MCP RiskEngine suite: 23 tests passed. These are
not end-to-end transaction tests, and this change has not been deployed.
