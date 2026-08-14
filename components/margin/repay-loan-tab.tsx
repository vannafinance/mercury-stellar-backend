"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useMemo, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DropdownOptions } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { DEPOSIT_PERCENTAGES, PERCENTAGE_COLORS } from "@/lib/constants/margin";
import { formatTokenAmount, formatUsdValue } from "@/lib/utils/format-amount";
import { Dropdown } from "../ui/dropdown";
import { Popup } from "@/components/ui/popup";
import { useTheme } from "@/contexts/theme-context";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { MarginAccountService } from "@/lib/margin-utils";
import { getAddress } from "@/lib/wallet-adapter";
import { refreshBorrowedBalances as refreshMarginStoreBorrowedBalances, useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useUserStore } from "@/store/user";
import { ConversionRatio } from "@/components/ui/conversion-ratio";
import { MarginActionPreview, type PreviewRow } from "@/components/margin/margin-action-preview";
import { useMutationToast } from "@/hooks/use-mutation-toast";
import { normalizeRepayError } from "@/lib/errors/normalize";
import { decimalAmountToWad, validateAmountChange, AMOUNT_MAX_DECIMALS } from "@/lib/utils/sanitize-amount";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { useMarginHistory } from "@/hooks/use-margin";
import {
  buildNetBorrowCashByToken,
  calculateAccruedBorrowInterest,
  canonicalMarginPositionToken,
} from "@/lib/margin-position-attribution";

/** Format a numeric amount for the editable input: clean string, no trailing
 *  zeros, capped at Stellar's 7-decimal precision; empty for non-positive. */
const amountToInputString = (n: number): string =>
  Number.isFinite(n) && n > 0 ? String(parseFloat(n.toFixed(AMOUNT_MAX_DECIMALS))) : "";

const LIQUIDATION_THRESHOLD = 1.1;
const HF_INF_SENTINEL = 999;
const formatHF = (hf: number): string =>
  !Number.isFinite(hf) || hf >= HF_INF_SENTINEL ? "∞" : hf.toFixed(2);
// Delegate to the shared adaptive formatter so sub-cent values show "<$0.01"
// instead of a misleading "$0.00" — consistent with the rest of the UI.
const formatUsd = (n: number): string => formatUsdValue(n);

const REPAY_DUST_EPSILON = 1e-6;
const formatDetailedTokenAmount = (value: number): string =>
  Number.isFinite(value)
    ? value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 7 })
    : "0";

interface RepayLoanTabProps {
  /** Asset to preselect on mount / when changed (e.g. from a positions-row Repay click). */
  prefilledAsset?: string;
}

const toDropdownAsset = (raw: string | undefined): string | null => {
  if (!raw) return null;
  const cleaned = raw.replace(/^0x/i, "").toUpperCase();
  if (cleaned === "XLM") return "XLM";
  if (cleaned === "USDC" || cleaned === "BLUSDC" || cleaned === "BLEND_USDC") return "BLUSDC";
  if (cleaned === "AQUSDC" || cleaned === "AQUIRESUSDC" || cleaned === "AQUARIUS_USDC") return "AqUSDC";
  if (cleaned === "SOUSDC" || cleaned === "SOROSWAPUSDC" || cleaned === "SOROSWAP_USDC") return "SoUSDC";
  return null;
};

const normalizeContractTokenSymbol = (symbol: string): string =>
  symbol === "BLUSDC" || symbol === "BLEND_USDC" || symbol === "USDC"
    ? "BLUSDC"
    : symbol === "AqUSDC" || symbol === "AquiresUSDC" || symbol === "AQUARIUS_USDC"
      ? "AQUSDC"
      : symbol === "SoUSDC" || symbol === "SoroswapUSDC" || symbol === "SOROSWAP_USDC"
        ? "SOUSDC"
        : symbol;

const clampRepayDust = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.abs(value) < REPAY_DUST_EPSILON ? 0 : value;
};

