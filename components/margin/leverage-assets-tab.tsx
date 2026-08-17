"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useMemo, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Collaterals, BorrowInfo } from "@/lib/types";
import { DropdownOptions } from "@/lib/constants";
import { BALANCE_TYPE_OPTIONS } from "@/lib/constants/margin";
import { Button } from "@/components/ui/button";
import { Collateral } from "./collateral-box";
import { DualBorrow, type DualBorrowState } from "./dual-borrow";
import { Dialogue } from "@/components/ui/dialogue";
import {
  useMarginAccountInfoStore,
  type BorrowedBalance,
  borrowTokens,
  setupContractConfiguration,
  refreshBorrowedBalances,
  createMarginAccount,
  checkUserMarginAccount,
} from "@/store/margin-account-info-store";
import { MarginAccountService } from "@/lib/margin-utils";
import { useUserStore } from "@/store/user";
import { useTheme } from "@/contexts/theme-context";
import { useWallet } from "@/hooks/use-wallet";
import toast from "react-hot-toast";
import { normalizeContractError, normalizeDepositCollateralError } from "@/lib/errors/normalize";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useAccountSnapshot } from "@/hooks/use-account-snapshot";
import { MarginActionPreview, type PreviewRow } from "@/components/margin/margin-action-preview";
import { isTrackingSymbol } from "@/lib/analytics/stellar/canon";
import { USD_DUST_EPSILON } from "@/lib/account-snapshot";
import { getXlmMinReserve, maxSpendableXlm } from "@/lib/xlm-reserve";
import { showTxStep, showTxSuccess, showTxError } from "@/lib/tx-progress";
// Live step-by-step progress for the WB deposit(+borrow) flow — a multi-leg
// operation (deposit, then borrow, then a second borrow for Dual Borrow)
// shows which step is running (and which one failed) via the centered
// TransactionProgressModal, which updates in place, instead of a static
// "Processing..." button with no visibility into a silently-dropped leg.
const showStep = (message: string) => showTxStep(message);
const showStepSuccess = (message: string, _txHash?: string) => showTxSuccess(message);
const showStepError = (message: string) => showTxError(message);

const LIQUIDATION_THRESHOLD = 1.1;
const HF_INF_SENTINEL = 999;
const formatHF = (hf: number): string =>
  !Number.isFinite(hf) || hf >= HF_INF_SENTINEL ? "∞" : hf.toFixed(2);
const formatUsd = (n: number): string =>
  `$${(n < 0 ? 0 : n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Helper to generate unique ID for collateral
const generateCollateralId = () => `collateral-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;


// Helper to ensure collateral has ID
const ensureCollateralId = (collateral: Collaterals): Collaterals => {
  if (!collateral.id) {
    return { ...collateral, id: generateCollateralId() };
  }
  return collateral;
};

/**
 * Primary deposit + borrow surface of the margin panel. Lets the user assemble
 * collateral rows from wallet balances (WB mode) or pick existing margin-account
 * collateral (MB mode), set a leverage multiplier, and open a leveraged
 * position. The submit handler branches by mode and account state:
 *
 *  - No margin account → opens the create-account / sign-agreement dialog flow.
 *  - MB mode → borrow-only against already-deposited collateral.
 *  - WB mode → deposit + borrow. Single-collateral uses the atomic
 *    `deposit_and_borrow(_cross)` contract call (one signature); it falls back
 *    to a split 2-tx flow for multi-collateral or when the atomic call overflows
 *    Soroban's per-tx budget.
 *
 * Borrow size is pre-validated against the on-chain RiskEngine formula before
 * signing, XLM deposits respect the wallet's min-reserve, and after a confirmed
 * tx the UI is unblocked immediately (toast + form reset + optimistic store
 * merge) while balances refresh in the background. Deposit/borrow preview is
 * delegated to {@link LeveragePreviewSection}.
 */
