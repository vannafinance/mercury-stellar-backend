"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useMemo, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Collaterals, BorrowInfo } from "@/lib/types";
import { DropdownOptions } from "@/lib/constants";
import { BALANCE_TYPE_OPTIONS } from "@/lib/constants/margin";
import { Button } from "@/components/ui/button";
import { Collateral } from "./collateral-box";
import { BorrowBox } from "./borrow-box";
import { MBSelectionGrid } from "./mb-selection-grid";
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
import { appendMarginHistory } from "@/lib/margin-history";
import toast from "react-hot-toast";
import { normalizeContractError, normalizeDepositCollateralError, normalizeCreateAccountError } from "@/lib/errors/normalize";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { MarginActionPreview, type PreviewRow } from "@/components/margin/margin-action-preview";
import { isTrackingSymbol } from "@/lib/analytics/stellar/canon";

const LIQUIDATION_THRESHOLD = 1.1;
const HF_INF_SENTINEL = 999;
const formatHF = (hf: number): string =>
  !Number.isFinite(hf) || hf >= HF_INF_SENTINEL ? "∞" : hf.toFixed(2);
const formatUsd = (n: number): string =>
  `$${(n < 0 ? 0 : n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
type Modes = "Deposit" | "Borrow";

// Helper to generate unique ID for collateral
const generateCollateralId = () => `collateral-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;


// Helper to ensure collateral has ID
const ensureCollateralId = (collateral: Collaterals): Collaterals => {
  if (!collateral.id) {
    return { ...collateral, id: generateCollateralId() };
  }
  return collateral;
};

