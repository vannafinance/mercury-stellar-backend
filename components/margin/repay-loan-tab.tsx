"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect } from "react";
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
import { appendMarginHistory } from "@/lib/margin-history";
import { getAddress } from "@/lib/wallet-adapter";
import { ContractService } from "@/lib/stellar-utils";
import { refreshBorrowedBalances as refreshMarginStoreBorrowedBalances, useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useUserStore } from "@/store/user";
import { ConversionRatio } from "@/components/ui/conversion-ratio";
import { MarginActionPreview, type PreviewRow } from "@/components/margin/margin-action-preview";
import { useMutationToast } from "@/hooks/use-mutation-toast";
import toast from "react-hot-toast";
import { normalizeContractError } from "@/lib/errors/normalize";
import { validateAmountChange, AMOUNT_MAX_DECIMALS } from "@/lib/utils/sanitize-amount";

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
const WAD = BigInt("1000000000000000000");

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
  if (cleaned === "BLND" || cleaned === "AQUA" || cleaned === "WETH" || cleaned === "EURC") return cleaned;
  return null;
};

/**
 * Repay tab for paying down an outstanding margin loan in a chosen asset. Shows
 * the net outstanding debt and the wallet's available balance (both in token
 * units with a live USD line), and a form with quick-% chips and a free-text
 * amount. Repayment runs through a React Query mutation that, before signing,
 * re-reads the on-chain debt and caps the WAD amount at both the real debt and
 * the smart account's spendable balance — the latter avoids Contract #10
 * overspend when accrued interest exceeds the funds the account holds. 100%
 * targets the full on-chain debt; any leftover accrued-interest sliver is
 * surfaced via a toast. State is reset on wallet disconnect, and the preview
 * (before → after debt / HF / liquidation buffer) is rendered by
 * {@link RepayPreviewSection}.
 */