export const LeverageAssetsTab = () => {
  const XLM_DEPOSIT_EPSILON = 1e-7;
  const { isDark } = useTheme();
  const { refreshBalances } = useWallet();
  const normalizeContractTokenSymbol = (symbol: string) => {
    if (symbol === "BLUSDC" || symbol === "BLEND_USDC" || symbol === "USDC") return "BLUSDC";
    if (symbol === "AqUSDC" || symbol === "AquiresUSDC" || symbol === "AQUARIUS_USDC") return "AQUSDC";
    if (symbol === "SoUSDC" || symbol === "SoroswapUSDC" || symbol === "SOROSWAP_USDC") return "SOUSDC";
    return symbol;
  };
  // Component state
  const hasMarginAccount = useMarginAccountInfoStore((state) => state.hasMarginAccount);
  const marginAccountAddress = useMarginAccountInfoStore((state) => state.marginAccountAddress);
  const isCreatingAccount = useMarginAccountInfoStore((state) => state.isCreatingAccount);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [borrowItems, setBorrowItems] = useState<BorrowInfo[]>([]);
  // Validated dual-borrow output (items + Total/Max + red-text error). Gates
  // the submit button; null until the user touches the borrow inputs.
  const [borrowState, setBorrowState] = useState<DualBorrowState | null>(null);
  const [leverage, setLeverage] = useState(2);
  const feesCurrency = "USDT";
  
  // Loading states
  const [isProcessing, setIsProcessing] = useState(false);

  // Borrow token selected in BorrowBox (exposed via callback)
  const [borrowToken, setBorrowToken] = useState<string>(DropdownOptions[0]);

  const userAddress = useUserStore((state) => state.address);
  const tokenBalances = useUserStore((state) => state.tokenBalances);

  useEffect(() => {
    if (!userAddress) return;
    refreshBalances(userAddress).catch((err) => {
      console.warn("Failed to refresh wallet balances on margin page:", err);
    });
  }, [userAddress, refreshBalances]);

  // Real on-chain XLM minimum reserve — see collateral-box.tsx for why a flat
  // reserve is wrong once the account holds a few trustlines. Gates the
  // "cannot deposit 100% of wallet" guard below with the account's actual
  // floor instead of an under-estimate that lets a near-Max deposit through
  // the app's check but still trap on-chain (Contract #10).
  const [xlmMinReserve, setXlmMinReserve] = useState(1.5);
  useEffect(() => {
    if (!userAddress) return;
    let cancelled = false;
    getXlmMinReserve(userAddress).then((r) => {
      if (!cancelled) setXlmMinReserve(r);
    });
    return () => {
      cancelled = true;
    };
  }, [userAddress]);

  // Dialogue state
  type DialogueState = "none" | "create-margin" | "sign-agreement";
  const [activeDialogue, setActiveDialogue] = useState<DialogueState>("none");

  // If a previous flow left isCreatingAccount=true (e.g. cross-tab success or
  // an interrupted attempt), the Sign Agreement button gets stuck on "Creating
  // Account...". Reset on dialog open — the effect only fires on the transition
  // into "sign-agreement", so it won't clobber the real loading state once the
  // user clicks Sign Agreement (handleSignAgreement re-sets the flag itself).
  useEffect(() => {
    if (activeDialogue === "sign-agreement") {
      useMarginAccountInfoStore.getState().set({ isCreatingAccount: false });
    }
  }, [activeDialogue]);

  // Map-based state for O(1) operations
  const [collaterals, setCollaterals] = useState<Map<string, Collaterals>>(
    new Map()
  );
  const [currentBorrowItems, setCurrentBorrowItems] = useState<BorrowInfo[]>(
    []
  );
  const [selectedBalanceType, setSelectedBalanceType] = useState<string>(
    BALANCE_TYPE_OPTIONS[0]
  );
  

  // Real collateral balances from margin account (on-chain data)
  const collateralBalances = useMarginAccountInfoStore((state) => state.collateralBalances);
  // Account-level collateral VALUE — the reliable "does this account hold
  // collateral?" signal (same number the header shows as Net Available). The
  // per-token `collateralBalances` map can be transiently blanked by an in-flight
  // refresh; this value is the single source of truth that gates the MB empty
  // state, so the grid never claims "no collateral" for an account that has some.
  const grossCollateralValue = useMarginAccountInfoStore((state) => state.grossCollateralValue);

  // Convert Map to stable array for rendering
  const collateralList = useMemo(() => {
    return Array.from(collaterals.values());
  }, [collaterals]);

  // Single source of truth for MB mode
  const isMBMode = collateralList.length === 1 && collateralList[0]?.balanceType.toLowerCase() === "mb";

  // Live oracle prices for USD conversions in deposit/borrow flows. Aliased
  // tokens (BLUSDC/AQUSDC/SOUSDC) resolve to USDC inside oracle-price.ts.
  const MB_TOKEN_PRICES = useTokenPrices(['XLM', 'USDC', 'BLUSDC', 'AQUSDC', 'SOUSDC']);

  // Same per-account /api/account snapshot the page HEADER reads (React Query
  // dedupes by key, so mounted consumers share the same in-memory response).
  // The route is no-store and the query is invalidated after mutations, making
  // this an authoritative snapshot rather than a browser-persisted cache.
  const { snapshot } = useAccountSnapshot(userAddress);

  // Effective collateral = store when it has balances (live/optimistic), else the
  // snapshot baseline. So the grid is never empty while the account holds value.
  const effectiveCollateral = useMemo<Record<string, BorrowedBalance>>(() => {
    const storeHas = Object.values(collateralBalances).some((b) => parseFloat(b.amount) > 0);
    if (storeHas) return collateralBalances;
    return (snapshot?.collateralBalances as Record<string, BorrowedBalance>) ?? collateralBalances;
  }, [collateralBalances, snapshot]);

  // Account-level collateral value from whichever source has it — gates the MB
  // empty state so it matches the header's Net Available figure.
  const effectiveGross =
    grossCollateralValue > 0.01 ? grossCollateralValue : snapshot?.grossCollateralValue ?? 0;

  // Live on-chain margin-account balance for a given collateral asset, keyed
  // through the same normalization the rest of this file uses. Backs MB mode's
  // manual amount entry (the "Balance: X {asset}" line + %-of-balance quick
  // chips inside the shared Collateral row editor) — the same real-balance
  // source the old full-balance checkbox grid used, just looked up live by
  // whichever asset the user has picked in the dropdown rather than frozen
  // into the row at grid-build time. Excludes farm/Blend tracking receipts
  // (BLEND_*, AQ_*, SS_*, *_LP) — those aren't borrowable margin collateral.
  const getMarginBalanceForAsset = useCallback(
    (asset: string): number => {
      const key = normalizeContractTokenSymbol(asset);
      const bal = effectiveCollateral[key];
      if (!bal || isTrackingSymbol(key) || parseFloat(bal.usdValue) <= USD_DUST_EPSILON) return 0;
      return parseFloat(bal.amount) || 0;
    },
    [effectiveCollateral]
  );

  // Entering MB with no collateral loaded yet → pull the margin-account balances
  // so the row's live Balance/% math fills in instead of flashing zero during
  // the gap. refreshBorrowedBalances dedups/throttles internally, so this is
  // safe to call on every MB enter.
  useEffect(() => {
    if (isMBMode && marginAccountAddress && effectiveGross <= 0.01) {
      refreshBorrowedBalances(marginAccountAddress, true).catch(() => {});
    }
  }, [isMBMode, marginAccountAddress, effectiveGross]);

  // Initialize with one empty collateral if none exist
  useEffect(() => {
    if (collaterals.size === 0) {
      const newId = generateCollateralId();
      const newCollateral: Collaterals = {
        id: newId,
        amount: 0,
        amountInUsd: 0,
        asset: DropdownOptions[0],
        balanceType: "wb",
        unifiedBalance: 0,
      };
      setCollaterals(new Map([[newId, newCollateral]]));
      setEditingId(newId);
    }
  }, [collaterals.size]);

  // Calculate total deposit value using live prices so the borrow preview
  // stays consistent with BorrowBox (both use the same React-Query cache).
  // Using stored amountInUsd (rounded to 2 dp) caused a price-roundtrip
  // error: 10 XLM → $1.59 stored → 1.59/0.1587 = 10.02 displayed.
  const totalDepositValue = useMemo(() => {
    return collateralList.reduce((sum, collateral) => {
      const sym = (collateral.asset || 'XLM');
      const priceKey = normalizeContractTokenSymbol(sym);
      const price = MB_TOKEN_PRICES[priceKey] ?? 1;
      return sum + (collateral.amount || 0) * price;
    }, 0);
  }, [collateralList, MB_TOKEN_PRICES]);

  // Derived values (no state needed)
  const depositAmount = totalDepositValue;
  const depositCurrency = collateralList[0]?.asset || "USDT";

  // Simple calculations
  const fees = totalDepositValue > 0 ? totalDepositValue * 0.000234 : 0;
  const totalDeposit = totalDepositValue + fees;
  // Borrow preview/input should use pure collateral USD (no fee uplift). In MB
  // mode `collateralList` holds the single margin-account row the user is
  // sizing against, so `depositAmount` already reflects whatever (possibly
  // partial) amount they've entered for it — same formula as WB.
  const effectiveTotalForBorrow = depositAmount;
  const projectedBorrowUsd = Math.max(0, effectiveTotalForBorrow * (leverage - 1));

  // Capture the validated dual-borrow output: feed the assembled items into the
  // existing borrow flow and keep the full state for submit-gating + red text.
  const handleBorrowChange = useCallback((s: DualBorrowState) => {
    setBorrowState(s);
    setBorrowItems(s.items);
    // Keep the legacy single-borrow execution path pointed at the user's first
    // chosen asset (the WB/MB submit handlers still read `borrowToken`).
    setBorrowToken(s.items[0]?.assetData.asset ?? DropdownOptions[0]);
  }, []);

  // Memoized callbacks
  const handleAddCollateral = useCallback(() => {
    if (editingId !== null) return;

    const newId = generateCollateralId();
    const newCollateral: Collaterals = {
      id: newId,
      amount: 0,
      amountInUsd: 0,
      asset: DropdownOptions[0],
      balanceType: "wb",
      unifiedBalance: 0,
    };
    setCollaterals((prev) => {
      const next = new Map(prev);
      next.set(newId, newCollateral);
      return next;
    });
    setEditingId(newId);
  }, [editingId]);

  const handleEditCollateral = (id: string) => {
    if (editingId !== null && editingId !== id) return;
    setEditingId(id);
  };

  const handleSaveCollateral = useCallback((id: string, updated: Collaterals) => {
    // Use the original id, don't generate a new one
    const collateralWithId: Collaterals = {
      ...updated,
      id: id, // Always use the original id to update existing collateral
    };
    
    setCollaterals((prev) => {
      const next = new Map(prev);
      
      if (collateralWithId.balanceType.toLowerCase() === "mb") {
        // MB mode: clear all, keep only this one
        next.clear();
        next.set(id, collateralWithId);
      } else {
        // Remove all MB collaterals, then update this one
        for (const [key, val] of next) {
          if (val.balanceType.toLowerCase() === "mb") {
            next.delete(key);
          }
        }
        // Update existing collateral with same id
        next.set(id, collateralWithId);
      }
      
      return next;
    });
    
    setEditingId(null);
  }, []);

  const handleCancelEdit = useCallback(() => {
    if (editingId !== null) {
      const collateral = collaterals.get(editingId);
      // Remove empty collateral if it's not the first one
      if (collateral && collateral.amount === 0 && collateral.amountInUsd === 0) {
        const collateralArray = Array.from(collaterals.entries());
        const isLast = collateralArray.length > 1 && 
          collateralArray[collateralArray.length - 1][0] === editingId;
        
        if (isLast) {
          setCollaterals((prev) => {
            const next = new Map(prev);
            next.delete(editingId);
            return next;
          });
        }
      }
    }
    setEditingId(null);
  }, [editingId, collaterals]);

  const handleDeleteCollateral = useCallback((id: string) => {
    if (editingId !== null) return;
    
    setCollaterals((prev) => {
      // Prevent deleting if it's the first collateral
      const collateralArray = Array.from(prev.entries());
      if (collateralArray.length > 0 && collateralArray[0][0] === id) {
        return prev; // Return unchanged
      }
      
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, [editingId]); // Remove collaterals from deps - use functional update

  const handleBalanceTypeChange = useCallback((id: string, balanceType: string) => {
    const normalized = balanceType.toLowerCase();

    setCollaterals((prev) => {
      const currentCollateral = prev.get(id) || {
        id: id,
        amount: 0,
        amountInUsd: 0,
        asset: DropdownOptions[0],
        balanceType: "wb",
        unifiedBalance: 0,
      };

      const updatedCollateral: Collaterals = {
        ...currentCollateral,
        id: id,
        balanceType: normalized,
      };

      const next = new Map(prev);

      if (normalized === "mb") {
        // MB mode: clear all, keep only this one
        next.clear();
        next.set(id, updatedCollateral);
      } else {
        // Normal mode: remove any MB collaterals, then update this one
        for (const [key, val] of next) {
          if (val.balanceType.toLowerCase() === "mb") {
            next.delete(key);
          }
        }
        next.set(id, updatedCollateral);
      }

      return next;
    });

    setSelectedBalanceType(balanceType.toUpperCase());
    // Both WB and MB are manual-entry flows now — drop the form straight back
    // into edit mode on either switch so the user can type a fresh amount
    // instead of having to click the pencil icon on a 0-amount saved card.
    setEditingId(id);
  }, []); // No dependencies - uses functional updates

  // Reset the entire Leverage Assets form back to its initial state.
  // Called after a successful Deposit & Borrow / Borrow so the next position
  // doesn't inherit stale collateral, leverage, or selected MB items.
  const resetForm = useCallback(() => {
    const newId = generateCollateralId();
    const fresh: Collaterals = {
      id: newId,
      amount: 0,
      amountInUsd: 0,
      asset: DropdownOptions[0],
      balanceType: "wb",
      unifiedBalance: 0,
    };
    setCollaterals(new Map([[newId, fresh]]));
    setEditingId(newId);
    setSelectedBalanceType(BALANCE_TYPE_OPTIONS[0]);
    setLeverage(2);
    setBorrowItems([]);
    setCurrentBorrowItems([]);
  }, []);

  const qc = useQueryClient();

  // MB-mode borrow-only flow. WB-mode (deposit + borrow compound) stays
  // imperative below because its multi-step orchestration with partial-success
  // handling doesn't fit a single-promise useMutation cleanly.
  const mbBorrowMutation = useMutation({
    mutationFn: async (params: {
      userAddress: string;
      normalizedBorrowToken: string;
      borrowAmountTokens: number;
    }) => {
      const result = await borrowTokens(
        params.userAddress,
        params.normalizedBorrowToken,
        params.borrowAmountTokens
      );
      if (!result.success) {
        throw new Error(result.error || 'Borrow failed');
      }
      return {
        hash: result.hash,
        normalizedBorrowToken: params.normalizedBorrowToken,
        borrowAmountTokens: params.borrowAmountTokens,
      };
    },
    onMutate: (params) => {
      setIsProcessing(true);
      showStep(`Borrowing ${params.borrowAmountTokens.toFixed(2)} ${params.normalizedBorrowToken}`);
    },
    onSuccess: async ({ hash, normalizedBorrowToken, borrowAmountTokens }) => {
      showStepSuccess(`Borrowed ${borrowAmountTokens.toFixed(2)} ${normalizedBorrowToken} against your margin collateral.`, hash);
      resetForm();
      qc.invalidateQueries({ queryKey: ['margin'] });
      // Force past the 3s throttle so the new debt shows immediately — the tx is
      // already confirmed in a closed ledger (pollTransactionStatus). Without
      // `true` a ledger-tick refresh moments earlier suppresses this one and the
      // position only updates on a later cycle. Swallow transient post-popup
      // throws (Freighter getAddress undefined); the ledger tick reconciles.
      if (marginAccountAddress) {
        try {
          await refreshBorrowedBalances(marginAccountAddress, true);
        } catch (e) {
          console.warn('Post-borrow refresh failed; ledger tick will reconcile:', e);
        }
      }
    },
    onError: (error) => {
      const msg = normalizeContractError(error instanceof Error ? error.message : undefined, 'Borrow failed. Please try again.');
      showStepError(msg);
    },
    onSettled: () => {
      setIsProcessing(false);
    },
  });

  const handleButtonClick = async () => {
    if (!userAddress) {
      return;
    }

    // Block the action while a collateral row is mid-edit — but only for an
    // existing margin account, where Deposit & Borrow must submit a settled
    // amount. Creating the account itself (`create_account` on-chain) takes no
    // amount at all, so a brand-new user shouldn't be blocked by the
    // auto-inserted empty collateral row before they've even decided to deposit.
    if (editingId !== null && hasMarginAccount) {
      toast.error("Please save or cancel your collateral edit before proceeding.");
      return;
    }

    if (hasMarginAccount) {
      // ── MB mode: borrow-only (collateral already in margin account) ──────────
      if (isMBMode) {
        const mbRow = collateralList[0];
        if (!mbRow) {
          toast.error('No collateral found in your margin account. Deposit collateral first using WB mode.');
          return;
        }

        // The manually-entered (possibly partial) amount for this asset — same
        // shape as WB's deposit amount, just sized against margin-account
        // balance instead of wallet balance.
        const totalCollateralUsd = depositAmount;

        if (totalCollateralUsd <= 0) {
          toast.error('Enter how much of your margin-account collateral to borrow against.');
          return;
        }

        // The row's amount is a sizing input, not a real transfer — but it
        // shouldn't claim more collateral than the account actually holds for
        // that asset, or the leverage math below would compute a target borrow
        // size the user can't actually reach safely.
        const realBalance = getMarginBalanceForAsset(mbRow.asset);
        const realBalancePrice = MB_TOKEN_PRICES[normalizeContractTokenSymbol(mbRow.asset)] ?? 1;
        const realBalanceUsd = realBalance * realBalancePrice;
        if (mbRow.amount > realBalance + 1e-7) {
          toast.error(
            `You only have ${realBalance.toFixed(4)} ${mbRow.asset} (~$${realBalanceUsd.toFixed(2)}) in your margin account. Reduce the amount or use the 100% chip.`
          );
          return;
        }

        if (leverage <= 1) {
          toast.error('Please set leverage greater than 1x to borrow.');
          return;
        }

        const borrowAmountUsd = totalCollateralUsd * (leverage - 1);
        const normalizedBorrowToken = normalizeContractTokenSymbol(borrowToken);
        const borrowTokenPrice = MB_TOKEN_PRICES[normalizedBorrowToken] ?? 1;
        const borrowAmountTokens = borrowAmountUsd / borrowTokenPrice;

        // Pre-validate against risk engine before submitting
        const latestMarginState = useMarginAccountInfoStore.getState();
        const liveTotalBorrowedValue = latestMarginState.totalBorrowedValue;
        // Match on-chain RiskEngine: gross assets = priced collateral + outstanding debt.
        const liveGrossCollateralUsd = latestMarginState.grossCollateralValue;
        const threshold = 1.1;
        const maxAdditionalBorrowUsd = Math.max(
          0,
          (liveGrossCollateralUsd - threshold * liveTotalBorrowedValue) / (threshold - 1)
        );

        if (maxAdditionalBorrowUsd <= 0) {
          toast.error("You've reached the safe borrow limit for your current collateral. Add more collateral or repay part of your loan to borrow more.");
          return;
        }

        if (borrowAmountUsd > maxAdditionalBorrowUsd) {
          const maxSafeLeverage = totalCollateralUsd > 0
            ? parseFloat((1 + (maxAdditionalBorrowUsd * 0.95) / totalCollateralUsd).toFixed(2))
            : 1;
          toast.error(`Selected leverage (${leverage}x) is above the safe limit for your collateral. Lower it to ~${maxSafeLeverage}x or add more collateral.`);
          return;
        }

        // Dual Borrow: mbBorrowMutation only ever executes ONE borrow call for
        // `borrowToken` (the DualBorrow component's first item) — it never
        // looped over a second asset, so a $165 dual-borrow request silently
        // landed as a single $165 borrow of the first asset. Mirror the WB
        // split-flow's dual-borrow loop: execute each item's own amount as a
        // separate borrowTokens() call.
        const isDualBorrow = borrowState != null && borrowState.items.length === 2;
        if (isDualBorrow) {
          setIsProcessing(true);
          const items = borrowState!.items
            .map((b) => ({
              token: normalizeContractTokenSymbol(b.assetData.asset),
              displayAsset: b.assetData.asset,
              amount: parseFloat(b.assetData.amount) || 0,
            }))
            .filter((b) => b.amount > 0);

          showStep(`Borrowing ${items.map((b) => `${b.amount.toFixed(2)} ${b.displayAsset}`).join(" + ")}`);

          let lastHash = "";
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            showStep(`Step ${i + 1}/${items.length}: Borrowing ${item.amount.toFixed(2)} ${item.displayAsset}`);
            const result = await borrowTokens(userAddress, item.token, item.amount);
            if (!result.success) {
              // Build the "first leg already landed" context BEFORE normalizing —
              // normalizeContractError returns its `raw` argument as-is (when it
              // doesn't match a cancel/generic-RPC pattern), so the context has to
              // be baked into that argument, not passed as the fallback (which is
              // only used when `raw` is empty).
              const rawWithContext = lastHash
                ? `First asset borrowed. Second borrow (${item.displayAsset}) failed: ${result.error ?? "Unknown error"}`
                : `Borrow (${item.displayAsset}) failed: ${result.error ?? "Unknown error"}`;
              const errorMsg = normalizeContractError(rawWithContext, 'Borrow failed. Please try again.');
              showStepError(errorMsg);
              try {
                await refreshBalances(userAddress);
              } catch (refreshErr) {
                console.warn("Failed to refresh wallet balances after dual-borrow failure:", refreshErr);
              }
              if (marginAccountAddress) {
                await refreshBorrowedBalances(marginAccountAddress, true);
              }
              setIsProcessing(false);
              return;
            }
            lastHash = result.hash ?? lastHash;
          }

          showStepSuccess(
            `Borrowed ${items.map((b) => `${b.amount.toFixed(2)} ${b.displayAsset}`).join(" + ")} against your margin collateral.`,
            lastHash || undefined
          );
          resetForm();
          setIsProcessing(false);
          qc.invalidateQueries({ queryKey: ['margin'] });
          if (marginAccountAddress) {
            try {
              await refreshBorrowedBalances(marginAccountAddress, true);
            } catch (e) {
              console.warn('Post-borrow refresh failed; ledger tick will reconcile:', e);
            }
          }
          return;
        }

        mbBorrowMutation.mutate({ userAddress, normalizedBorrowToken, borrowAmountTokens });
        return;
      }

      // ── WB mode: deposit + borrow (2 transactions) ───────────────────────────
      try {
        setIsProcessing(true);

        // Refresh latest risk metrics before computing borrow size
        if (marginAccountAddress) {
          await refreshBorrowedBalances(marginAccountAddress);
        }
        if (!marginAccountAddress) {
          toast.error("Margin account not found. Please reconnect wallet and try again.");
          setIsProcessing(false);
          return;
        }

        const wbDeposits = collateralList
          .filter((item) => (item.balanceType || "").toLowerCase() === "wb")
          .map((item) => {
            const normalizedAsset = normalizeContractTokenSymbol(item.asset || "XLM");
            const amount = Number(item.amount || 0);
            const amountInUsd =
              Number(item.amountInUsd || 0) ||
              amount * (MB_TOKEN_PRICES[normalizedAsset] ?? 1);
            return {
              asset: normalizedAsset,
              amount,
              amountInUsd,
            };
          })
          .filter((item) => item.amount > 0);

        if (wbDeposits.length === 0) {
          toast.error('Please enter a deposit amount greater than 0');
          setIsProcessing(false);
          return;
        }

        const multiplier = leverage; // Use the leverage state as multiplier
        const totalDepositAmountUsd = wbDeposits.reduce((sum, item) => sum + item.amountInUsd, 0);
        const totalXlmDeposit = wbDeposits
          .filter((item) => item.asset === "XLM")
          .reduce((sum, item) => sum + item.amount, 0);
        const isXlmDeposit = totalXlmDeposit > 0;
        const walletXlmBalance = parseFloat(tokenBalances.XLM || "0") || 0;
        const maxXlmDeposit = maxSpendableXlm(walletXlmBalance, xlmMinReserve);

        if (
          isXlmDeposit &&
          totalXlmDeposit > maxXlmDeposit + XLM_DEPOSIT_EPSILON
        ) {
          toast.error(`You cannot deposit that much XLM. Please keep at least ${xlmMinReserve.toFixed(2)} XLM in your wallet for the account reserve.`);
          setIsProcessing(false);
          return;
        }

        const walletBalanceForAsset = (asset: string): number => {
          switch (normalizeContractTokenSymbol(asset)) {
            case "BLUSDC":
              return parseFloat(tokenBalances.USDC || tokenBalances.BLEND_USDC || "0") || 0;
            case "AQUSDC":
              return parseFloat(tokenBalances.AQUARIUS_USDC || "0") || 0;
            case "SOUSDC":
              return parseFloat(tokenBalances.SOROSWAP_USDC || "0") || 0;
            default:
              return parseFloat(tokenBalances.XLM || "0") || 0;
          }
        };

        for (const item of wbDeposits) {
          if (item.asset === "XLM") continue;
          const available = walletBalanceForAsset(item.asset);
          if (item.amount > available + XLM_DEPOSIT_EPSILON) {
            if (available <= XLM_DEPOSIT_EPSILON) {
              const faucetHint =
                item.asset === "BLUSDC"
                  ? "Blend USDC"
                  : item.asset === "AQUSDC"
                    ? "Aquarius USDC"
                    : item.asset === "SOUSDC"
                      ? "Soroswap USDC"
                      : item.asset;
              toast.error(
                `You have no ${item.asset} in your wallet. Use the Faucet to mint ${faucetHint} first, then retry.`,
              );
            } else {
              toast.error(
                `Insufficient ${item.asset} wallet balance. Available: ${available.toFixed(2)} ${item.asset}.`,
              );
            }
            setIsProcessing(false);
            return;
          }
        }

        // Pre-validate borrow against the Risk Engine's formula before submitting.
        // On-chain: (grossAssets + borrow) / (debt + borrow) > 1.1, where grossAssets
        // = priced collateral + outstanding debt (borrowed funds still in the account).
        if (multiplier > 1) {
          const latestMarginState = useMarginAccountInfoStore.getState();
          const liveTotalBorrowedValue = latestMarginState.totalBorrowedValue;
          const liveGrossCollateralUsd = latestMarginState.grossCollateralValue;
          const threshold = 1.1;
          const projectedGrossUsd = liveGrossCollateralUsd + totalDepositAmountUsd;
          const requestedBorrowUsd = totalDepositAmountUsd * (multiplier - 1);

          const maxAdditionalBorrowUsd = Math.max(
            0,
            (projectedGrossUsd - threshold * liveTotalBorrowedValue) / (threshold - 1)
          );

          if (maxAdditionalBorrowUsd <= 0) {
            toast.error(
              'Borrow is blocked by Risk Engine: your current debt is already too high for your collateral. Add more collateral or repay first.'
            );
            setIsProcessing(false);
            return;
          }

          if (requestedBorrowUsd > maxAdditionalBorrowUsd) {
            const maxSafeLeverage = totalDepositAmountUsd > 0
              ? parseFloat((1 + (maxAdditionalBorrowUsd * 0.95) / totalDepositAmountUsd).toFixed(2))
              : 1;
            toast.error(
              `Selected leverage (${multiplier}x) exceeds your account's safe borrowing limit. Max safe leverage: ~${maxSafeLeverage}x. Add more collateral or repay existing debt first.`
            );
            setIsProcessing(false);
            return;
          }
        }


        const normalizedBorrowToken = normalizeContractTokenSymbol(borrowToken || wbDeposits[0]?.asset || "XLM");
        // True when the DualBorrow component has produced two distinct borrow assets.
        const isDualBorrow = borrowState != null && borrowState.items.length === 2;

        // Fast path: single-collateral → use the atomic contract method
        // (deposit_and_borrow for same-asset, deposit_and_borrow_cross for
        // cross-asset). One wallet signature instead of two in either case.
        const canUseAtomic = wbDeposits.length === 1;
        const isCrossAsset = wbDeposits[0]?.asset !== normalizedBorrowToken;
        // Flipped to true when the atomic deposit+borrow overflows Soroban's
        // per-tx budget, routing execution to the 2-tx split flow below.
        let useSplitFlow = !canUseAtomic;

        const depositHashes: string[] = [];
        let borrowHash = "";

        // Computed up front (not just inside the atomic branch below) so the
        // step message can state the ACTUAL borrow amount instead of trailing
        // off after "and borrowing" with nothing after it. Kept separate from
        // `borrowOptions` below, which must stay undefined for the plain
        // same-asset case so MarginAccountService derives it from `multiplier`
        // itself — this is a display-only preview of that same math.
        const atomicItem = wbDeposits[0];
        const atomicDisplayBorrow = canUseAtomic && multiplier > 1
          ? (() => {
              if (isDualBorrow && borrowState!.items.length > 0) {
                const b0 = borrowState!.items[0];
                return { amountTokens: parseFloat(b0.assetData.amount) || 0, displaySymbol: b0.assetData.asset };
              }
              if (isCrossAsset) {
                const depositUsd = atomicItem.amount * (MB_TOKEN_PRICES[atomicItem.asset] ?? 1);
                const borrowUsd = depositUsd * (multiplier - 1);
                const borrowPrice = MB_TOKEN_PRICES[normalizedBorrowToken] ?? 1;
                return {
                  amountTokens: borrowPrice > 0 ? borrowUsd / borrowPrice : 0,
                  displaySymbol: borrowToken || atomicItem.asset,
                };
              }
              return { amountTokens: atomicItem.amount * (multiplier - 1), displaySymbol: atomicItem.asset };
            })()
          : undefined;

        showStep(
          canUseAtomic
            ? `${isDualBorrow ? "Step 1/2: " : ""}Depositing ${atomicItem.amount.toFixed(2)} ${atomicItem.asset}${
                atomicDisplayBorrow
                  ? ` and borrowing ${atomicDisplayBorrow.amountTokens.toFixed(2)} ${atomicDisplayBorrow.displaySymbol}`
                  : ""
              }`
            : `Depositing ${wbDeposits.map((d) => `${d.amount.toFixed(2)} ${d.asset}`).join(" + ")}`
        );

        if (canUseAtomic) {
          const item = atomicItem;
          // For dual borrow, use the first item's explicit amount from the DualBorrow state.
          // For cross-asset single borrow, convert the leverage USD target into borrow token units.
          // Same-asset single borrow leaves options undefined so MarginAccountService uses the multiplier.
          const borrowOptions = (() => {
            if (isDualBorrow && borrowState!.items.length > 0) {
              const b0 = borrowState!.items[0];
              return {
                borrowTokenSymbol: normalizeContractTokenSymbol(b0.assetData.asset),
                borrowAmountTokens: parseFloat(b0.assetData.amount) || 0,
              };
            }
            if (isCrossAsset && multiplier > 1) {
              const depositUsd = item.amount * (MB_TOKEN_PRICES[item.asset] ?? 1);
              const borrowUsd = depositUsd * (multiplier - 1);
              const borrowPrice = MB_TOKEN_PRICES[normalizedBorrowToken] ?? 1;
              return {
                borrowTokenSymbol: normalizedBorrowToken,
                borrowAmountTokens: borrowPrice > 0 ? borrowUsd / borrowPrice : 0,
              };
            }
            return undefined;
          })();

          const atomicResult = await MarginAccountService.depositAndBorrow(
            marginAccountAddress!,
            item.amount,
            multiplier,
            item.asset,
            borrowOptions
          );
          if (atomicResult.success) {
            if (atomicResult.hash) {
              depositHashes.push(atomicResult.hash);
              if (multiplier > 1) borrowHash = atomicResult.hash;
            }
            // Dual borrow second leg: borrow the second asset as a separate tx.
            if (isDualBorrow && borrowState!.items.length > 1 && multiplier > 1) {
              const b1 = borrowState!.items[1];
              const sym1 = normalizeContractTokenSymbol(b1.assetData.asset);
              const amt1 = parseFloat(b1.assetData.amount) || 0;
              if (amt1 > 0) {
                showStep(`Step 2/2: Borrowing ${amt1.toFixed(2)} ${b1.assetData.asset}`);
                // Hand this leg the exact sequence the atomic deposit+borrow
                // tx just consumed — a fresh RPC read right after that tx
                // confirms is not reliably caught up (confirmed live:
                // txBadSeq surviving multiple growing-backoff retries).
                const borrow2Result = await borrowTokens(userAddress, sym1, amt1, atomicResult.nextSequence);
                if (borrow2Result.success) {
                  borrowHash = borrow2Result.hash ?? borrowHash;
                } else {
                  // The deposit + first borrow already landed on-chain — don't let
                  // this fall through to the unconditional "Deposit + borrow
                  // successful!" toast below, which previously masked this exact
                  // failure (second leg silently dropped, user saw a success toast
                  // and a reset form as if both borrows went through). Refresh so
                  // the UI reflects what actually happened, then stop here —
                  // mirrors the split-flow borrow-failure handling below.
                  const secondLegErrorMsg = normalizeDepositCollateralError(
                    `First asset borrowed. Second borrow (${b1.assetData.asset}) failed: ${borrow2Result.error ?? "Unknown error"}`
                  );
                  showStepError(secondLegErrorMsg);
                  try {
                    await refreshBalances(userAddress);
                  } catch (refreshErr) {
                    console.warn("Failed to refresh wallet balances after dual-borrow second-leg failure:", refreshErr);
                  }
                  if (marginAccountAddress) {
                    await refreshBorrowedBalances(marginAccountAddress, true);
                  }
                  setIsProcessing(false);
                  return;
                }
              }
            }
          } else {
            // Error(Budget, ExceededLimit): the chained deposit→borrow overflowed
            // Soroban's per-tx CPU/resource cap. It grows with pool population and
            // is a hard network limit (not a fee), so retrying the same atomic tx
            // can't help — split it into two transactions instead. The atomic tx
            // failed wholesale, so nothing was deposited; the split flow is clean.
            const isBudgetError = /budget|exceededlimit|resource/i.test(atomicResult.error ?? '');
            if (isBudgetError) {
              console.warn('[leverage] atomic deposit_and_borrow hit Soroban budget; falling back to split 2-tx flow');
              useSplitFlow = true;
            } else if (atomicResult.error?.includes('not allowed as collateral') || atomicResult.error?.includes('Max asset cap')) {
              const msg = `Contract configuration error: ${atomicResult.error}`;
              showStepError(msg);
              setIsProcessing(false);
              return;
            } else {
              const msg = normalizeDepositCollateralError(atomicResult.error);
              showStepError(msg);
              setIsProcessing(false);
              return;
            }
          }
        }

        if (useSplitFlow) {
          // Per-token deposit, then a separate borrow. Used for multi-collateral and
          // as the fallback when the atomic deposit+borrow exceeds the Soroban budget.
          const borrowsToExecute = multiplier > 1
            ? (isDualBorrow
                ? borrowState!.items
                    .map((b) => ({
                      token: normalizeContractTokenSymbol(b.assetData.asset),
                      amount: parseFloat(b.assetData.amount) || 0,
                    }))
                    .filter((b) => b.amount > 0)
                : (() => {
                    const borrowTokenPrice = MB_TOKEN_PRICES[normalizedBorrowToken] ?? 1;
                    const borrowAmountUsd = totalDepositAmountUsd * (multiplier - 1);
                    return [{ token: normalizedBorrowToken, amount: borrowAmountUsd / borrowTokenPrice }];
                  })())
            : [];
          const totalSteps = wbDeposits.length + borrowsToExecute.length;
          let stepNum = 0;

          for (const item of wbDeposits) {
            stepNum += 1;
            showStep(`Step ${stepNum}/${totalSteps}: Depositing ${item.amount.toFixed(2)} ${item.asset}`);
            const amountWad = (BigInt(Math.floor(item.amount * 1_000_000)) * BigInt(1_000_000_000_000)).toString();
            const depositResult = await MarginAccountService.depositCollateralTokens(
              marginAccountAddress!,
              item.asset,
              amountWad
            );
            if (!depositResult.success) {
              let depositErrorMsg: string;
              if (depositResult.error?.includes('not allowed as collateral') || depositResult.error?.includes('Max asset cap')) {
                depositErrorMsg = `Contract configuration error: ${depositResult.error}`;
                showStepError(depositErrorMsg);
                try {
                  const configResult = await setupContractConfiguration();
                  if (configResult.success) {
                    toast.success('Contract configuration setup successful! You can now try the deposit again.');
                  } else {
                    toast.error('Contract setup failed: ' + configResult.error);
                  }
                } catch (setupError) {
                  toast.error(normalizeContractError(setupError instanceof Error ? setupError.message : undefined, 'Setup error. Please try again.'));
                }
              } else {
                depositErrorMsg = normalizeDepositCollateralError(depositResult.error);
                showStepError(depositErrorMsg);
              }
              setIsProcessing(false);
              return;
            }

            if (depositResult.hash) depositHashes.push(depositResult.hash);
          }

          if (multiplier > 1) {
            for (const bItem of borrowsToExecute) {
              stepNum += 1;
              showStep(`Step ${stepNum}/${totalSteps}: Borrowing ${bItem.amount.toFixed(2)} ${bItem.token}`);
              const borrowResult = await borrowTokens(userAddress, bItem.token, bItem.amount);
              if (!borrowResult.success) {
                console.error('❌ Borrow failed after successful deposits:', borrowResult.error);
                const borrowErrorMsg = normalizeDepositCollateralError(
                  `Deposits were successful. Borrow ${bItem.token} failed: ${borrowResult.error || "Unknown borrow error"}`
                );
                showStepError(borrowErrorMsg);
                try {
                  await refreshBalances(userAddress);
                } catch (refreshErr) {
                  console.warn("Failed to refresh wallet balances after borrow failure:", refreshErr);
                }
                if (marginAccountAddress) {
                  await refreshBorrowedBalances(marginAccountAddress, true);
                }
                setIsProcessing(false);
                return;
              }
              borrowHash = borrowResult.hash ?? "";
            }
          }
        }

        // The tx is already confirmed in a closed ledger (pollTransactionStatus),
        // so unblock the UI NOW — toast, reset, drop the "Processing…" state — and
        // run the refresh in the BACKGROUND. Awaiting the heavy refresh
        // (SAC reconcile + borrow-rate RPCs) here was what kept the button stuck on
        // "Processing…" long after the position had already rendered. The store's
        // progressive set() updates the position/collateral within ~1-2s; any
        // refresh failure reconciles on the next ledger tick.
        const txPreview = borrowHash || depositHashes[depositHashes.length - 1] || "";
        showStepSuccess(
          isDualBorrow
            ? "Deposited collateral and borrowed both assets successfully."
            : multiplier > 1
              ? "Deposited collateral and borrowed successfully."
              : "Collateral deposited successfully.",
          txPreview || undefined
        );
        resetForm();
        setIsProcessing(false);

        // Optimistic, post-confirmation: merge the just-deposited collateral into
        // the store NOW so switching to MB shows it instantly instead of waiting on
        // the ~2-5s refresh. Safe — the tx is already confirmed; the background
        // refresh below reconciles to exact on-chain values. (Not persisted, so no
        // cross-account bleed.)
        {
          const store = useMarginAccountInfoStore.getState();
          const nextCollateral = { ...store.collateralBalances };
          for (const item of wbDeposits) {
            const key = normalizeContractTokenSymbol(item.asset);
            const price = MB_TOKEN_PRICES[key] ?? 1;
            const prevAmt = parseFloat(nextCollateral[key]?.amount || '0') || 0;
            const newAmt = prevAmt + item.amount;
            nextCollateral[key] = { amount: newAmt.toFixed(7), usdValue: (newAmt * price).toFixed(2) };
          }
          store.set({ collateralBalances: nextCollateral });
        }

        qc.invalidateQueries({ queryKey: ['margin'] });
        void (async () => {
          try {
            await refreshBalances(userAddress);
          } catch (refreshErr) {
            console.warn("Failed to refresh wallet balances after leverage action:", refreshErr);
          }
          if (marginAccountAddress) {
            try {
              await refreshBorrowedBalances(marginAccountAddress, true);
            } catch (e) {
              console.warn("Post-deposit refresh failed; ledger tick will reconcile:", e);
            }
          }
        })();

      } catch (error) {
        console.error('❌ Error in deposit and borrow:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const friendlyMsg = normalizeDepositCollateralError(errorMessage);
        showStepError(friendlyMsg);
      } finally {
        setIsProcessing(false);
      }
    } else {
      // User doesn't have margin account - show create account dialog
      setActiveDialogue("create-margin");
    }
  };

  const handleSignAgreement = async () => {
    if (!userAddress || isCreatingAccount) {
      return;
    }

    try {
      // createMarginAccount (store) already drives the progress modal and
      // the final success/error toast — don't fire a second one here.
      const created = await createMarginAccount(userAddress);

      if (created) {
        await checkUserMarginAccount(userAddress);
        setActiveDialogue("none");
      }
    } catch (error) {
      console.error("Failed to create margin account:", error);
    }
  };

  return (
    <>
      <motion.section
        className="w-full min-w-0 flex flex-col gap-2 pt-0"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        {/* Deposit section */}
        <motion.section
          className="w-full min-w-0 flex flex-col gap-1.5"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        >
          <motion.h2
            className={`w-full text-[16px] font-medium ${isDark ? "text-white" : ""}`}
            initial={{ opacity: 0, x: -10 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.3 }}
          >
            Deposit
          </motion.h2>
          <section className="flex flex-col gap-[12px]">
            {/* Both WB (deposit from wallet) and MB (borrow against existing
                margin-account collateral) share this same row editor — MB just
                sources its "Balance" and %-chip math from the live margin-account
                balance (via getMarginBalanceForAsset) instead of the wallet. */}
            <section
              className={`${collateralList.length>2?"max-h-[364px] overflow-y-auto overflow-x-visible pr-[4px]":""}  thin-scrollbar `}
            >
              <AnimatePresence mode="popLayout">
                {collateralList.length > 0 ? (
                  <ul className="flex flex-col gap-[12px]" role="list">
                    {collateralList.map((collateral, index) => {
                      const id = collateral.id!;
                      return (
                        <motion.div
                          key={id}
                          initial={{ opacity: 0, y: 20, scale: 0.95 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -20, scale: 0.95 }}
                          transition={{
                            duration: 0.3,
                            ease: "easeOut",
                            delay: index * 0.05,
                          }}
                          layout
                        >
                          <li>
                            <Collateral
                              id={id}
                              collaterals={collateral}
                              isEditing={editingId === id}
                              isAnyOtherEditing={editingId !== null && editingId !== id}
                              onEdit={handleEditCollateral}
                              onSave={handleSaveCollateral}
                              onCancel={handleCancelEdit}
                              onDelete={handleDeleteCollateral}
                              onBalanceTypeChange={handleBalanceTypeChange}
                              marginBalanceFor={getMarginBalanceForAsset}
                              index={index}
                            />
                          </li>
                        </motion.div>
                      );
                    })}
                  </ul>
                ) : (
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                    transition={{ duration: 0.3 }}
                  >
                    <Collateral
                      id={generateCollateralId()}
                      collaterals={null}
                      isEditing={true}
                      isAnyOtherEditing={false}
                      onEdit={handleEditCollateral}
                      onSave={(id, data) => {
                        const collateralWithId = ensureCollateralId(data);
                        setCollaterals(new Map([[collateralWithId.id!, collateralWithId]]));
                        setEditingId(null);
                      }}
                      onCancel={handleCancelEdit}
                      onBalanceTypeChange={handleBalanceTypeChange}
                      marginBalanceFor={getMarginBalanceForAsset}
                      index={0}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          </section>

          {/* Add Collateral button */}
          <motion.button
            type="button"
            onClick={handleAddCollateral}
            disabled={editingId !== null || isMBMode}
            className={`w-fit py-[11px] px-[10px] rounded-[8px] flex gap-[4px] text-[14px] font-medium text-[#703AE6] items-center ${
              editingId !== null || isMBMode
                ? "opacity-50 cursor-not-allowed"
                : "hover:cursor-pointer hover:bg-[#F1EBFD]"
            }`}
            whileHover={editingId === null && !isMBMode ? { x: 5 } : {}}
            transition={{ duration: 0.2 }}
            aria-label="Add new collateral"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 11 11"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                d="M5.33332 0.666748V10.0001M0.666656 5.33341H9.99999"
                stroke="#703AE6"
                strokeWidth="1.33333"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Add Collateral
          </motion.button>
        </motion.section>

        {/* Borrow section */}
        <motion.section
          className="w-full min-w-0 flex flex-col gap-1"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4, delay: 0.1, ease: "easeOut" }}
        >
          <DualBorrow
            depositUsd={effectiveTotalForBorrow}
            leverage={leverage}
            setLeverage={setLeverage}
            onChange={handleBorrowChange}
          />
        </motion.section>

        {/* Combined transaction details: static rows + before→after preview */}
        <LeveragePreviewSection
          depositAmount={depositAmount}
          projectedBorrowUsd={projectedBorrowUsd}
          isMBMode={isMBMode}
          leverage={leverage}
          fees={fees}
          totalDeposit={totalDeposit}
        />

        {/* Create Margin Account button */}
        <motion.section
          className="mt-4"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4, delay: 0.3, ease: "easeOut" }}
        >
          <Button
            disabled={isProcessing || (editingId !== null && hasMarginAccount) || !!borrowState?.error}
            size="large"
            text={
              isProcessing ? "Processing..." :
              editingId !== null && hasMarginAccount ? "Save Collateral to Continue" :
              !userAddress ? "Login" :
              hasMarginAccount  && !isMBMode
                ? leverage <= 1 ? "Deposit" : "Deposit & Borrow"
                : hasMarginAccount && isMBMode
                ? "Borrow"
                :  "Create your Margin Account"
            }
            type="gradient"
            onClick={handleButtonClick}
          />
        </motion.section>
      </motion.section>

      {/* First dialogue: Create Margin Account */}
      <AnimatePresence>
        {activeDialogue === "create-margin" && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#45454566] p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            onClick={() => setActiveDialogue("none")}
          >
            <motion.div
              className="w-full max-w-[380px]"
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ duration: 0.3 }}
              onClick={(e) => e.stopPropagation()}
            >
              <Dialogue
                buttonOnClick={() => setActiveDialogue("sign-agreement")}
                buttonText="Create Your Account"
                content={[
                  { line: "Connect your wallet to get started." },
                  {
                    line: "Confirm your Margin Account we will generate a unique address for you.",
                  },
                  { line: "Make a deposit to activate borrowing." },
                ]}
                heading="Create Margin Account"
                onClose={() => setActiveDialogue("none")}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Second dialogue: Review and Sign Agreement */}
      <AnimatePresence>
        {activeDialogue === "sign-agreement" && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#45454566] p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            onClick={() => setActiveDialogue("none")}
          >
            <motion.div
              className="w-full max-w-[480px]"
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ duration: 0.3 }}
              onClick={(e) => e.stopPropagation()}
            >
              <Dialogue
                description="Before you proceed, please review and accept the terms of borrowing on VANNA. This agreement ensures you understand the risks, responsibilities, and conditions associated with using the platform."
                buttonOnClick={() => {
                  void handleSignAgreement();
                }}
                buttonText={isCreatingAccount ? "Creating Account..." : "Sign Agreement"}
                content={[
                  {
                    line: "Collateral Requirement",
                    points: [
                      "All borrowed positions must remain fully collateralized.",
                      "If collateral value falls below the liquidation threshold, your position may be liquidated.",
                    ],
                  },
                  {
                    line: "Borrow Limits & Leverage",
                    points: [
                      "You may only borrow assets up to the maximum Loan-to-Value (LTV) allowed.",
                      "Leverage is enabled only when collateral value supports it.",
                    ],
                  },
                  {
                    line: "Interest & Fees",
                    points: [
                      "Interest rates are variable and accrue in real time.",
                      "Additional protocol fees may apply for borrowing or liquidation events.",
                    ],
                  },
                  {
                    line: "Liquidation Risk",
                    points: [
                      "Market volatility can reduce collateral value.",
                      "If your position health factor drops below safe limits, collateral may be partially or fully liquidated without prior notice.",
                    ],
                  },
                  {
                    line: "User Responsibility",
                    points: [
                      "You are responsible for monitoring your positions, balances, and risks.",
                      "VANNA is a non-custodial protocol; all actions are initiated by your wallet.",
                    ],
                  },
                  {
                    line: "No Guarantee of Returns",
                    points: [
                      "Using borrowed assets in trading, farming, or external protocols involves risk.",
                      "VANNA does not guarantee profits or protection against losses.",
                    ],
                  },
                ]}
                heading="Review and Sign Agreement"
                checkboxContent="I have read and agree to the VANNA Borrow Agreement."
                onClose={() => setActiveDialogue("none")}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

