"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect } from "react";
import { DropdownOptions } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { DEPOSIT_PERCENTAGES, PERCENTAGE_COLORS } from "@/lib/constants/margin";
import { Dropdown } from "../ui/dropdown";
import { Popup } from "@/components/ui/popup";
import { useTheme } from "@/contexts/theme-context";
import { useTokenPrices } from "@/contexts/price-context";
import { MarginAccountService } from "@/lib/margin-utils";
import { appendMarginHistory } from "@/lib/margin-history";
import { getAddress } from "@stellar/freighter-api";
import { ContractService } from "@/lib/stellar-utils";
import { refreshBorrowedBalances as refreshMarginStoreBorrowedBalances } from "@/store/margin-account-info-store";
import { useUserStore } from "@/store/user";
import toast from "react-hot-toast";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";

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
  const { getPrice } = useTokenPrices();
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
  const [isLoading, setIsLoading] = useState(false);
  
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

  const selectedTokenPrice = getPrice(normalizeContractTokenSymbol(selectedRepayCurrency));
  const repayAmountInUsd = repayAmount * selectedTokenPrice;

  // Popup visibility states
  const [isPayNowPopupOpen, setIsPayNowPopupOpen] = useState(false);
  const [isFlashClosePopupOpen, setIsFlashClosePopupOpen] = useState(false);

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

  const formatStatValue = (value: number, _key: string) => {
    const cleaned = clampRepayDust(value);
    if (cleaned === 0) return "0";

    return cleaned.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
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

  // Handler for pay now click
  const handlePayNowClick = async () => {
    if (!marginAccount || repayAmount <= 0) {
      toast.error("Please enter a valid repay amount");
      return;
    }

    setIsLoading(true);
    try {
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
        toast.error('Nothing to repay for this token');
        return;
      }
      
      const result = await MarginAccountService.repayLoan(
        marginAccount,
        normalizeContractTokenSymbol(selectedRepayCurrency),
        finalRepayWad.toString()
      );

      if (result.success) {
        if (result.hash) {
          appendMarginHistory({
            marginAccountAddress: marginAccount,
            type: "repay",
            asset: normalizeContractTokenSymbol(selectedRepayCurrency),
            amount: wadToFixed7(finalRepayWad),
            hash: result.hash,
          });
        }
        toast.success(`Loan repayment successful! Tx: ${result.hash ? result.hash.slice(0, 16) + '…' : ''}`);
        await refreshSelectedTokenDebt(marginAccount);
        await refreshMarginStoreBorrowedBalances(marginAccount, true);
        await refreshSelectedWalletBalance(userAddress, selectedRepayCurrency);
        setRepayAmount(0);
      } else {
        toast.error(result.error || 'Loan repayment failed');
      }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Repay failed');
    } finally {
      setIsLoading(false);
      setIsPayNowPopupOpen(false);
    }
  };

  // Handler for flash close click
  const handleFlashCloseClick = () => {
    setIsFlashClosePopupOpen(true);
  };

  // Handler for closing pay now popup
  const handleClosePayNowPopup = () => {
    setIsPayNowPopupOpen(false);
  };

  // Handler for closing flash close popup
  const handleCloseFlashClosePopup = () => {
    setIsFlashClosePopupOpen(false);
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
              <span
                className={`text-[22px] font-bold leading-tight ${
                  isDark ? "text-white" : "text-[#111111]"
                }`}
              >
                {formatStatValue(value, key)}
              </span>
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

          {/* Row 3: USD value */}
          <div className="flex justify-end">
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
              text={isLoading ? "Processing..." : "Pay Now"}
              size="large"
              type="gradient"
              onClick={handlePayNowClick}
              disabled={isInputEmpty || isLoading || !marginAccount}
            />
          </motion.div>

          {/* Flash Close button */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{
              type: "spring",
              stiffness: 300,
              damping: 25,
              delay: 0.6,
            }}
            whileHover={isInputEmpty ? {} : { scale: 1.02 }}
            whileTap={isInputEmpty ? {} : { scale: 0.98 }}
          >
            <Button
              text="Flash Close"
              size="large"
              type="ghost"
              onClick={handleFlashCloseClick}
              disabled={isInputEmpty}
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
                buttonText={isLoading ? "Processing..." : "Confirm Repayment"}
                buttonOnClick={handlePayNowClick}
                closeButtonText="Cancel"
                closeButtonOnClick={handleClosePayNowPopup}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Flash Close popup */}
      <AnimatePresence>
        {isFlashClosePopupOpen && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#45454566]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            onClick={handleCloseFlashClosePopup}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ duration: 0.3 }}
              onClick={(e) => e.stopPropagation()}
            >
              <Popup
                icon="/assets/lightning.svg"
                description="Are you sure you want to flash close all positions? All open trades will be closed instantly, locking in current P&L, and this action cannot be undone."
                buttonText="Close all Position"
                buttonOnClick={handleCloseFlashClosePopup}
                closeButtonText="Cancel"
                closeButtonOnClick={handleCloseFlashClosePopup}
                iconBgColor="bg-[#F1EBFD]"
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
};