export const LeverageAssetsTab = () => {
  const XLM_WALLET_RESERVE = 1;
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
  const mode: Modes = "Deposit";
  const [borrowItems, setBorrowItems] = useState<BorrowInfo[]>([]);
  const [leverage, setLeverage] = useState(2);
  const feesCurrency = "USDT";
  
  // Loading states
  const [isProcessing, setIsProcessing] = useState(false);

  // Borrow token selected in BorrowBox (exposed via callback)
  const [borrowToken, setBorrowToken] = useState<string>(DropdownOptions[0]);

  // MB mode: which margin-account collaterals the user has selected to use.
  // Item IDs use the same `${asset}-${amount}` format as MBSelectionGrid.
  const [mbSelectedIds, setMbSelectedIds] = useState<Set<string>>(new Set());

  const userAddress = useUserStore((state) => state.address);
  const tokenBalances = useUserStore((state) => state.tokenBalances);

  useEffect(() => {
    if (!userAddress) return;
    refreshBalances(userAddress).catch((err) => {
      console.warn("Failed to refresh wallet balances on margin page:", err);
    });
  }, [userAddress, refreshBalances]);

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

  // Convert Map to stable array for rendering
  const collateralList = useMemo(() => {
    return Array.from(collaterals.values());
  }, [collaterals]);

  // Single source of truth for MB mode
  const isMBMode = collateralList.length === 1 && collateralList[0]?.balanceType.toLowerCase() === "mb";

  // Live oracle prices for USD conversions in deposit/borrow flows. Aliased
  // tokens (BLUSDC/AQUSDC/SOUSDC) resolve to USDC inside oracle-price.ts.
  const MB_TOKEN_PRICES = useTokenPrices(['XLM', 'USDC', 'BLUSDC', 'AQUSDC', 'SOUSDC']);

  // Build Collaterals[] from real on-chain margin account collateral (used in MB
  // mode grid). Show every REAL collateral token the account holds (XLM / USDC
  // family) so the user can borrow against their full balance. Exclude farm /
  // Blend tracking receipts (BLEND_*, AQ_*, SS_*, *_LP) — those are enriched into
  // collateralBalances for HF math but are farm positions, not borrowable margin
  // collateral (and have no token icon). Mirrors the positions table's filter.
  // Dust is shown via adaptive formatting, not hidden.
  const mbCollateralItems = useMemo((): Collaterals[] => {
    return (Object.entries(collateralBalances) as [string, BorrowedBalance][])
      .filter(([token, bal]) => parseFloat(bal.amount) > 0 && !isTrackingSymbol(token))
      .map(([token, bal]): Collaterals => ({
        asset: token,
        amount: parseFloat(parseFloat(bal.amount).toFixed(7)),
        amountInUsd: parseFloat(parseFloat(bal.usdValue).toFixed(2)),
        balanceType: "mb",
        unifiedBalance: parseFloat(bal.usdValue),
      }));
  }, [collateralBalances]);

  // When entering MB mode (or when margin-account collaterals first appear),
  // pre-select every available collateral so the user can borrow against the
  // full margin account without having to re-tick boxes manually.
  useEffect(() => {
    if (!isMBMode || mbCollateralItems.length === 0) return;
    setMbSelectedIds((prev) => {
      if (prev.size > 0) return prev;
      return new Set(mbCollateralItems.map((item) => `${item.asset}-${item.amount}`));
    });
  }, [isMBMode, mbCollateralItems]);

  // Total USD across selected MB collaterals — uses each item's full margin
  // balance (no per-asset edit amounts now that selection is binary).
  const mbSelectedUsd = useMemo(() => {
    if (!isMBMode) return 0;
    return mbCollateralItems.reduce((sum, item) => {
      const itemId = `${item.asset}-${item.amount}`;
      if (!mbSelectedIds.has(itemId)) return sum;
      const price = MB_TOKEN_PRICES[item.asset] ?? 1;
      return sum + item.amount * price;
    }, 0);
  }, [isMBMode, mbCollateralItems, mbSelectedIds, MB_TOKEN_PRICES]);

  const handleMbToggleSelection = useCallback((itemId: string) => {
    setMbSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }, []);

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
  const mbTotalUsd = mbSelectedUsd;

  // Simple calculations
  const fees = totalDepositValue > 0 ? totalDepositValue * 0.000234 : 0;
  const totalDeposit = totalDepositValue + fees;
  // Borrow preview/input should use pure collateral USD (no fee uplift).
  const effectiveTotalForBorrow = isMBMode ? mbSelectedUsd : depositAmount;
  const projectedBorrowUsd = Math.max(0, effectiveTotalForBorrow * (leverage - 1));

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
    // When the user switches MB→WB, drop the form straight back into edit
    // mode so they can type a fresh amount instead of having to click the
    // pencil icon on a 0-amount saved card.
    if (normalized === "wb") {
      setEditingId(id);
    } else {
      setEditingId(null);
    }
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
    setMbSelectedIds(new Set());
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
    onMutate: () => {
      setIsProcessing(true);
    },
    onSuccess: async ({ hash, normalizedBorrowToken, borrowAmountTokens }) => {
      if (hash && marginAccountAddress) {
        appendMarginHistory({
          marginAccountAddress,
          type: "borrow",
          asset: normalizedBorrowToken,
          amount: borrowAmountTokens.toFixed(7),
          hash,
        });
      }
      toast.success('Borrow successful! Tx: ' + (hash ? hash.slice(0, 16) + '…' : ''));
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
      toast.error(normalizeContractError(error instanceof Error ? error.message : undefined, 'Borrow failed. Please try again.'));
    },
    onSettled: () => {
      setIsProcessing(false);
    },
  });

  const handleButtonClick = async () => {
    if (!userAddress) {
      return;
    }

    // Block the action while a collateral row is mid-edit. Otherwise clicking
    // Deposit & Borrow would submit the previously-saved amount even though
    // the user has the row open and may be in the middle of changing it.
    if (editingId !== null) {
      toast.error("Please save or cancel your collateral edit before proceeding.");
      return;
    }

    if (hasMarginAccount) {
      // ── MB mode: borrow-only (collateral already in margin account) ──────────
      if (isMBMode) {
        if (mbCollateralItems.length === 0) {
          toast.error('No collateral found in your margin account. Deposit collateral first using WB mode.');
          return;
        }

        // Sum the full balance of every selected MB collateral.
        const totalCollateralUsd = mbCollateralItems.reduce((sum, item) => {
          const itemId = `${item.asset}-${item.amount}`;
          if (!mbSelectedIds.has(itemId)) return sum;
          const price = MB_TOKEN_PRICES[item.asset] ?? 1;
          return sum + item.amount * price;
        }, 0);

        if (totalCollateralUsd <= 0) {
          toast.error('Select at least one collateral from your margin account.');
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
          toast.error('Borrow blocked by Risk Engine: debt too high for current collateral. Repay first.');
          return;
        }

        if (borrowAmountUsd > maxAdditionalBorrowUsd) {
          const maxSafeLeverage = totalCollateralUsd > 0
            ? parseFloat((1 + (maxAdditionalBorrowUsd * 0.95) / totalCollateralUsd).toFixed(2))
            : 1;
          toast.error(`Selected leverage (${leverage}x) exceeds safe limit. Max safe leverage: ~${maxSafeLeverage}x.`);
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
        const maxXlmDeposit = Math.max(0, walletXlmBalance - XLM_WALLET_RESERVE);

        if (
          isXlmDeposit &&
          totalXlmDeposit > maxXlmDeposit + XLM_DEPOSIT_EPSILON
        ) {
          toast.error("You cannot deposit 100% of your wallet balance. Please keep at least 1 XLM in your wallet.");
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

        if (canUseAtomic) {
          const item = wbDeposits[0];
          // For cross-asset borrow, convert the leverage USD target into the
          // borrow token's units using the same flat price map the rest of
          // the page uses. Same-asset case lets MarginAccountService compute
          // the borrow amount from the multiplier.
          const borrowOptions = isCrossAsset && multiplier > 1
            ? (() => {
                const depositUsd = item.amount * (MB_TOKEN_PRICES[item.asset] ?? 1);
                const borrowUsd = depositUsd * (multiplier - 1);
                const borrowPrice = MB_TOKEN_PRICES[normalizedBorrowToken] ?? 1;
                return {
                  borrowTokenSymbol: normalizedBorrowToken,
                  borrowAmountTokens: borrowPrice > 0 ? borrowUsd / borrowPrice : 0,
                };
              })()
            : undefined;

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
            appendMarginHistory({
              marginAccountAddress: marginAccountAddress!,
              type: "deposit",
              asset: item.asset,
              amount: item.amount.toFixed(7),
              hash: atomicResult.hash ?? "",
            });
            if (multiplier > 1) {
              const borrowAmountTokens = item.amount * (multiplier - 1);
              appendMarginHistory({
                marginAccountAddress: marginAccountAddress!,
                type: "borrow",
                asset: normalizedBorrowToken,
                amount: borrowAmountTokens.toFixed(7),
                hash: atomicResult.hash ?? "",
              });
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
              toast.error(`Contract configuration error: ${atomicResult.error}`);
              setIsProcessing(false);
              return;
            } else {
              toast.error(normalizeDepositCollateralError(atomicResult.error));
              setIsProcessing(false);
              return;
            }
          }
        }

        if (useSplitFlow) {
          // Per-token deposit, then a separate borrow. Used for multi-collateral and
          // as the fallback when the atomic deposit+borrow exceeds the Soroban budget.
          for (const item of wbDeposits) {
            const amountWad = (BigInt(Math.floor(item.amount * 1_000_000)) * BigInt(1_000_000_000_000)).toString();
            const depositResult = await MarginAccountService.depositCollateralTokens(
              marginAccountAddress!,
              item.asset,
              amountWad
            );
            if (!depositResult.success) {
              if (depositResult.error?.includes('not allowed as collateral') || depositResult.error?.includes('Max asset cap')) {
                toast.error(`Contract configuration error: ${depositResult.error}`);
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
                toast.error(normalizeDepositCollateralError(depositResult.error));
              }
              setIsProcessing(false);
              return;
            }

            if (depositResult.hash) depositHashes.push(depositResult.hash);
            appendMarginHistory({
              marginAccountAddress: marginAccountAddress!,
              type: "deposit",
              asset: item.asset,
              amount: item.amount.toFixed(7),
              hash: depositResult.hash ?? "",
            });
          }

          if (multiplier > 1) {
            const borrowTokenPrice = MB_TOKEN_PRICES[normalizedBorrowToken] ?? 1;
            const borrowAmountUsd = totalDepositAmountUsd * (multiplier - 1);
            const borrowAmountTokens = borrowAmountUsd / borrowTokenPrice;

            const borrowResult = await borrowTokens(userAddress, normalizedBorrowToken, borrowAmountTokens);
            if (!borrowResult.success) {
              console.error('❌ Borrow failed after successful deposits:', borrowResult.error);
              toast.error(normalizeDepositCollateralError(
                `Deposits were successful. Borrow failed: ${borrowResult.error || "Unknown borrow error"}`
              ));
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
            appendMarginHistory({
              marginAccountAddress: marginAccountAddress!,
              type: "borrow",
              asset: normalizedBorrowToken,
              amount: borrowAmountTokens.toFixed(7),
              hash: borrowHash,
            });
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
        toast.success(
          `Deposit${multiplier > 1 ? " + borrow" : ""} successful! Tx: ${txPreview ? txPreview.slice(0, 16) + "…" : ""}`
        );
        resetForm();
        setIsProcessing(false);

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
        toast.error(normalizeDepositCollateralError(errorMessage));
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
      const created = await createMarginAccount(userAddress);

      if (created) {
        await checkUserMarginAccount(userAddress);
        setActiveDialogue("none");
        toast.success("Margin account created successfully.");
      } else {
        const reason = useMarginAccountInfoStore.getState().accountCreationError || "";
        toast.error(normalizeCreateAccountError(reason));
      }
    } catch (error) {
      console.error("Failed to create margin account:", error);
      const msg = error instanceof Error ? error.message : "";
      toast.error(normalizeCreateAccountError(msg));
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
            {/* MB mode: pick which margin-account collaterals to leverage */}
            {isMBMode ? (
              <motion.article
                className={`relative w-full rounded-2xl p-3 sm:p-4 flex flex-col gap-3 transition-colors border ${
                  isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#EEEEEE]"
                }`}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
              >
                {/* Header: Deposit label + WB/MB toggle */}
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-sm font-medium ${isDark ? "text-[#A7A7A7]" : "text-[#777777]"}`}>
                    Select collateral from margin account
                  </span>
                  <div className={`flex items-center rounded-lg p-0.5 ${isDark ? "bg-[#2A2A2A]" : "bg-[#F0F0F0]"}`}>
                    {BALANCE_TYPE_OPTIONS.map((option) => (
                      <motion.button
                        key={option}
                        type="button"
                        onClick={() => {
                          const id = collateralList[0]?.id || generateCollateralId();
                          handleBalanceTypeChange(id, option);
                        }}
                        whileTap={{ scale: 0.95 }}
                        transition={{ duration: 0.1 }}
                        className={`px-2.5 py-1 rounded-md text-[11px] font-semibold cursor-pointer transition-all ${
                          selectedBalanceType === option
                            ? "bg-[#703AE6] text-white shadow-sm"
                            : isDark ? "text-[#777777] hover:text-[#AAAAAA]" : "text-[#888888] hover:text-[#555555]"
                        }`}
                        aria-pressed={selectedBalanceType === option}
                      >
                        {option}
                      </motion.button>
                    ))}
                  </div>
                </div>

                {/* Selection grid (or empty state) */}
                {mbCollateralItems.length > 0 ? (
                  <>
                    <MBSelectionGrid
                      items={mbCollateralItems}
                      selectedIds={mbSelectedIds}
                      mode="Deposit"
                      onToggle={handleMbToggleSelection}
                      onRadioSelect={() => {}}
                    />
                    <div className="flex items-center justify-between pt-1">
                      <span className={`text-[12px] font-medium ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}>
                        {mbSelectedIds.size} of {mbCollateralItems.length} selected
                      </span>
                      <span className={`text-[12px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
                        ≈ ${mbSelectedUsd.toFixed(2)} USD
                      </span>
                    </div>
                  </>
                ) : (
                  <p className={`text-center text-sm py-2 ${isDark ? "text-[#777777]" : "text-[#AAAAAA]"}`}>
                    No collateral in your margin account. Switch to WB to deposit first.
                  </p>
                )}
              </motion.article>
            ) : (
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
                        index={0}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </section>
            )}
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
          <motion.h2
            className={`w-full text-[16px] font-medium ${isDark ? "text-white" : ""}`}
            initial={{ opacity: 0, x: -10 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.3 }}
          >
            Borrow
          </motion.h2>
          <BorrowBox
            mode={mode}
            leverage={leverage}
            setLeverage={setLeverage}
            totalDeposit={effectiveTotalForBorrow}
            onBorrowItemsChange={setBorrowItems}
            onTokenChange={setBorrowToken}
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
            disabled={isProcessing || editingId !== null}
            size="large"
            text={
              isProcessing ? "Processing..." :
              editingId !== null ? "Save Collateral to Continue" :
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
  depositAmount: number;
  projectedBorrowUsd: number;
  isMBMode: boolean;
  leverage: number;
  fees: number;
  totalDeposit: number;
}

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