interface LeveragePreviewSectionProps {
  /** Pure collateral USD being deposited (excludes fee uplift). */
  depositAmount: number;
  /** USD to be borrowed at the selected leverage. */
  projectedBorrowUsd: number;
  /** True in MB mode, where collateral is already on-account (no fresh deposit). */
  isMBMode: boolean;
  leverage: number;
  fees: number;
  /** Deposit including fees. */
  totalDeposit: number;
}

/**
 * Renders the before → after transaction preview for the Leverage Assets action
 * (leverage, deposit, fees, collateral, debt, health factor, liquidation
 * buffer). The "before" state is read from the margin store; the "after" state
 * projects the deposit and borrow onto the gross-asset / debt risk math. Returns
 * null until there is something to preview.
 */
const LeveragePreviewSection = ({
  depositAmount,
  projectedBorrowUsd,
  isMBMode,
  leverage,
  fees,
  totalDeposit,
}: LeveragePreviewSectionProps) => {
  const totalCollateralValue = useMarginAccountInfoStore((s) => s.totalCollateralValue);
  const grossCollateralValue = useMarginAccountInfoStore((s) => s.grossCollateralValue);
  const totalBorrowedValue = useMarginAccountInfoStore((s) => s.totalBorrowedValue);
  const avgHealthFactor = useMarginAccountInfoStore((s) => s.avgHealthFactor);

  const effectiveDeposit = isMBMode ? 0 : depositAmount;
  if (effectiveDeposit <= 0 && projectedBorrowUsd <= 0) return null;

  const grossBefore = grossCollateralValue > 0
    ? grossCollateralValue
    : totalBorrowedValue > 0 && avgHealthFactor > 0
      ? avgHealthFactor * totalBorrowedValue
      : totalCollateralValue + totalBorrowedValue;
  const hfBefore = totalBorrowedValue > 0 && avgHealthFactor > 0
    ? avgHealthFactor
    : HF_INF_SENTINEL;
  const bufferBefore = Math.max(0, grossBefore - totalBorrowedValue * LIQUIDATION_THRESHOLD);

  const collateralAfter = totalCollateralValue + effectiveDeposit;
  const debtAfter = totalBorrowedValue + projectedBorrowUsd;
  // grossAfter: both new deposit and new borrow increase the gross
  // (deposit registered as collateral; borrow sits in account until deployed)
  const grossAfter = grossBefore + effectiveDeposit + projectedBorrowUsd;
  const hfAfter = debtAfter > 1e-6 ? grossAfter / debtAfter : HF_INF_SENTINEL;
  const bufferAfter = Math.max(0, grossAfter - debtAfter * LIQUIDATION_THRESHOLD);

  const rows: PreviewRow[] = [
    { label: "Leverage", before: "1.0x", after: `${leverage.toFixed(1)}x` },
    { label: "You're depositing", before: formatUsd(0), after: formatUsd(depositAmount) },
    { label: "Fees", before: formatUsd(0), after: formatUsd(fees) },
    { label: "Total deposit including fees", before: formatUsd(0), after: formatUsd(totalDeposit) },
    ...(effectiveDeposit > 0
      ? [{ label: "Margin Collateral", before: formatUsd(totalCollateralValue), after: formatUsd(collateralAfter), tone: "positive" as const }]
      : []),
    ...(projectedBorrowUsd > 0
      ? [{ label: "Outstanding Debt", before: formatUsd(totalBorrowedValue), after: formatUsd(debtAfter), tone: "negative" as const }]
      : []),
    {
      label: "Health Factor",
      before: formatHF(hfBefore),
      after: formatHF(hfAfter),
      tone: hfAfter >= hfBefore ? "positive" as const : "negative" as const,
    },
    {
      label: "Liquidation Buffer",
      before: formatUsd(bufferBefore),
      after: formatUsd(bufferAfter),
      tone: bufferAfter >= bufferBefore ? "positive" as const : "negative" as const,
    },
  ];

  return <MarginActionPreview rows={rows} className="mt-4" />;
};
