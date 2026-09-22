# Root Cause Analysis & Remediation Plan: Margin Solvency Accounting & Copilot Integration

**Document Version**: 1.0.0  
**Date**: September 7, 2026  
**Target Repository**: `vannafinance/mercury-stellar-backend` (`vanna-copilot-orchestrator`)  
**Status**: Root Cause Confirmed & Fully Traced  

---

## 1. Executive Summary & Scope Confirmation

### 1.1 Does fixing this root cause resolve all Margin page errors and related issues?
**Yes.** 

The entire Vanna architecture—the Margin page (`/margin`), the Leverage/Boost flow (`leverage-assets-tab.tsx`), the Positions Table (`positions-table.tsx`), the Collateral Transfer module (`transfer-collateral.tsx`), and the Copilot engine (`handle.ts`, `copilot-workspace.tsx`, `risk.ts`)—relies on [`computeMarginSnapshot`](file:///c:/Users/akgam/Documents/vanna-copilot-orchestrator/lib/account-snapshot.ts#L140) as its **single source of truth** for account solvency, collateral valuation, and health factors.

Because commit `d00cd1d` injected a destructive deduction directly into the underlying on-chain data fetcher [`reconcileMarginRawSacCollateral`](file:///c:/Users/akgam/Documents/vanna-copilot-orchestrator/lib/analytics/stellar/farmTrackingCollateral.ts#L73), corrupted data was piped into every single downstream consumer. 

Fixing this single point in `farmTrackingCollateral.ts`—and allowing presentation layers to handle net equity display as they were originally designed—simultaneously resolves:
1. **The Margin Page Health Factor Collapse**: Health Factor restores from deflated $\approx 1.00$ back to true protocol solvency (e.g. $2.00$ at 2x leverage).
2. **The Erroneous Red Liquidation Warning Banner**: Clears the banner because $HF \ge 1.10$.
3. **The "Disappearing Deposit" in the Positions Table**: Newly deposited collateral will no longer vanish after executing a leveraged borrow.
4. **The "0.0x Leverage Taken / $0.00 Collateral" Bug on New Wallets**: Correctly shows collateral assets and debt.
5. **Pre-Flight Borrow Lockouts on Existing Accounts**: Removes the erroneous $2.1\times$ debt penalty blocking secondary borrows.
6. **Collateral Withdrawal Lockouts**: Safe withdrawable collateral will no longer clamp to $\$0.00$.
7. **Copilot Chat & Side-Rail Disappearing Positions**: Eliminates double-deductions in Copilot's `query_all_positions` and side rail.
8. **Copilot Spurious Risk Blocks**: Prevents `evaluateWriteRisk` from rejecting safe user strategies.
9. **Copilot Multi-Leg Execution Freezes**: Eliminates premature `paused_hf` halts during automated plan execution.
10. **The Active Failing Vitest**: Resolves the assertion failure in `tests/lib/risk-hf-projection.test.ts`.

---

## 2. Background: Vanna Protocol Accounting vs. Presentation Netting

To understand why this bug occurred, it is essential to distinguish between **Solvency Accounting** and **Presentation Netting**:

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ 1. SOLVENCY ACCOUNTING (Protocol Core)                                                      │
│ Smart margin accounts are isolated Soroban contracts holding both pure collateral and       │
│ borrowed tokens. Until borrowed cash is swapped or transferred, it sits in the account.    │
│                                                                                             │
│   • Gross Collateral Value (G) = Pure Collateral (C) + Borrowed Cash Held (D) + Farm LPs    │
│   • Total Debt (D)             = Borrowed Principal + Accrued Interest                     │
│   • Health Factor (HF)         = Gross Collateral Value / Total Debt = G / D                │
│   • Liquidation Threshold (LT) = 1.10                                                       │
│   • Liquidation Buffer         = max(0, G - 1.1 * D)                                        │
│   • Net Available Collateral   = max(0, G - D)                                              │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
                                              ▲
                                              │ Feed via computeMarginSnapshot
                                              ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ 2. PRESENTATION NETTING (UI & Chat Display Only)                                             │
│ Users do not want to see borrowed tokens mislabeled as "Collateral Deposited".               │
│ UI components apply display netting to show net deposited equity per symbol:                │
│                                                                                             │
│   • Display Collateral Amount = max(0, Gross Balance - Borrowed Debt)                       │
│   • Applied in:                                                                             │
│     - positions-table.tsx (Line 226)                                                        │
│     - copilot-workspace.tsx (Line 1921)                                                     │
│     - handle.ts / readMarginPositions (Line 2688)                                           │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Chronology & Git Archaeology: How the Regression Occurred

```
Aug 14, 2026 (Commit 04c865e)
• Initial gross collateral baseline established.
• tests/lib/account-snapshot-gross-collateral.test.ts verifies:
  $100 XLM deposit + $50 AQUSDC borrow => Gross Collateral = $150, HF = 150/50 = 3.0.
                                │
                                ▼
Aug 29, 2026 (Commit d00cd1d) — THE REGRESSION
• Developer works on Copilot Finding #53 (docs/copilot/TEST-RUN-FINDINGS.md).
• Copilot chat was showing gross balance while side-rail showed net balance.
• Instead of netting only in Copilot chat, the developer pushed the subtraction down into:
  lib/analytics/stellar/farmTrackingCollateral.ts:
    const amount = Math.max(0, rawAmount - borrowedAmount);
• This converted rawAssetValue from Gross Assets into Net Equity at the root fetcher!
• Mutated account-snapshot-gross-collateral.test.ts to assert $100 instead of $150.
                                │
                                ▼
Sep 1, 2026 (Commit 44596b5) — PARTIAL CORRECTION CREATING SPLIT-BRAIN
• Developer updates Copilot risk engine (lib/copilot/risk.ts) to match Vanna protocol rules:
    case "borrow":
      colAfter = before.collateral + effectiveBorrowUsd;
      debtAfter = before.debt + effectiveBorrowUsd;
• leverage-assets-tab.tsx preview also updated with protocol rules:
    grossAfter = grossBefore + effectiveDeposit + projectedBorrowUsd;
• CRITICAL OVERSIGHT: farmTrackingCollateral.ts was never reverted!
                                │
                                ▼
Sep 2, 2026 (PR #57 / Commit f5f6c19)
• copilot-ui-rewire branch merged into origin/dev.
• The split-brain behavior entered the codebase permanently:
  - Transaction Preview: Gross Solvency Math (HF = 2.00)
  - Fetched Margin Page Snapshot: Netted Net Equity Math (HF = 1.00)
```

---

## 4. Why Preview Succeeded While the Fetched Margin Page Failed

Let a user execute a 2.0x leverage position: Deposit **100 XLM** (~$15.00) and borrow **100 XLM** (~$15.00).

### Preview Computation ([`leverage-assets-tab.tsx#L1453`](file:///c:/Users/akgam/Documents/vanna-copilot-orchestrator/components/margin/leverage-assets-tab.tsx#L1453))
$$\text{grossAfter} = \text{grossBefore} + \text{deposit} + \text{borrow} = 0 + \$15.00 + \$15.00 = \mathbf{\$30.00}$$
$$\text{debtAfter} = \mathbf{\$15.00}$$
$$HF_{\text{preview}} = \frac{\$30.00}{\$15.00} = \mathbf{2.00 \quad (Safe)}$$
$$\text{Buffer}_{\text{preview}} = \$30.00 - 1.1 \times \$15.00 = \mathbf{\$13.50 \quad (Healthy)}$$
The preview card accurately predicts a sound, solvent transaction.

### Fetched Snapshot Computation ([`farmTrackingCollateral.ts#L73`](file:///c:/Users/akgam/Documents/vanna-copilot-orchestrator/lib/analytics/stellar/farmTrackingCollateral.ts#L73))
After the transaction confirms on Soroban testnet, `reconcileMarginRawSacCollateral` queries the account:
- Smart account holds $200\text{ XLM}$ ($100$ deposited $+ 100$ borrowed).
- Line 73 executes:
  $$\text{amount} = \max(0, \text{rawAmount} - \text{borrowedAmount}) = 200 - 100 = \mathbf{100\text{ XLM \ (\$15.00)}}$$
- `rawAssetValue` returns **$\$15.00$** instead of $\$30.00$.
- In [`lib/account-snapshot.ts#L275`](file:///c:/Users/akgam/Documents/vanna-copilot-orchestrator/lib/account-snapshot.ts#L275):
  $$\text{grossCollateralValue} = \mathbf{\$15.00}$$
- Health Factor calculation in [`lib/margin-health.ts#L36`](file:///c:/Users/akgam/Documents/vanna-copilot-orchestrator/lib/margin-health.ts#L36):
  $$HF_{\text{fetched}} = \frac{\text{grossCollateralValue}}{\text{effectiveDebt}} = \frac{\$15.00}{\$15.00} = \mathbf{1.00}$$
  $$\text{Net Available Collateral} = \$15.00 - \$15.00 = \mathbf{\$0.00}$$
- **The Red Banner**: Because $HF = 1.00 < 1.10$, [`app/margin/page.tsx#L452`](file:///c:/Users/akgam/Documents/vanna-copilot-orchestrator/app/margin/page.tsx#L452) fires:
  > *"Liquidation Risk — Health Factor 1.00 (below 1.10)..."*

---

## 5. Why New Wallets Failed Immediately and Old Accounts Failed on Deposit & Borrow

### 5.1 Why New Wallets Failed Immediately
1. **Collateral Structure**: A new wallet has $0$ LP/farm positions (`farmPositionValue = 0`). 100% of its collateral is raw SAC balances. When `reconcileMarginRawSacCollateral` subtracted borrowed debt, it wiped out 50% to 100% of the new wallet's collateral base immediately.
2. **Double-Deduction in Positions Table** ([`positions-table.tsx#L226`](file:///c:/Users/akgam/Documents/vanna-copilot-orchestrator/components/margin/positions-table.tsx#L226)):
   The table reads the already-netted $100\text{ XLM}$ and subtracts debt a second time:
   $$\text{netAmount} = \max(0, 100 - 100) = \mathbf{0\text{ XLM}}$$
   Because `netAmount <= 0`, line 228 executes `continue;`. The row is completely deleted from the table, rendering **`0.0x Leverage Taken`** and **`$0.00 Collateral`**.
3. **No Cached Shield**: New wallets had no snapshot cached in `localStorage`. The degradation guard in [`app/margin/page.tsx#L133`](file:///c:/Users/akgam/Documents/vanna-copilot-orchestrator/app/margin/page.tsx#L133) (`degraded = snapGross <= 0.01 && storeGross > 0.01`) evaluated to `false`, instantly overwriting the store with the broken snapshot.

### 5.2 Why Old Accounts Failed When Depositing and Borrowing
1. **Idle Old Accounts Appeared Normal**: Old accounts with no active borrows ($D = 0$) experienced no subtraction ($\text{rawAmount} - 0 = \text{rawAmount}$), maintaining $HF = 999$. Furthermore, old accounts with collateral deployed in Aquarius or Soroswap pools had their assets in `farmPositionValue`, which bypassed `reconcileMarginRawSacCollateral`.
2. **The Disappearing Deposit**: When an old account with $1,000\text{ XLM}$ collateral deposited $500\text{ XLM}$ and borrowed $500\text{ XLM}$, the on-chain balance became $2,000\text{ XLM}$.
   - Data fetch netted it to: $2,000 - 500 = 1,500\text{ XLM}$.
   - Positions table netted it again: $1,500 - 500 = \mathbf{1,000\text{ XLM}}$.
   - **Result**: The $500\text{ XLM}$ fresh deposit completely vanished from the UI!
3. **Pre-Flight Borrow Lockout**: In [`leverage-assets-tab.tsx#L750`](file:///c:/Users/akgam/Documents/vanna-copilot-orchestrator/components/margin/leverage-assets-tab.tsx#L750), `maxAdditionalBorrowUsd = (gross - 1.1 * debt) / 0.1`. Because `gross` was already netted ($G - D$), debt was penalized at $2.1\times$, hard-blocking the account from taking further borrows.
4. **Withdrawal Clamping**: In [`transfer-collateral.tsx#L145`](file:///c:/Users/akgam/Documents/vanna-copilot-orchestrator/components/margin/transfer-collateral.tsx#L145), safe withdrawable collateral clamped to $\$0.00$ because $HF \le 1.10$.

---

## 6. Detailed Step-by-Step Remediation Guide

To fix this completely without re-introducing Copilot discrepancies, apply the following changes:

### Step 1: Revert Debt Deduction in Data Layer
**File**: [`lib/analytics/stellar/farmTrackingCollateral.ts`](file:///c:/Users/akgam/Documents/vanna-copilot-orchestrator/lib/analytics/stellar/farmTrackingCollateral.ts#L63-L81)

```diff
@@ -63,16 +63,11 @@ export async function reconcileMarginRawSacCollateral(
     MARGIN_SAC_TOKENS.forEach(({ balanceKey }, i) => {
       const rawAmount = parseFloat(amounts[i]) || 0;
-      const borrowedAmount = borrowedBalances?.[balanceKey]
-        ? parseFloat(borrowedBalances[balanceKey]!.amount) || 0
-        : 0;
-      // The SAC balance is the total token balance held by the smart account. When
-      // borrowed cash is still sitting there, it is included in that number but is
-      // not additional collateral. Keep the old raw overlay for callers that do not
-      // have debt available, while the margin snapshot passes its authoritative debt
-      // map and anchors collateral on the net amount.
-      const amount = Math.max(0, rawAmount - borrowedAmount);
+      // Raw token balance in the smart account is gross collateral backing the loan.
+      // Borrowed assets held in the account constitute gross assets under Vanna
+      // protocol solvency rules (HF = Gross Assets / Debt). Presentation layers
+      // (positions table, Copilot side-rail) apply per-symbol net display netting.
+      const amount = rawAmount;
       const price = priceForToken(balanceKey);
       const usd = amount * price;
       rawUsdTotal += usd;
```

### Step 2: Keep Presentation Netting Intact
Do **NOT** remove the netting in:
- [`components/margin/positions-table.tsx#L226-L227`](file:///c:/Users/akgam/Documents/vanna-copilot-orchestrator/components/margin/positions-table.tsx#L226-L227)
- [`components/copilot/copilot-workspace.tsx#L1921-L1922`](file:///c:/Users/akgam/Documents/vanna-copilot-orchestrator/components/copilot/copilot-workspace.tsx#L1921-L1922)
- [`lib/copilot/handle.ts#L2688-L2689`](file:///c:/Users/akgam/Documents/vanna-copilot-orchestrator/lib/copilot/handle.ts#L2688-L2689)

Now that `collateralBalances` provides the true gross balance, their single `Math.max(0, grossAmount - debt)` display subtraction operates correctly as a single-deduction, displaying net equity without deleting rows.

### Step 3: Update Test Assertions
**File 1**: [`tests/lib/account-snapshot-gross-collateral.test.ts`](file:///c:/Users/akgam/Documents/vanna-copilot-orchestrator/tests/lib/account-snapshot-gross-collateral.test.ts#L80-L95)
Restore test assertion to verify that borrowed assets in the smart account are included in `grossCollateralValue` ($150 gross collateral, not $100 net equity).

**File 2**: [`tests/lib/farm-tracking-collateral-reconcile.test.ts`](file:///c:/Users/akgam/Documents/vanna-copilot-orchestrator/tests/lib/farm-tracking-collateral-reconcile.test.ts#L88-L104)
Update test to verify that `reconcileMarginRawSacCollateral` preserves raw SAC balances.

**File 3**: [`tests/lib/risk-hf-projection.test.ts`](file:///c:/Users/akgam/Documents/vanna-copilot-orchestrator/tests/lib/risk-hf-projection.test.ts#L113-L115)
Update expected health factor after borrow to include borrowed assets in gross collateral:
```typescript
const expectedAfter = (COLLATERAL_BEFORE + 50 * XLM_PRICE) / (DEBT_BEFORE + 50 * XLM_PRICE);
expect(simulation!.hf_after).toBeCloseTo(expectedAfter, 3);
```

---

## 7. Verification Checklist

1. **Unit Test Suite**: Run `npx vitest run` to ensure all 113 test files pass cleanly with 0 failures.
2. **New Wallet Test (Manual / E2E)**:
   - Connect fresh wallet with 0 margin history.
   - Deposit 100 XLM and borrow 15 BLUSDC (2x leverage).
   - Verify Margin page displays $\text{HF} = 2.00$, positive liquidation buffer, and no red banner.
   - Verify Positions Table displays deposited collateral and borrowed debt.
3. **Old Account Test (Manual / E2E)**:
   - Connect existing account holding prior collateral/debt.
   - Deposit additional collateral and borrow.
   - Verify fresh deposit appears in the Positions Table without vanishing.
   - Verify pre-flight borrow check allows subsequent borrows within collateral limits.
   - Verify Transfer Collateral allows withdrawing safe excess collateral.
4. **Copilot Verification**:
   - Ask Copilot: *"What are my margin positions?"*
   - Verify chat lists deposited collateral without double-deduction.
   - Execute a multi-leg leverage plan with `min_hf: 1.5` and verify it completes without false `paused_hf` halts.