export const RepayLoanTab = ({ prefilledAsset }: RepayLoanTabProps = {}) => {
  const { isDark } = useTheme();
  const normalizeContractTokenSymbol = (symbol: string) =>
    symbol === "BLUSDC" || symbol === "BLEND_USDC" || symbol === "USDC"
      ? "BLUSDC"
      : symbol === "AqUSDC" || symbol === "AquiresUSDC" || symbol === "AQUARIUS_USDC"
        ? "AQUSDC"
        : symbol === "SoUSDC" || symbol === "SoroswapUSDC" || symbol === "SOROSWAP_USDC"
          ? "SOUSDC"
          : symbol;
  // Wallet and margin account state
  const [userAddress, setUserAddress] = useState<string>("");
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
      setUserAddress("");
      setMarginAccount("");
      setRepayStats({ netOutstandingAmountToPay: 0, availableBalance: 0 });
      setRepayInput("");
      setSelectedRepayPercentage(0);
      setCurrentDebtWad('0');
    }
  }, [globalIsConnected, globalAddress]);
  const [currentDebtWad, setCurrentDebtWad] = useState<string>('0');

  // Live USD prices via the on-chain Reflector oracle (XLM/USDC) with
  // BLUSDC/AQUSDC/SOUSDC aliased to USDC inside the oracle module.
  const tokenPrices = useTokenPrices(['XLM', 'USDC', 'BLUSDC', 'AQUSDC', 'SOUSDC', 'BLND', 'AQUA', 'WETH', 'EURC']);
  const selectedTokenPrice =
    tokenPrices[normalizeContractTokenSymbol(selectedRepayCurrency)] ?? 1;
  const repayAmountInUsd = repayAmount * selectedTokenPrice;

  // Current margin account state for computing updated values
  const totalCollateralValue = useMarginAccountInfoStore((s) => s.totalCollateralValue);
  const totalBorrowedValue = useMarginAccountInfoStore((s) => s.totalBorrowedValue);

  // Popup visibility states
  const [isPayNowPopupOpen, setIsPayNowPopupOpen] = useState(false);

  const clampRepayDust = (value: number) => {
    if (!Number.isFinite(value)) return 0;
    return Math.abs(value) < REPAY_DUST_EPSILON ? 0 : value;
  };

  const wadToFixed7 = (wad: bigint) => {
    const whole = wad / WAD;
    const frac = wad % WAD;
    const frac7 = (frac / BigInt("100000000000")).toString().padStart(7, "0");
    return `${whole.toString()}.${frac7}`;
  };

  // Both stat tiles are denominated in tokens of the selected repay currency.
  // Primary line shows the token amount (the actual on-chain debt/balance),
  // secondary line shows the live USD equivalent via the oracle price.
  const formatStatValue = (
    value: number,
    _key: string,
  ): { token: string; usd: string | null } => {
    const cleaned = clampRepayDust(value);
    // Treat as zero if the USD equivalent is below $0.01 (post-repay dust).
    const usdEquiv = selectedTokenPrice > 0 ? cleaned * selectedTokenPrice : 0;
    const display = usdEquiv > 0 && usdEquiv < 0.01 ? 0 : cleaned;
    const token = `${formatTokenAmount(display)} ${selectedRepayCurrency}`;
    const usd = selectedTokenPrice > 0 ? `≈ ${formatUsdValue(display * selectedTokenPrice)}` : null;
    return { token, usd };
  };

  const getSelectedWalletBalance = async (address: string, selectedToken: string): Promise<number> => {
    try {
      const balances = await ContractService.getAllTokenBalances(address);
      const token = normalizeContractTokenSymbol(selectedToken);

      if (token === "BLUSDC") return parseFloat(balances.BLEND_USDC) || 0;
      if (token === "AQUSDC") return parseFloat(balances.AQUARIUS_USDC) || 0;
      if (token === "SOUSDC") return parseFloat(balances.SOROSWAP_USDC) || 0;
      if (token === "BLND") return parseFloat(balances.BLND) || 0;
      if (token === "AQUA") return parseFloat(balances.AQUA) || 0;
      if (token === "WETH") return parseFloat(balances.WETH) || 0;
      if (token === "EURC") return parseFloat(balances.EURC) || 0;

      return parseFloat(balances.XLM) || 0;
    } catch (error) {
      console.error("Error fetching selected wallet balance:", error);
      return 0;
    }
  };

  const refreshSelectedWalletBalance = async (address: string, selectedToken: string) => {
    const walletBalance = await getSelectedWalletBalance(address, selectedToken);
    setRepayStats(prev => ({
      ...prev,
      availableBalance: walletBalance,
    }));
  };

  // Load user data and borrowed balances on mount
  useEffect(() => {
    const loadUserData = async () => {
      try {
        const address = await getAddress();
        if (!address.error && address.address) {
          setUserAddress(address.address);

          // Get margin account
          const account = MarginAccountService.getStoredMarginAccount(address.address);
          if (account && account.isActive) {
            setMarginAccount(account.address);

            // Get borrowed balances
            await refreshSelectedTokenDebt(account.address);

            // Get selected token wallet balance
            await refreshSelectedWalletBalance(address.address, selectedRepayCurrency);
          }
        }
      } catch (error) {
        console.error("Error loading user data:", error);
      }
    };

    loadUserData();
  }, []);

  // Refresh borrowed balances for selected currency
  const refreshSelectedTokenDebt = async (marginAccountAddress: string) => {
    try {
      const debtResult = await MarginAccountService.getBorrowedTokenDebtWad(
        marginAccountAddress,
        normalizeContractTokenSymbol(selectedRepayCurrency)
      );

      if (debtResult.success && debtResult.debtWad) {
        // Show the real residual (even sub-cent dust) — adaptive formatting keeps
        // it readable and the USD line renders "<$0.01" rather than a fake "$0.00".
        const outstanding = clampRepayDust(parseFloat(debtResult.amount || '0') || 0);
        setCurrentDebtWad(debtResult.debtWad);
        setRepayStats(prev => ({
          ...prev,
          netOutstandingAmountToPay: outstanding,
        }));
      } else {
        setCurrentDebtWad('0');
        setRepayStats(prev => ({
          ...prev,
          netOutstandingAmountToPay: 0,
        }));
      }
    } catch (error) {
      console.error("Error refreshing balances:", error);
    }
  };

  // Refresh when currency changes
  useEffect(() => {
    if (marginAccount) {
      refreshSelectedTokenDebt(marginAccount);
    }
  }, [selectedRepayCurrency, marginAccount]);

  useEffect(() => {
    if (userAddress) {
      refreshSelectedWalletBalance(userAddress, selectedRepayCurrency);
    }
  }, [selectedRepayCurrency, userAddress]);

  // Handler for percentage click
  const handlePercentageClick = (item: number) => {
    setSelectedRepayPercentage(item);

    if (item === 100 && currentDebtWad && currentDebtWad !== '0') {
      const fullAmount = parseFloat(currentDebtWad) / 1e18;
      const safeFullAmount = Number.isFinite(fullAmount) ? fullAmount : 0;
      // Sub-cent accrued-interest residue (e.g. 0.0000024 BLUSDC left after an
      // earlier repay capped to the account's spendable balance) is dust the
      // user can't meaningfully act on — same $0.01 threshold the "Net
      // Outstanding Amount to Repay" stat tile already uses to show "0", so
      // 100% doesn't fill in a confusing non-zero amount the stat disagrees with.
      const usdEquiv = selectedTokenPrice > 0 ? safeFullAmount * selectedTokenPrice : safeFullAmount;
      const clamped = usdEquiv < 0.01 ? 0 : clampRepayDust(safeFullAmount);
      setRepayInput(amountToInputString(clamped));
      return;
    }

    // Calculate amount based on percentage — keep 7dp so sub-cent debt survives.
    const calculatedAmount = clampRepayDust((repayStats.netOutstandingAmountToPay * item) / 100);
    setRepayInput(amountToInputString(calculatedAmount));
  };

  // Handler for input change
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const sanitized = validateAmountChange(e.target.value);
    if (sanitized === null) return; // invalid char — toast already shown
    // Keep the raw string; `repayAmount` is derived. This is what lets a partial
    // "937." or "0.0000001" be typed without becoming NaN or being truncated.
    setRepayInput(sanitized);
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

      const latestDebt = await MarginAccountService.getBorrowedTokenDebtWad(
        marginAccount,
        normalizeContractTokenSymbol(selectedRepayCurrency)
      );

      const inputRepayWad = BigInt(Math.floor(repayAmount * 1_000_000)) * BigInt(1_000_000_000_000);
      const debtWad = latestDebt.success && latestDebt.debtWad
        ? BigInt(latestDebt.debtWad)
        : (currentDebtWad && currentDebtWad !== '0' ? BigInt(currentDebtWad) : BigInt(0));
      // "Repay Max" (100%) targets the full on-chain debt; otherwise cap the input
      // at the debt.
      let finalRepayWad = selectedRepayPercentage === 100 && debtWad > BigInt(0)
        ? debtWad
        : debtWad > BigInt(0)
          ? (inputRepayWad > debtWad ? debtWad : inputRepayWad)
          : inputRepayWad;

      // Repay pulls FROM the smart account, which holds the borrowed funds but NOT
      // the accrued-interest portion of the debt. Repaying the raw debt overspends
      // → Error(Contract,#10) "balance is not sufficient to spend". Cap at the
      // account's actual token balance so the tx can't overspend.
      const spendable = await MarginAccountService.getMarginAccountTokenBalanceWad(
        marginAccount,
        normalizeContractTokenSymbol(selectedRepayCurrency),
      );
      let cappedToBalance = false;
      if (spendable != null) {
        const spendableWad = BigInt(spendable);
        if (finalRepayWad > spendableWad) {
          finalRepayWad = spendableWad;
          cappedToBalance = true;
        }
      }

      if (finalRepayWad <= BigInt(0)) {
        throw new Error('Nothing to repay for this token');
      }

      const result = await MarginAccountService.repayLoan(
        marginAccount,
        normalizeContractTokenSymbol(selectedRepayCurrency),
        finalRepayWad.toString()
      );

      if (!result.success) {
        throw new Error(result.error || 'Loan repayment failed');
      }

      return { hash: result.hash, finalRepayWad, cappedToBalance };
    },
    onSuccess: async ({ hash, finalRepayWad, cappedToBalance }) => {
      if (hash) {
        appendMarginHistory({
          marginAccountAddress: marginAccount,
          type: "repay",
          asset: normalizeContractTokenSymbol(selectedRepayCurrency),
          amount: wadToFixed7(finalRepayWad),
          hash,
        });
      }
      if (cappedToBalance) {
        // Repaid everything the account held; the accrued-interest sliver remains.
        toast(`Repaid the max your account holds. A small accrued-interest amount remains — deposit a little more ${selectedRepayCurrency} to fully clear it.`);
      }
      // Reset form and trigger RQ refresh first so the UI reflects the new
      // state immediately. The imperative Zustand-store refresh calls below
      // can transiently throw when Freighter's getAddress returns undefined
      // right after a signed tx popup closes (strkey decode of an undefined
      // address). Swallowing the error here keeps the mutation in its success
      // state — the ledger tick will reconcile the store on the next close.
      setRepayInput("");
      qc.invalidateQueries({ queryKey: ['margin'] });

      try {
        await refreshSelectedTokenDebt(marginAccount);
        await refreshMarginStoreBorrowedBalances(marginAccount, true);
        await refreshSelectedWalletBalance(userAddress, selectedRepayCurrency);
      } catch (error) {
        console.warn("Post-repay balance refresh failed; ledger tick will reconcile.", error);
      }
    },
    onSettled: () => {
      setIsPayNowPopupOpen(false);
    },
  });

  useMutationToast(repayMutation, {
    success: (d) => `Loan repayment successful! Tx: ${d.hash ? d.hash.slice(0, 16) + '…' : ''}`,
    error: (e) => normalizeContractError(e.message),
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
                className={`text-[12px] font-medium ${
                  isDark ? "text-[#777777]" : "text-[#A7A7A7]"
                }`}
              >
                {key === "netOutstandingAmountToPay"
                  ? "Net Outstanding Amount to Repay"
                  : "Available Balance"}
              </span>
              {(() => {
                const { token, usd } = formatStatValue(value, key);
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
                setSelectedOption={setSelectedRepayCurrency}
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
