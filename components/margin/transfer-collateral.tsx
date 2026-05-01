import { useState, useEffect } from "react";
import { Dropdown } from "../ui/dropdown";
import { AnimatePresence, motion } from "framer-motion";
import { DropdownOptions } from "@/lib/constants";
import { DEPOSIT_PERCENTAGES, PERCENTAGE_COLORS } from "@/lib/constants/margin";
import { DetailsPanel } from "../ui/details-panel";
import { Button } from "../ui/button";
import { useTheme } from "@/contexts/theme-context";
import { useTokenPrices } from "@/contexts/price-context";
import { MarginAccountService } from "@/lib/margin-utils";
import { getAddress } from "@stellar/freighter-api";
import { ContractService } from "@/lib/stellar-utils";
import { appendMarginHistory } from "@/lib/margin-history";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useUserStore } from "@/store/user";
import toast from "react-hot-toast";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";

const XLM_WALLET_RESERVE = 1;
const XLM_TRANSFER_EPSILON = 1e-7;
const XLM_MARGIN_WITHDRAW_BUFFER = 5;
const LIQUIDATION_THRESHOLD = 1.1;

export const TransferCollateral = () => {
  const { isDark } = useTheme();
  const { getPrice } = useTokenPrices();
  const normalizeContractTokenSymbol = (symbol: string) =>
    symbol === "BLUSDC" || symbol === "BLEND_USDC" || symbol === "USDC"
      ? "USDC"
      : symbol === "AqUSDC" || symbol === "AquiresUSDC" || symbol === "AQUARIUS_USDC"
        ? "AQUSDC"
        : symbol === "SoUSDC" || symbol === "SoroswapUSDC" || symbol === "SOROSWAP_USDC"
          ? "SOUSDC"
          : symbol;
  const [selectedCurrency, setSelectedCurrency] = useState<string>("XLM");
  const [selectedTransferType, setSelectedTransferType] = useState<"MB" | "WB">("MB");
  const [valueInput, setValueInput] = useState<string>("");
  const [valueInUsd, setValueInUsd] = useState<number>(0.0);
  const [percentage, setPercentage] = useState<number>(0);
  
  // Wallet and margin account state
  const [userAddress, setUserAddress] = useState<string>("");
  const [marginAccount, setMarginAccount] = useState<string>("");
  const [marginAccountBalance, setMarginAccountBalance] = useState<number>(0);
  const [walletBalance, setWalletBalance] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(false);
  const totalCollateralValue = useMarginAccountInfoStore((state) => state.totalCollateralValue);
  const totalBorrowedValue = useMarginAccountInfoStore((state) => state.totalBorrowedValue);
  // Subscribe to global wallet state — local user/balance state is loaded once
  // on mount via Freighter, so without this hook the component keeps showing
  // the previous wallet's margin and wallet balances after disconnect.
  const globalIsConnected = useUserStore((state) => state.isConnected);
  const globalAddress = useUserStore((state) => state.address);
  useEffect(() => {
    if (!globalIsConnected || !globalAddress) {
      setUserAddress("");
      setMarginAccount("");
      setMarginAccountBalance(0);
      setWalletBalance(0);
      setValueInput("");
      setValueInUsd(0);
      setPercentage(0);
    }
  }, [globalIsConnected, globalAddress]);

  const sourceBalance = selectedTransferType === "MB" ? walletBalance : marginAccountBalance;
  const maxTransferableBalance = computeMaxTransferableBalance(
    selectedTransferType,
    normalizeContractTokenSymbol(selectedCurrency),
    sourceBalance
  );
  const selectedTokenPrice = getPrice(normalizeContractTokenSymbol(selectedCurrency));
  // USD value of the balance shown on the right side of the input row,
  // which mirrors `sourceBalance` (wallet for MB transfers, margin for WB).
  const sourceBalanceInUsd = sourceBalance * selectedTokenPrice;
  const maxRiskSafeWithdraw = (() => {
    if (selectedTransferType !== "WB") return maxTransferableBalance;
    if (totalBorrowedValue <= XLM_TRANSFER_EPSILON) return maxTransferableBalance;
    const withdrawableUsd = Math.max(
      0,
      totalCollateralValue - totalBorrowedValue * LIQUIDATION_THRESHOLD
    );
    if (selectedTokenPrice <= 0) return 0;
    const withdrawableToken = withdrawableUsd / selectedTokenPrice;
    return Math.max(0, Math.min(maxTransferableBalance, withdrawableToken) - XLM_TRANSFER_EPSILON);
  })();
  const maxExecutableWithdraw = (() => {
    if (selectedTransferType !== "WB") return maxTransferableBalance;
    const token = normalizeContractTokenSymbol(selectedCurrency);
    // In practice, exact full XLM collateral withdraw can fail on-chain due to
    // state/rounding drift. Keep a small operational buffer for WB XLM when no debt.
    if (token === "XLM" && totalBorrowedValue <= XLM_TRANSFER_EPSILON) {
      return Math.max(
        0,
        Math.min(maxRiskSafeWithdraw, maxTransferableBalance - XLM_MARGIN_WITHDRAW_BUFFER)
      );
    }
    return Math.max(0, maxRiskSafeWithdraw - XLM_TRANSFER_EPSILON);
  })();
  const isOverSourceBalance = Number(valueInput || 0) > sourceBalance;

  function computeMaxTransferableBalance(
    transferType: "MB" | "WB",
    tokenSymbol: string,
    balance: number
  ) {
    if (transferType === "MB" && tokenSymbol === "XLM") {
      return Math.max(0, balance - XLM_WALLET_RESERVE);
    }
    return Math.max(0, balance);
  }

  const getFriendlyTransferError = (rawError?: string, maxSafeWithdrawAmount?: number) => {
    const compact = (rawError || "").split("\nEvent log")[0]?.trim() || "";
    const text = compact.toLowerCase();
    if (
      text.includes("error(contract, #10)") ||
      text.includes("resulting balance is not within the allowed range")
    ) {
      return "You cannot transfer all your wallet balance. Please keep at least 1 XLM in your wallet.";
    }
    if (
      text.includes("invalidaction") ||
      text.includes("is_withdraw_allowed") ||
      text.includes("unreachablecodereached")
    ) {
      if (typeof maxSafeWithdrawAmount === "number" && maxSafeWithdrawAmount > 0) {
        return `Withdrawal blocked by Risk Engine. Max transferable right now: ${maxSafeWithdrawAmount.toFixed(2)} ${selectedCurrency}.`;
      }
      return "Withdrawal blocked by Risk Engine. Repay some debt first, then try again.";
    }
    if (text.includes("insufficient")) {
      return "Insufficient balance for this transfer.";
    }
    if (
      text.includes("withdraw transaction failed on-chain") ||
      text.includes("withdraw collateral failed with status")
    ) {
      if (selectedTransferType === "WB" && totalBorrowedValue <= XLM_TRANSFER_EPSILON) {
        return `Full withdrawal can fail due to on-chain rounding/state dust. Try up to ${maxExecutableWithdraw.toFixed(2)} ${selectedCurrency}.`;
      }
      if (typeof maxSafeWithdrawAmount === "number" && maxSafeWithdrawAmount > 0) {
        return `Withdrawal failed on-chain. Max transferable right now: ${maxSafeWithdrawAmount.toFixed(2)} ${selectedCurrency}.`;
      }
      return "Withdrawal failed on-chain. Please retry with a slightly smaller amount.";
    }
    if (text.includes("hosterror")) {
      if (selectedTransferType === "WB" && totalBorrowedValue <= XLM_TRANSFER_EPSILON) {
        return `Full withdrawal can fail due to on-chain rounding/state dust. Try up to ${maxExecutableWithdraw.toFixed(2)} ${selectedCurrency}.`;
      }
      return "Transfer failed on-chain. Please retry in a moment.";
    }
    return compact || "Transfer failed. Please try again.";
  };

  const getSelectedWalletBalance = async (address: string, tokenSymbol: string): Promise<number> => {
    try {
      const balances = await ContractService.getAllTokenBalances(address);
      const contractTokenSymbol = normalizeContractTokenSymbol(tokenSymbol);

      if (contractTokenSymbol === "USDC") return parseFloat(balances.BLEND_USDC) || 0;
      if (contractTokenSymbol === "AQUSDC") return parseFloat(balances.AQUARIUS_USDC) || 0;
      if (contractTokenSymbol === "SOUSDC") return parseFloat(balances.SOROSWAP_USDC) || 0;

      return parseFloat(balances.XLM) || 0;
    } catch (error) {
      console.error("Error fetching selected wallet balance:", error);
      return 0;
    }
  };

  const refreshTokenBalances = async (address: string, marginAccountAddress?: string) => {
    const selectedWalletBalance = await getSelectedWalletBalance(address, selectedCurrency);
    setWalletBalance(selectedWalletBalance);

    const accountAddress = marginAccountAddress ?? marginAccount;
    if (!accountAddress) return;

    try {
      const result = await MarginAccountService.getCollateralBalances(accountAddress);
      if (result.success && result.data) {
        const tokenData = result.data[normalizeContractTokenSymbol(selectedCurrency)];
        setMarginAccountBalance(tokenData ? parseFloat(tokenData.amount) || 0 : 0);
      }
    } catch (error) {
      console.error("Error refreshing margin account balance:", error);
    }
  };

  // Load user data on mount
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
            await refreshTokenBalances(address.address, account.address);
          } else {
            await refreshTokenBalances(address.address);
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
    if (userAddress) {
      refreshTokenBalances(userAddress, marginAccount);
    }
  }, [selectedCurrency, marginAccount, userAddress]);

  const handlePercentageClick = (item: number) => {
    setPercentage(item);
    const baseBalance = selectedTransferType === "WB" ? maxExecutableWithdraw : maxTransferableBalance;
    const calculatedAmount = (baseBalance * item) / 100;
    // Floor to 2 decimals so toFixed rounding can't push the displayed amount
    // above the actual max — see handleMaxValueClick comment for the gotcha.
    const safeAmount = Math.floor(calculatedAmount * 100) / 100;
    setValueInput(safeAmount.toFixed(2));
    setValueInUsd(safeAmount);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const sanitized = validateAmountChange(e.target.value);
    if (sanitized === null) return;
    setValueInput(sanitized);
    setValueInUsd(sanitized === "" ? 0 : Number(sanitized) * 1); // Placeholder for price conversion
  };

  const handleMaxValueClick = () => {
    const targetMax = selectedTransferType === "WB" ? maxExecutableWithdraw : maxTransferableBalance;
    // Floor to 2 decimals — toFixed(2) rounds 509.998964 → "510.00", which then
    // parses back to 510 and trips the (input > max + epsilon) validation. Floor
    // guarantees the displayed value is always ≤ the real max.
    const safeMax = Math.floor(targetMax * 100) / 100;
    setValueInput(safeMax.toFixed(2));
    setValueInUsd(safeMax);
  };

  const handleTransferClick = async () => {
    if (!marginAccount || !valueInput || Number(valueInput) <= 0) {
      toast.error("Please enter a valid amount");
      return;
    }

    if (Number(valueInput) > sourceBalance) {
      toast.error("Insufficient balance for selected transfer mode");
      return;
    }
    if (
      selectedTransferType === "MB" &&
      normalizeContractTokenSymbol(selectedCurrency) === "XLM" &&
      Number(valueInput) >= sourceBalance - XLM_TRANSFER_EPSILON
    ) {
      toast.error("You cannot transfer all your wallet balance. Please keep at least 1 XLM in your wallet.");
      return;
    }
    if (Number(valueInput) > maxTransferableBalance + XLM_TRANSFER_EPSILON) {
      toast.error("You cannot transfer all your wallet balance. Please keep at least 1 XLM in your wallet.");
      return;
    }
    if (
      selectedTransferType === "WB" &&
      Number(valueInput) > maxExecutableWithdraw + XLM_TRANSFER_EPSILON
    ) {
      // Treat near-zero debt (< 0.01 USD) as effectively no debt — leftover
      // dust from rounding shouldn't make us lecture the user about safety.
      const hasMeaningfulDebt = totalBorrowedValue > 0.01;
      const safeMaxDisplay = (Math.floor(maxExecutableWithdraw * 100) / 100).toFixed(2);
      if (!hasMeaningfulDebt) {
        toast.error(
          `Max transferable right now: ${safeMaxDisplay} ${selectedCurrency}. (A small reserve is kept to avoid on-chain rounding failures.)`
        );
      } else if (maxExecutableWithdraw > 0) {
        toast.error(
          `Unsafe withdrawal for current debt/health factor. Max you can transfer now: ${safeMaxDisplay} ${selectedCurrency}.`
        );
      } else {
        toast.error("Unsafe withdrawal for current debt/health factor. Repay some debt first.");
      }
      return;
    }

    setIsLoading(true);
    try {
      const amountWad = (BigInt(Math.floor(Number(valueInput) * 1000000)) * BigInt(1000000000000)).toString();

      const result = selectedTransferType === "MB"
        ? await MarginAccountService.depositCollateralTokens(
            marginAccount,
            normalizeContractTokenSymbol(selectedCurrency),
            amountWad
          )
        : await MarginAccountService.withdrawCollateralBalance(
            marginAccount,
            normalizeContractTokenSymbol(selectedCurrency),
            amountWad
          );

      if (result.success) {
        appendMarginHistory({
          marginAccountAddress: marginAccount,
          type: selectedTransferType === "MB" ? "transfer-in" : "transfer-out",
          asset: normalizeContractTokenSymbol(selectedCurrency),
          amount: Number(valueInput).toFixed(7),
          hash: result.hash ?? "",
        });

        toast.success(
          `${selectedTransferType === "MB" ? "Transfer to margin successful" : "Transfer to wallet successful"}! Tx: ${result.hash ? result.hash.slice(0, 16) + '…' : ''}`
        );
        await refreshTokenBalances(userAddress, marginAccount);
        setValueInput("");
        setValueInUsd(0);
      } else {
        // The on-chain call failed at the entered amount, so the "safe max"
        // shown in the toast must be lower than what the user just tried —
        // showing maxExecutableWithdraw (the frontend's optimistic estimate)
        // is misleading because that's the same number that just failed.
        const entered = Number(valueInput) || 0;
        const steppedDown = Math.max(0, entered - XLM_MARGIN_WITHDRAW_BUFFER);
        const safeFloor = Math.floor(steppedDown * 100) / 100;
        const safeMaxAfterFailure = Math.max(0, Math.min(maxExecutableWithdraw, safeFloor));

        if (
          selectedTransferType === "WB" &&
          normalizeContractTokenSymbol(selectedCurrency) === "XLM" &&
          totalBorrowedValue <= XLM_TRANSFER_EPSILON &&
          safeMaxAfterFailure > 0
        ) {
          setValueInput(safeMaxAfterFailure.toFixed(2));
          setValueInUsd(safeMaxAfterFailure);
        }
        toast.error(getFriendlyTransferError(result.error, safeMaxAfterFailure));
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Transfer failed";
      const entered = Number(valueInput) || 0;
      const safeFloor = Math.floor(Math.max(0, entered - XLM_MARGIN_WITHDRAW_BUFFER) * 100) / 100;
      const safeMaxAfterFailure = Math.max(0, Math.min(maxExecutableWithdraw, safeFloor));
      toast.error(getFriendlyTransferError(message, safeMaxAfterFailure));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <motion.section
      className="flex flex-col justify-between gap-6 pt-8"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
    >
      {/* Transfer form card */}
      <motion.article
        className={`w-full rounded-2xl border p-3 sm:p-4 flex flex-col gap-2 ${
          isDark
            ? "bg-[#1A1A1A] border-[#2A2A2A]"
            : "bg-white border-[#EEEEEE]"
        }`}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3, delay: 0.1 }}
      >
        {/* Row 1: "Transfer" label + % chips */}
        <div className="flex items-center justify-between">
          <span
            className={`text-sm font-medium ${
              isDark ? "text-[#A7A7A7]" : "text-[#777777]"
            }`}
          >
            Transfer
          </span>
          <AnimatePresence mode="wait">
            <motion.div
              key="pct-chips"
              className="flex items-center gap-1 sm:gap-1.5"
              role="group"
              aria-label="Deposit percentage"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            >
              {DEPOSIT_PERCENTAGES.map((item) => (
                <motion.button
                  type="button"
                  key={item}
                  onClick={() => handlePercentageClick(item)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold cursor-pointer border transition-all ${
                    percentage === item
                      ? `${PERCENTAGE_COLORS[item]} text-white border-transparent`
                      : isDark
                        ? "bg-[#2A2A2A] text-[#A7A7A7] border-[#333333] hover:text-white"
                        : "bg-[#F0F0F0] text-[#888888] hover:text-[#555555] border-[#E2E2E2]"
                  }`}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.93 }}
                  transition={{ duration: 0.1 }}
                  aria-label={`Select ${item} percent`}
                  aria-pressed={percentage === item}
                >
                  {item}%
                </motion.button>
              ))}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Row 2: token dropdown pill + amount input */}
        <div className="flex items-center justify-between gap-3">
          <div className="shrink-0">
            <Dropdown
              classname={`gap-2 px-3 py-2 rounded-full text-[14px] font-semibold transition-colors ${
                isDark
                  ? "bg-[#333333] hover:bg-[#3D3D3D] text-white"
                  : "bg-[#EEEEEE] hover:bg-[#E2E2E2]"
              }`}
              selectedOption={selectedCurrency}
              setSelectedOption={setSelectedCurrency}
              items={DropdownOptions}
              dropdownClassname="text-[13px] gap-2"
            />
          </div>
          <div className="flex-1 min-w-0">
            <label htmlFor="collateral-amount-input" className="sr-only">
              Collateral amount
            </label>
            <input
              id="collateral-amount-input"
              onChange={handleInputChange}
              className={`w-full text-right text-[22px] sm:text-[28px] font-semibold bg-transparent outline-none placeholder:opacity-30 ${
                isDark
                  ? "text-white placeholder:text-[#555555]"
                  : "text-[#111111] placeholder:text-[#CCCCCC]"
              }`}
              type="text"
              inputMode="decimal"
              placeholder="0"
              value={valueInput}
            />
          </div>
        </div>

        {/* Row 3: balance info + USD + Max */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span
              className={`text-[12px] font-medium ${
                isDark ? "text-[#777777]" : "text-[#A7A7A7]"
              }`}
            >
              Transfer To:{" "}
              <span
                className={`font-semibold ${
                  isDark ? "text-white" : "text-[#111111]"
                }`}
              >
                {selectedTransferType === "MB" ? "Margin Account" : "Wallet"}
              </span>
            </span>
            <motion.button
              onClick={handleMaxValueClick}
              className={`cursor-pointer rounded-md py-0.5 px-2 text-[11px] font-semibold ${
                isDark
                  ? "bg-[#2A1A3E] text-[#A97EFF]"
                  : "bg-[#F1EBFD] text-[#703AE6]"
              }`}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              transition={{ duration: 0.2 }}
            >
              Max
            </motion.button>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`text-[13px] font-semibold ${
                isDark ? "text-white" : "text-[#111111]"
              }`}
            >
              {(selectedTransferType === "MB" ? walletBalance : marginAccountBalance).toFixed(2)} {selectedCurrency}
            </span>
            <motion.p
              className={`text-sm font-medium ${
                isDark ? "text-[#777777]" : "text-[#A7A7A7]"
              }`}
              aria-live="polite"
              key={sourceBalanceInUsd}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
            >
              ≈ {sourceBalanceInUsd.toFixed(2)} USD
            </motion.p>
          </div>
        </div>

        {/* Row 4: WB/MB toggle */}
        <div className="flex items-center justify-start">
          <div className={`rounded-[10px] p-[3px] flex gap-[3px] ${isDark ? "bg-[#2A2A2A]" : "bg-[#F0F0F0]"}`}>
            {["WB", "MB"].map((mode) => {
              const active = selectedTransferType === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    setSelectedTransferType(mode as "WB" | "MB");
                    setPercentage(0);
                    setValueInput("");
                    setValueInUsd(0);
                  }}
                  className={`px-3 py-1 rounded-[8px] text-[12px] font-semibold transition-all ${
                    active
                      ? "bg-[#703AE6] text-white"
                      : isDark
                        ? "text-[#A7A7A7] hover:text-white"
                        : "text-[#777777] hover:text-[#333333]"
                  }`}
                >
                  {mode}
                </button>
              );
            })}
          </div>
        </div>
      </motion.article>

      {/* Details panel */}
      <motion.aside
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.3 }}
      >
        <DetailsPanel
          items={[
            {
              title: "Transfer Collateral",
              value: `${valueInput || "0"} ${selectedCurrency}`,
            },
            {
              title: selectedTransferType === "MB" ? "Margin Account Balance" : "Wallet Balance",
              value: `${(selectedTransferType === "MB" ? marginAccountBalance : walletBalance).toFixed(2)} ${selectedCurrency}`,
            },
          ]}
        />
      </motion.aside>

      {/* Action buttons */}
      <motion.section
        className="flex flex-col gap-4"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.4 }}
      >
        <Button
          text={isLoading ? "Processing..." : "Transfer"}
          size="large"
          type="gradient"
          disabled={!(Number(valueInput) > 0 && !isLoading && marginAccount && !isOverSourceBalance)}
          onClick={handleTransferClick}
        />
        <Button
          text="Flash Close"
          size="large"
          type="ghost"
          disabled={!(Number(valueInput) > 0 && !isLoading && marginAccount && !isOverSourceBalance)}
          onClick={handleTransferClick}
        />
      </motion.section>
    </motion.section>
  );
};
