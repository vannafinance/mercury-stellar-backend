"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DropdownOptions } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { DEPOSIT_PERCENTAGES, PERCENTAGE_COLORS } from "@/lib/constants/margin";
import { Dropdown } from "../ui/dropdown";
import { Popup } from "@/components/ui/popup";
import { useTheme } from "@/contexts/theme-context";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { MarginAccountService } from "@/lib/margin-utils";
import { appendMarginHistory } from "@/lib/margin-history";
import { getAddress } from "@stellar/freighter-api";
import { ContractService } from "@/lib/stellar-utils";
import { refreshBorrowedBalances as refreshMarginStoreBorrowedBalances, useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useUserStore } from "@/store/user";
import { ConversionRatio } from "@/components/ui/conversion-ratio";
import { MarginActionPreview, type PreviewRow } from "@/components/margin/margin-action-preview";
import toast from "react-hot-toast";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";

const LIQUIDATION_THRESHOLD = 1.1;
const HF_INF_SENTINEL = 999;
const formatHF = (hf: number): string =>
  !Number.isFinite(hf) || hf >= HF_INF_SENTINEL ? "∞" : hf.toFixed(2);
const formatUsd = (n: number): string =>
  `$${(n < 0 ? 0 : n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const REPAY_DUST_EPSILON = 1e-6;
const WAD = BigInt("1000000000000000000");

interface RepayLoanTabProps {
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
  const [repayAmount, setRepayAmount] = useState<number>(0);

  // Sync currency when caller asks to prefill (e.g. row-level Repay click)
  useEffect(() => {
    const mapped = toDropdownAsset(prefilledAsset);
    if (mapped) {
      setSelectedRepayCurrency(mapped);
      setRepayAmount(0);
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
      setRepayAmount(0);
      setSelectedRepayPercentage(0);
      setCurrentDebtWad('0');
    }
  }, [globalIsConnected, globalAddress]);
  const [currentDebtWad, setCurrentDebtWad] = useState<string>('0');

  // Live USD prices via the on-chain Reflector oracle (XLM/USDC) with
  // BLUSDC/AQUSDC/SOUSDC aliased to USDC inside the oracle module.
  const tokenPrices = useTokenPrices(['XLM', 'USDC', 'BLUSDC', 'AQUSDC', 'SOUSDC']);
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
    const token = `${cleaned.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })} ${selectedRepayCurrency}`;
    const usd =
      selectedTokenPrice > 0
        ? `≈ $${(cleaned * selectedTokenPrice).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}`
        : null;
    return { token, usd };
  };

  const getSelectedWalletBalance = async (address: string, selectedToken: string): Promise<number> => {
    try {
      const balances = await ContractService.getAllTokenBalances(address);
      const token = normalizeContractTokenSymbol(selectedToken);

      if (token === "BLUSDC") return parseFloat(balances.BLEND_USDC) || 0;
      if (token === "AQUSDC") return parseFloat(balances.AQUARIUS_USDC) || 0;
      if (token === "SOUSDC") return parseFloat(balances.SOROSWAP_USDC) || 0;

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
      const clamped = clampRepayDust(Number.isFinite(fullAmount) ? fullAmount : 0);
      setRepayAmount(parseFloat(clamped.toFixed(2)));
      return;
    }

    // Calculate amount based on percentage.
    const calculatedAmount = clampRepayDust((repayStats.netOutstandingAmountToPay * item) / 100);
    setRepayAmount(parseFloat(calculatedAmount.toFixed(2)));
  };

  // Handler for input change
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const sanitized = validateAmountChange(e.target.value);
    if (sanitized === null) return; // invalid char — toast already shown
    setRepayAmount(sanitized === "" ? 0 : Number(sanitized));
  };

  const repayMutation = useMutation({
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
      const finalRepayWad = debtWad > BigInt(0)
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
        throw new Error(result.error || 'Loan repayment failed');
      }

      return { hash: result.hash, finalRepayWad };
    },
    onSuccess: async ({ hash, finalRepayWad }) => {
      if (hash) {
        appendMarginHistory({
          marginAccountAddress: marginAccount,
          type: "repay",
          asset: normalizeContractTokenSymbol(selectedRepayCurrency),
          amount: wadToFixed7(finalRepayWad),
          hash,
        });
      }
      toast.success(`Loan repayment successful! Tx: ${hash ? hash.slice(0, 16) + '…' : ''}`);

      // Reset form and trigger RQ refresh first so the UI reflects the new
      // state immediately. The imperative Zustand-store refresh calls below
      // can transiently throw when Freighter's getAddress returns undefined
      // right after a signed tx popup closes (strkey decode of an undefined
      // address). Swallowing the error here keeps the mutation in its success
      // state — the ledger tick will reconcile the store on the next close.
      setRepayAmount(0);
      qc.invalidateQueries({ queryKey: ['margin'] });

      try {
        await refreshSelectedTokenDebt(marginAccount);
        await refreshMarginStoreBorrowedBalances(marginAccount, true);
        await refreshSelectedWalletBalance(userAddress, selectedRepayCurrency);
      } catch (error) {
        console.warn("Post-repay balance refresh failed; ledger tick will reconcile.", error);
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Repay failed');
    },
    onSettled: () => {
      setIsPayNowPopupOpen(false);
    },
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
                value={repayAmount === 0 ? "" : repayAmount}
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
              ≈ {repayAmountInUsd.toFixed(2)} USD
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
                description={`Are you sure you want to repay ${(Number(repayAmount) || 0).toFixed(2)} ${selectedRepayCurrency}? This will reduce your borrowed amount.`}
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
  repayAmount: number;
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