/**
 * Repay tab for paying down an outstanding margin loan in a chosen asset. Shows
 * the true on-chain debt ("Net Outstanding Amount to Repay") and the margin
 * account's own balance of that asset ("Available Balance") side by side, both
 * in token units with a live USD line, plus a form with quick-% chips and a
 * free-text amount. 100% always requests the FULL debt — never capped to the
 * margin account's balance — and {@link MarginAccountService.repayLoan} pulls
 * only from the margin account (no wallet top-up): if the balance can't cover
 * it, the transfer itself rejects the request and that surfaces as a clean
 * insufficient-balance message (see {@link normalizeRepayError}) rather than a
 * silent partial repay. The mutation re-reads the debt fresh right before
 * signing. State is reset on wallet disconnect, and the preview (before →
 * after debt / HF / liquidation buffer) is rendered by
 * {@link RepayPreviewSection}.
 */
export const RepayLoanTab = ({ prefilledAsset }: RepayLoanTabProps = {}) => {
  const { isDark } = useTheme();
  // Wallet and margin account state
  const [marginAccount, setMarginAccount] = useState<string>("");
  const qc = useQueryClient();
  
  // Repay form state
  // Repay loan statistics
  const [repayStats, setRepayStats] = useState({
    netOutstandingAmountToPay: 0,
    availableBalance: 0,
  });
  const [selectedRepayCurrency, setSelectedRepayCurrency] =
    useState<string>(() => toDropdownAsset(prefilledAsset) ?? DropdownOptions[0]);
  const [selectedRepayPercentage, setSelectedRepayPercentage] =
    useState<number>(0);
  // The amount field is held as a RAW STRING while editing — converting to a
  // Number on each keystroke turned a partial "." into NaN and dropped trailing
  // decimals (so 937.3325 couldn't be edited). `repayAmount` is derived for all
  // numeric uses; the input shows `repayInput` verbatim.
  const [repayInput, setRepayInput] = useState<string>("");
  const repayAmount = parseFloat(repayInput) || 0;

  // Sync currency when caller asks to prefill (e.g. row-level Repay click)
  useEffect(() => {
    const mapped = toDropdownAsset(prefilledAsset);
    if (mapped) {
      setSelectedRepayCurrency(mapped);
      setRepayInput("");
      setSelectedRepayPercentage(0);
    }
  }, [prefilledAsset]);

  // Reset local state on wallet disconnect — without this, the previous
  // user's outstanding-debt and available-balance numbers stay rendered
  // even though the global wallet store has been cleared.
  const globalIsConnected = useUserStore((state) => state.isConnected);
  const globalAddress = useUserStore((state) => state.address);
  useEffect(() => {
    if (!globalIsConnected || !globalAddress) {
      setMarginAccount("");
      setRepayStats({ netOutstandingAmountToPay: 0, availableBalance: 0 });
      setRepayInput("");
      setSelectedRepayPercentage(0);
      setCurrentDebtWad('0');
    }
  }, [globalIsConnected, globalAddress]);
  const [currentDebtWad, setCurrentDebtWad] = useState<string>('0');
  // Margin account's OWN balance of the selected repay currency, in WAD —
  // purely informational (the "Available Balance" tile, so the user can see
  // upfront whether they have enough before hitting Pay Now). Repay always
  // requests the full debt regardless of this — no wallet top-up, no
  // client-side capping — so a shortfall surfaces as a clean on-chain
  // "insufficient balance" error instead of a silent partial repay.
  // Live USD prices via the on-chain Reflector oracle (XLM/USDC) with
  // BLUSDC/AQUSDC/SOUSDC aliased to USDC inside the oracle module.
  const tokenPrices = useTokenPrices(['XLM', 'USDC', 'BLUSDC', 'AQUSDC', 'SOUSDC']);
  const selectedTokenPrice =
    tokenPrices[normalizeContractTokenSymbol(selectedRepayCurrency)] ?? 1;
  const repayAmountInUsd = repayAmount * selectedTokenPrice;
  const { history: marginHistory, isLoading: marginHistoryLoading } = useMarginHistory();
  const selectedAccruedInterest = useMemo(() => {
    if (marginHistoryLoading) return null;
    const netBorrowCash = buildNetBorrowCashByToken(marginHistory);
    const token = canonicalMarginPositionToken(selectedRepayCurrency);
    return calculateAccruedBorrowInterest(
      repayStats.netOutstandingAmountToPay,
      netBorrowCash.get(token),
    );
  }, [marginHistory, marginHistoryLoading, repayStats.netOutstandingAmountToPay, selectedRepayCurrency]);

  // Popup visibility states
  const [isPayNowPopupOpen, setIsPayNowPopupOpen] = useState(false);

  // Both stat tiles are denominated in tokens of the selected repay currency.
  // Primary line shows the token amount (the actual on-chain debt/balance),
  // secondary line shows the live USD equivalent via the oracle price.
  const formatStatValue = (value: number): { token: string; usd: string | null } => {
    const cleaned = clampRepayDust(value);
    // Treat as zero if the USD equivalent is below $0.01 (post-repay dust).
    const usdEquiv = selectedTokenPrice > 0 ? cleaned * selectedTokenPrice : 0;
    const display = usdEquiv > 0 && usdEquiv < 0.01 ? 0 : cleaned;
    const token = `${formatTokenAmount(display)} ${selectedRepayCurrency}`;
    const usd = selectedTokenPrice > 0 ? `≈ ${formatUsdValue(display * selectedTokenPrice)}` : null;
    return { token, usd };
  };

  // Debt and margin-account balance for the CURRENT `selectedRepayCurrency`,
  // fetched together so "Net Outstanding Amount to Repay" never mixes a fresh
  // debt read with a stale balance from whatever currency was selected a
  // moment ago. "Net Outstanding Amount to Repay" is always the TRUE full
  // debt — never capped to what the margin account can actually cover — so
  // 100% always requests the real amount owed; "Available Balance" (margin
  // account balance) is shown alongside purely so the user can see upfront
  // whether they have enough. If they don't, repay fails on-chain with a
  // clean insufficient-balance message (see normalizeRepayError) instead of
  // silently repaying a smaller amount — same as any other DEX.
  const refreshRepayableStats = useCallback(async (marginAccountAddress: string) => {
    try {
      const normalizedSymbol = normalizeContractTokenSymbol(selectedRepayCurrency);
      const [debtResult, marginBalWad] = await Promise.all([
        MarginAccountService.getBorrowedTokenDebtWad(marginAccountAddress, normalizedSymbol),
        MarginAccountService.getMarginAccountTokenBalanceWad(marginAccountAddress, normalizedSymbol),
      ]);

      const trueDebtTokens = debtResult.success && debtResult.debtWad
        ? clampRepayDust(parseFloat(debtResult.amount || '0') || 0)
        : 0;
      setCurrentDebtWad(debtResult.success && debtResult.debtWad ? debtResult.debtWad : '0');
      setRepayStats({
        netOutstandingAmountToPay: trueDebtTokens,
        availableBalance: marginBalWad != null ? clampRepayDust(parseFloat(marginBalWad) / 1e18) : 0,
      });
    } catch (error) {
      console.error("Error refreshing repayable stats:", error);
    }
  }, [selectedRepayCurrency]);

  // Load user data and borrowed balances on mount
  useEffect(() => {
    const loadUserData = async () => {
      try {
        const address = await getAddress();
        if (!address.error && address.address) {
          // Get margin account
          const account = MarginAccountService.getStoredMarginAccount(address.address);
          if (account && account.isActive) {
            setMarginAccount(account.address);
          }
        }
      } catch (error) {
        console.error("Error loading user data:", error);
      }
    };

    loadUserData();
  }, []);

  // Refresh when currency changes
  useEffect(() => {
    if (marginAccount) {
      refreshRepayableStats(marginAccount);
    }
  }, [marginAccount, refreshRepayableStats]);

  // Handler for percentage click. All percentages — including 100% — are
  // fractions of `repayStats.netOutstandingAmountToPay`, the TRUE full debt
  // (see {@link refreshRepayableStats}) — never capped to margin-account
  // balance, so 100% always requests exactly what's owed.
  const handlePercentageClick = (item: number) => {
    setSelectedRepayPercentage(item);

    // Below-a-cent dust is zeroed — same $0.01 threshold the "Net Outstanding
    // Amount to Repay" stat tile uses — so 100% doesn't fill in a confusing
    // non-zero amount the stat disagrees with.
    const rawAmount = (repayStats.netOutstandingAmountToPay * item) / 100;
    const usdEquiv = selectedTokenPrice > 0 ? rawAmount * selectedTokenPrice : rawAmount;
    const calculatedAmount = usdEquiv < 0.01 ? 0 : clampRepayDust(rawAmount);
    setRepayInput(amountToInputString(calculatedAmount));
  };

  // Handler for input change
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const sanitized = validateAmountChange(e.target.value);
    if (sanitized === null) return; // invalid char — toast already shown
    // A percentage chip is only a shortcut for filling the field. Once the
    // user edits that value, the typed amount becomes authoritative; leaving
    // 100 selected made submit silently replace the manual value with the
    // entire latest debt.
    setSelectedRepayPercentage(0);
    // Keep the raw string; `repayAmount` is derived. This is what lets a partial
    // "937." or "0.0000001" be typed without becoming NaN or being truncated.
    setRepayInput(sanitized);
  };

  const handleCurrencyChange = (currency: string) => {
    setSelectedRepayCurrency(currency);
    setRepayInput("");
    setSelectedRepayPercentage(0);
  };

  const repayMutation = useMutation({
    // No optimistic write. Optimistically reducing the debt on onMutate made a
    // cancelled/failed tx look like the token was repaid — and a full repay
    // dropped it below the positions-table dust filter, removing the row before
    // anything confirmed. The position must reflect ONLY confirmed on-chain state:
    // onSuccess refreshes from chain, and a cancel now leaves the UI untouched.
    mutationFn: async () => {
      if (!marginAccount || repayAmount <= 0) {
        throw new Error('Please enter a valid repay amount');
      }

      try {
        const latestDebt = await MarginAccountService.getBorrowedTokenDebtWad(
          marginAccount,
          normalizeContractTokenSymbol(selectedRepayCurrency)
        );

        const inputRepayWad = decimalAmountToWad(repayInput);
        const debtWad = latestDebt.success && latestDebt.debtWad
          ? BigInt(latestDebt.debtWad)
          : (currentDebtWad && currentDebtWad !== '0' ? BigInt(currentDebtWad) : BigInt(0));
        // "Repay Max" (100%) always targets the FULL on-chain debt — never
        // capped to the margin account's balance. Repay pulls only from the
        // margin account (no wallet top-up), so if the account can't cover
        // it, the token transfer itself rejects the request and that's
        // surfaced as a clean insufficient-balance error (normalizeRepayError)
        // — never a silent partial repay for less than what was requested.
        // Non-100% typed amounts are still capped at the debt (never overpay).
        const finalRepayWad = selectedRepayPercentage === 100 && debtWad > BigInt(0)
          ? debtWad
          : debtWad > BigInt(0)
            ? (inputRepayWad > debtWad ? debtWad : inputRepayWad)
            : inputRepayWad;

        if (finalRepayWad <= BigInt(0)) {
          throw new Error('Nothing to repay for this token');
        }

        const result = await MarginAccountService.repayLoan(
          marginAccount,
          normalizeContractTokenSymbol(selectedRepayCurrency),
          finalRepayWad.toString()
        );

        if (!result.success) {
          // A visible, hard-to-miss console entry regardless of the DevTools
          // level/context filter — margin-utils.ts already logs its own
          // failure detail deeper in the call chain, but that log has been
          // reported as not showing up (likely filtered/hidden by DevTools),
          // so this is a second, closer-to-the-surface copy of the SAME info,
          // logged as the raw object (not stringified) so every property is
          // inspectable even if some field doesn't serialize cleanly.
          console.error('🔴 REPAY FAILED — raw result:', result);
          throw new Error(result.error || 'Loan repayment failed (no further detail returned — see "🔴 REPAY FAILED" above in console)');
        }

        const repaidWad = result.repaidAmountWad ? BigInt(result.repaidAmountWad) : finalRepayWad;
        return { hash: result.hash, repaidWad };
      } catch (error: unknown) {
        // Belt-and-suspenders: catches anything that escapes repayLoan's own
        // try/catch (e.g. a rejected promise from getBorrowedTokenDebtWad/
        // getMarginAccountTokenBalanceWad above, or Freighter itself
        // throwing a non-Error value with no usable .message) and logs it
        // as the raw object — un-stringified, so every property is
        // inspectable even if some field doesn't serialize cleanly — before
        // rethrowing with a message guaranteed to be non-empty, so the toast
        // is never a bare, contentless fallback.
        console.error('🔴 REPAY THREW — raw error:', error);
        const detail =
          error instanceof Error && error.message
            ? error.message
            : (() => {
                try {
                  return JSON.stringify(error);
                } catch {
                  return String(error);
                }
              })();
        throw new Error(detail || 'Repay threw with no message — see "🔴 REPAY THREW" in console.');
      }
    },
    onSuccess: async () => {
      // Reset form and trigger RQ refresh first so the UI reflects the new
      // state immediately. The imperative Zustand-store refresh calls below
      // can transiently throw when Freighter's getAddress returns undefined
      // right after a signed tx popup closes (strkey decode of an undefined
      // address). Swallowing the error here keeps the mutation in its success
      // state — the ledger tick will reconcile the store on the next close.
      setRepayInput("");
      setSelectedRepayPercentage(0);
      qc.invalidateQueries({ queryKey: ['margin'] });

      try {
        await refreshRepayableStats(marginAccount);
        await refreshMarginStoreBorrowedBalances(marginAccount, true);
      } catch (error) {
        console.warn("Post-repay balance refresh failed; ledger tick will reconcile.", error);
      }
    },
    onSettled: () => {
      setIsPayNowPopupOpen(false);
    },
  });

  useMutationToast(repayMutation, {
    loading: `Repaying ${formatTokenAmount(repayAmount)} ${selectedRepayCurrency}`,
    success: () => `Loan repayment successful!`,
    error: (e) => normalizeRepayError(e.message, selectedRepayCurrency),
  });

  // Handler for pay now click
  const handlePayNowClick = () => {
    repayMutation.mutate();
  };

  // Handler for closing pay now popup
  const handleClosePayNowPopup = () => {
    setIsPayNowPopupOpen(false);
  };

  // Check if buttons should be disabled (when input is 0 or empty)
  const isInputEmpty = repayAmount === 0 || repayAmount === null || repayAmount === undefined;

  return (
    <motion.section
      className="w-full flex flex-col gap-6 pt-8"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4, delay: 0.1 }}
    >
      <motion.section
        className="flex flex-col gap-[43px] h-full"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, delay: 0.2 }}
      >
        {/* Repay stats cards */}
        <motion.section
          className="grid grid-cols-1 sm:grid-cols-2 gap-3"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.2 }}
        >
          {Object.entries(repayStats).map(([key, value], index) => (
            <motion.article
              key={key}
              className={`w-full flex flex-col gap-2 rounded-2xl border p-3 sm:p-4 ${
                isDark
                  ? "bg-[#1A1A1A] border-[#2A2A2A]"
                  : "bg-white border-[#EEEEEE]"
              }`}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.1 + index * 0.1 }}
            >
              <span
                className={`flex items-center gap-1 text-[12px] font-medium ${
                  isDark ? "text-[#777777]" : "text-[#A7A7A7]"
                }`}
              >
                {key === "netOutstandingAmountToPay" ? (
                  <>
                    Net Outstanding Amount to Repay
                    <InfoTooltip
                      placement="bottom"
                      size="regular"
                      label={`${selectedRepayCurrency} outstanding loan and accrued interest details`}
                      content={(
                        <span className="flex flex-col gap-1">
                          {selectedAccruedInterest !== null ? (
                            <>
                              <span>
                                Net borrowed amount: {formatDetailedTokenAmount(Math.max(0, repayStats.netOutstandingAmountToPay - selectedAccruedInterest))} {selectedRepayCurrency}
                              </span>
                              <span>
                                Interest accrued till date: {formatDetailedTokenAmount(selectedAccruedInterest)} {selectedRepayCurrency} (≈ {formatUsdValue(selectedAccruedInterest * selectedTokenPrice)})
                              </span>
                              <span>
                                Total outstanding loan: {formatDetailedTokenAmount(repayStats.netOutstandingAmountToPay)} {selectedRepayCurrency}
                              </span>
                            </>
                          ) : (
                            <>
                              <span>
                                Total outstanding loan: {formatDetailedTokenAmount(repayStats.netOutstandingAmountToPay)} {selectedRepayCurrency}
                              </span>
                              <span>Principal and interest breakdown is unavailable until the original on-chain borrow is indexed.</span>
                            </>
                          )}
                        </span>
                      )}
                    />
                  </>
                ) : (
                  <>
                    Available Balance in Margin Account
                    <InfoTooltip
                      placement="bottom"
                      label="Available margin account balance information"
                      content="Selected asset available in your margin account."
                    />
                  </>
                )}
              </span>
              {(() => {
                const { token, usd } = formatStatValue(value);
                return (
                  <>
                    <span
                      className={`text-[22px] font-bold leading-tight ${
                        isDark ? "text-white" : "text-[#111111]"
                      }`}
                    >
                      {token}
                    </span>
                    {usd && (
                      <span
                        className={`text-[12px] font-medium ${
                          isDark ? "text-[#777777]" : "text-[#A7A7A7]"
                        }`}
                      >
                        {usd}
                      </span>
                    )}
                  </>
                );
              })()}
            </motion.article>
          ))}
        </motion.section>

        {/* Repay form */}
        <motion.article
          className={`w-full rounded-2xl border p-3 sm:p-4 flex flex-col gap-2 ${
            isDark
              ? "bg-[#1A1A1A] border-[#2A2A2A]"
              : "bg-white border-[#EEEEEE]"
          }`}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.3 }}
        >
          {/* Row 1: "Repay" label + % chips */}
          <div className="flex items-center justify-between">
            <span
              className={`text-sm font-medium ${
                isDark ? "text-[#A7A7A7]" : "text-[#777777]"
              }`}
            >
              Repay
            </span>
            <motion.div
              className="flex items-center gap-1 sm:gap-1.5"
              role="group"
              aria-label="Repay percentage"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, delay: 0.4 }}
            >
              {DEPOSIT_PERCENTAGES.map((item: number) => (
                <motion.button
                  type="button"
                  key={item}
                  onClick={() => handlePercentageClick(item)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold cursor-pointer border transition-all ${
                    selectedRepayPercentage === item
                      ? `${PERCENTAGE_COLORS[item]} text-white border-transparent`
                      : isDark
                        ? "bg-[#2A2A2A] text-[#A7A7A7] border-[#333333] hover:text-white"
                        : "bg-[#F0F0F0] text-[#888888] hover:text-[#555555] border-[#E2E2E2]"
                  }`}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.93 }}
                  transition={{ duration: 0.1 }}
                  aria-label={`Repay ${item} percent`}
                  aria-pressed={selectedRepayPercentage === item}
                >
                  {item}%
                </motion.button>
              ))}
            </motion.div>
          </div>

          {/* Row 2: token dropdown + amount input */}
          <div className="flex items-center justify-between gap-3">
            <div className="shrink-0">
              <Dropdown
                classname={`gap-2 px-3 py-2 rounded-full text-[14px] font-semibold transition-colors ${
                  isDark
                    ? "bg-[#333333] hover:bg-[#3D3D3D] text-white"
                    : "bg-[#EEEEEE] hover:bg-[#E2E2E2]"
                }`}
                items={DropdownOptions}
                selectedOption={selectedRepayCurrency}
                setSelectedOption={handleCurrencyChange}
                dropdownClassname="text-[13px] gap-2"
              />
            </div>
            <div className="flex-1 min-w-0">
              <label htmlFor="repay-amount-input" className="sr-only">
                Repay amount
              </label>
              <input
                id="repay-amount-input"
                onChange={handleInputChange}
                className={`w-full text-right text-[22px] sm:text-[28px] font-semibold bg-transparent outline-none placeholder:opacity-20 ${
                  isDark
                    ? "text-white placeholder:text-white"
                    : "text-[#111111] placeholder:text-[#111111]"
                }`}
                type="text"
                inputMode="decimal"
                placeholder="0"
                value={repayInput}
              />
            </div>
          </div>

          {/* Row 3: live conversion ratio (click to swap) + USD value */}
          <div className="flex items-center justify-between">
            <ConversionRatio
              tokenSymbol={selectedRepayCurrency}
              tokenPrice={selectedTokenPrice}
              variant="inline"
            />
            <span
              className={`text-sm font-medium ${
                isDark ? "text-[#777777]" : "text-[#A7A7A7]"
              }`}
              aria-live="polite"
            >
              ≈ {formatUsdValue(repayAmountInUsd)}
            </span>
          </div>

        </motion.article>

        {/* Repay preview — before → after values (same style as Leverage/Transfer tabs) */}
        <RepayPreviewSection
          repayAmount={repayAmount}
          selectedTokenPrice={selectedTokenPrice}
        />

        {/* Action buttons */}
        <motion.section
          className="flex flex-col gap-[16px]"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.4 }}
        >
          {/* Pay Now button */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{
              type: "spring",
              stiffness: 300,
              damping: 25,
              delay: 0.5,
            }}
            whileHover={isInputEmpty ? {} : { scale: 1.02 }}
            whileTap={isInputEmpty ? {} : { scale: 0.98 }}
          >
            <Button
              text={repayMutation.isPending ? "Processing..." : "Pay Now"}
              size="large"
              type="gradient"
              onClick={handlePayNowClick}
              disabled={isInputEmpty || repayMutation.isPending || !marginAccount}
            />
          </motion.div>
        </motion.section>
      </motion.section>

      {/* Pay Now popup */}
      <AnimatePresence>
        {isPayNowPopupOpen && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#45454566]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            onClick={handleClosePayNowPopup}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ duration: 0.3 }}
              onClick={(e) => e.stopPropagation()}
            >
              <Popup
                icon="/assets/exclamation.png"
                description={`Are you sure you want to repay ${formatTokenAmount(Number(repayAmount) || 0)} ${selectedRepayCurrency}? This will reduce your borrowed amount.`}
                buttonText={repayMutation.isPending ? "Processing..." : "Confirm Repayment"}
                buttonOnClick={handlePayNowClick}
                closeButtonText="Cancel"
                closeButtonOnClick={handleClosePayNowPopup}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </motion.section>
  );
};

interface RepayPreviewSectionProps {
  /** Repay amount in token units (converted to USD via `selectedTokenPrice`). */
  repayAmount: number;
  /** Live oracle price of the selected repay token. */
  selectedTokenPrice: number;
}

/**
 * Computes the after-state of a repay action and renders the before → after
 * preview. Reads margin totals from the store so it stays in sync with the
 * canonical risk-engine values used everywhere else.
 *
 * Repay math:
 *   gross_before = avgHealthFactor × debt   (back-calculated from real on-chain HF)
 *   After repay (debt drops; gross may also drop for non-deployed cash accounts):
 *   gross_after  = gross_before - repayUsd  (conservative estimate)
 *   debt_after   = debt - repayUsd
 *   HF_after     = gross_after / debt_after
 */
const RepayPreviewSection = ({
  repayAmount,
  selectedTokenPrice,
}: RepayPreviewSectionProps) => {
  const totalCollateralValue = useMarginAccountInfoStore((s) => s.totalCollateralValue);
  const totalBorrowedValue = useMarginAccountInfoStore((s) => s.totalBorrowedValue);
  const avgHealthFactor = useMarginAccountInfoStore((s) => s.avgHealthFactor);

  const repayUsd = Math.max(0, repayAmount * selectedTokenPrice);
  if (repayUsd <= 0 || totalBorrowedValue <= 0) return null;

  // Use the store's real HF to back-calculate gross, rather than the naive
  // collateral + debt formula which overcounts for accounts with deployed
  // assets (aTokens, LP tokens, tracking tokens).
  const gross = avgHealthFactor > 0
    ? avgHealthFactor * totalBorrowedValue
    : totalCollateralValue + totalBorrowedValue;
  const hfBefore = avgHealthFactor > 0 ? avgHealthFactor : HF_INF_SENTINEL;
  const bufferBefore = Math.max(0, gross - totalBorrowedValue * LIQUIDATION_THRESHOLD);

  const cappedRepay = Math.min(repayUsd, totalBorrowedValue);
  const debtAfter = Math.max(0, totalBorrowedValue - cappedRepay);
  const grossAfter = Math.max(0, gross - cappedRepay);
  const hfAfter = debtAfter > 0 ? grossAfter / debtAfter : HF_INF_SENTINEL;
  const bufferAfter = Math.max(0, grossAfter - debtAfter * LIQUIDATION_THRESHOLD);

  const rows: PreviewRow[] = [
    {
      label: "Outstanding Debt",
      before: formatUsd(totalBorrowedValue),
      after: formatUsd(debtAfter),
      tone: "positive",
    },
    {
      label: "Health Factor",
      before: formatHF(hfBefore),
      after: formatHF(hfAfter),
      tone: "positive",
    },
    {
      label: "Liquidation Buffer",
      before: formatUsd(bufferBefore),
      after: formatUsd(bufferAfter),
      tone: bufferAfter >= bufferBefore ? "positive" : "negative",
    },
  ];

  return <MarginActionPreview rows={rows} />;
};
