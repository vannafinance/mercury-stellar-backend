import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dropdown } from "../ui/dropdown";
import { AnimatePresence, motion } from "framer-motion";
import { DropdownOptions } from "@/lib/constants";
import { DEPOSIT_PERCENTAGES, PERCENTAGE_COLORS } from "@/lib/constants/margin";
import { Button } from "../ui/button";
import { useTheme } from "@/contexts/theme-context";
import { MarginAccountService } from "@/lib/margin-utils";
import { getAddress } from "@/lib/wallet-adapter";
import { ContractService, CONTRACT_ADDRESSES } from "@/lib/stellar-utils";
import {
  useMarginAccountInfoStore,
  refreshBorrowedBalances,
} from "@/store/margin-account-info-store";
import { useUserStore } from "@/store/user";
import toast from "react-hot-toast";
import { showTxStep, showTxSuccess, showTxError } from "@/lib/tx-progress";
import { normalizeTransferCollateralError } from "@/lib/errors/normalize";
import { validateAmountChange, floorAmountToInput, decimalAmountToWad } from "@/lib/utils/sanitize-amount";
import { useTokenPrices as useTokenPricesFromHook } from "@/hooks/use-token-prices";
import { ConversionRatio } from "@/components/ui/conversion-ratio";
import { MarginActionPreview } from "@/components/margin/margin-action-preview";
import { computeCollateralPreviewRows } from "@/lib/utils/margin-preview";
import { maxMarginWithdrawal, marginWithdrawalPreset } from "@/lib/utils/margin-withdraw";
import { getXlmMinReserve, maxSpendableXlm } from "@/lib/xlm-reserve";

const XLM_TRANSFER_EPSILON = 1e-7;
const LIQUIDATION_THRESHOLD = 1.1;

/**
 * Transfer tab for moving a token between the user's wallet and their margin
 * account in either direction (MB = wallet → margin deposit, WB = margin →
 * wallet withdraw). Computes several distinct caps: the source balance, the
 * risk-safe withdraw limit derived from the store's health factor (so a
 * withdrawal can't reach or cross the 1.1 liquidation threshold). Contract-held
 * tokens have no wallet reserve deduction. Failed transactions preserve the
 * entered amount and report the error. Balances refresh after confirmation.
 */
export const TransferCollateral = () => {
  const { isDark } = useTheme();
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
  const [percentage, setPercentage] = useState<number>(0);

  // Wallet and margin account state
  const [userAddress, setUserAddress] = useState<string>("");
  const [marginAccount, setMarginAccount] = useState<string>("");
  const [marginAccountBalance, setMarginAccountBalance] = useState<number>(0);
  const [walletBalance, setWalletBalance] = useState<number>(0);
  // Real on-chain XLM minimum reserve (base + subentries) — a flat "keep 1
  // XLM" undershoots for a wallet holding several trustlines (USDC, BLUSDC,
  // AQUSDC, SOUSDC, LP shares, ...), each adding 0.5 XLM to the real floor.
  // That underestimate let Max/100% fill in more than the wallet could
  // actually send, which then traps on-chain with Error(Contract, #10)
  // ("resulting balance is not within the allowed range") — same bug the
  // Earn Supply tab's XLM Max had, fixed there with this same helper.
  const [xlmMinReserve, setXlmMinReserve] = useState(1.5);
  const qc = useQueryClient();
  const totalCollateralValue = useMarginAccountInfoStore((state) => state.totalCollateralValue);
  const totalBorrowedValue = useMarginAccountInfoStore((state) => state.totalBorrowedValue);
  const avgHealthFactor = useMarginAccountInfoStore((state) => state.avgHealthFactor);
  const collateralBalances = useMarginAccountInfoStore((state) => state.collateralBalances);
  const hasMeaningfulDebt = totalBorrowedValue > 0;
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
      setPercentage(0);
    }
  }, [globalIsConnected, globalAddress]);

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

  const tokenPrices = useTokenPricesFromHook(['XLM', 'USDC', 'BLUSDC', 'AQUSDC', 'SOUSDC']);
  const sourceBalance = selectedTransferType === "MB" ? walletBalance : marginAccountBalance;
  const maxTransferableBalance = computeMaxTransferableBalance(
    selectedTransferType,
    normalizeContractTokenSymbol(selectedCurrency),
    sourceBalance
  );
  const selectedTokenPrice = tokenPrices[normalizeContractTokenSymbol(selectedCurrency)] ?? 1;
  // What gets SHOWN as "your balance" — for a wallet→margin XLM transfer this
  // is the spendable amount (`maxTransferableBalance`), not the raw wallet
  // balance: showing the full balance and then having Max/100% fill in a
  // smaller number made it look like XLM had "gone missing". Every other
  // case (non-XLM, or margin→wallet) has no such reserve, so the two already
  // match and this is a no-op there.
  const displayedSourceBalance =
    selectedTransferType === "MB" && normalizeContractTokenSymbol(selectedCurrency) === "XLM"
      ? maxTransferableBalance
      : sourceBalance;
  const sourceBalanceInUsd = displayedSourceBalance * selectedTokenPrice;
  const maxExecutableWithdraw = selectedTransferType === "WB"
    ? maxMarginWithdrawal(maxTransferableBalance, totalBorrowedValue, avgHealthFactor, selectedTokenPrice)
    : maxTransferableBalance;
  const marginBalanceInput = collateralBalances[normalizeContractTokenSymbol(selectedCurrency)]?.amount ?? String(marginAccountBalance);
  const isOverSourceBalance = Number(valueInput || 0) > sourceBalance;


  // Projected HF after a WB (withdraw) — used to block the Transfer button
  // and show a warning when the withdrawal would push HF below 1.1.
  const projectedHfAfterWb = (() => {
    if (selectedTransferType !== "WB" || !hasMeaningfulDebt) return Infinity;
    if (avgHealthFactor <= 0) return Infinity;
    const withdrawUsd = Number(valueInput || 0) * selectedTokenPrice;
    const grossBefore = avgHealthFactor * totalBorrowedValue;
    const grossAfter = Math.max(0, grossBefore - withdrawUsd);
    return grossAfter / totalBorrowedValue;
  })();
  const isWbBelowLiqThreshold =
    selectedTransferType === "WB" &&
    Number(valueInput || 0) > 0 &&
    hasMeaningfulDebt &&
    projectedHfAfterWb <= LIQUIDATION_THRESHOLD;

  function computeMaxTransferableBalance(
    transferType: "MB" | "WB",
    tokenSymbol: string,
    balance: number
  ) {
    if (transferType === "MB" && tokenSymbol === "XLM") {
      return maxSpendableXlm(balance, xlmMinReserve);
    }
    return Math.max(0, balance);
  }

  const getFriendlyTransferError = (rawError?: string): string =>
    normalizeTransferCollateralError(rawError, selectedCurrency);

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

  // Map our token symbol to the on-chain SAC contract that holds the actual
  // balance. Used to read the raw token balance of the margin smart account
  // (borrows + unencumbered collateral) for the display row.
  const getTokenSacAddress = (tokenSymbol: string): string => {
    switch (normalizeContractTokenSymbol(tokenSymbol)) {
      case "USDC": return CONTRACT_ADDRESSES.BLEND_USDC;
      case "AQUSDC": return CONTRACT_ADDRESSES.AQUARIUS_USDC;
      case "SOUSDC": return CONTRACT_ADDRESSES.SOROSWAP_USDC;
      default: return CONTRACT_ADDRESSES.BLEND_XLM; // XLM SAC
    }
  };

  const refreshTokenBalances = async (address: string, marginAccountAddress?: string) => {
    const selectedWalletBalance = await getSelectedWalletBalance(address, selectedCurrency);
    setWalletBalance(selectedWalletBalance);

    const accountAddress = marginAccountAddress ?? marginAccount;
    if (!accountAddress) return;

    try {
      const sym = normalizeContractTokenSymbol(selectedCurrency);
      const storeBal = useMarginAccountInfoStore.getState().collateralBalances[sym];
      if (storeBal?.amount) {
        setMarginAccountBalance(parseFloat(storeBal.amount) || 0);
      } else {
        const result = await MarginAccountService.getCollateralBalances(accountAddress);
        if (result.success && result.data) {
          const tokenData = result.data[sym];
          setMarginAccountBalance(tokenData ? parseFloat(tokenData.amount) || 0 : 0);
        }
      }
    } catch (error) {
      console.error("Error refreshing margin account balance:", error);
    }

    // Actual on-chain SAC balance held by the smart account. Margin account
    // is a contract address, so the user's G-address is passed as the
    // simulation source (SDK rejects C-addresses there).
    try {
      const sacAddress = getTokenSacAddress(selectedCurrency);
      const balance = await ContractService.getSorobanTokenWalletBalance(
        sacAddress,
        accountAddress,
        address,
      );
    } catch (error) {
      console.error("Error refreshing actual margin balance:", error);
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
            await refreshBorrowedBalances(account.address, true);
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

  // Keep margin withdrawable balance in sync with the global store (farm-enriched).
  useEffect(() => {
    if (selectedTransferType !== "WB" || !marginAccount) return;
    const sym = normalizeContractTokenSymbol(selectedCurrency);
    const entry = collateralBalances[sym];
    setMarginAccountBalance(parseFloat(entry?.amount ?? "0") || 0);
  }, [collateralBalances, selectedCurrency, selectedTransferType, marginAccount]);

  // Refresh when currency changes
  useEffect(() => {
    if (userAddress) {
      refreshTokenBalances(userAddress, marginAccount);
    }
  }, [selectedCurrency, marginAccount, userAddress]);

  useEffect(() => {
    if (marginAccount) {
      refreshBorrowedBalances(marginAccount, true).catch(console.error);
    }
  }, [marginAccount]);

  const handlePercentageClick = (item: number) => {
    setPercentage(item);
    const baseBalance = selectedTransferType === "WB" ? maxExecutableWithdraw : maxTransferableBalance;
    const calculatedAmount = (baseBalance * item) / 100;
    setValueInput(selectedTransferType === "WB"
      ? marginWithdrawalPreset(marginBalanceInput, maxExecutableWithdraw, item)
      : floorAmountToInput(calculatedAmount));
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const sanitized = validateAmountChange(e.target.value);
    if (sanitized === null) return;
    setValueInput(sanitized);
  };

  const handleMaxValueClick = () => {
    const targetMax = selectedTransferType === "WB" ? maxExecutableWithdraw : maxTransferableBalance;
    // floorAmountToInput floors to 7dp (never rounds UP past the real max, which
    // would trip the > max validation / on-chain rounding) while keeping full
    // Stellar precision — so Max transfers the whole balance, not a 2dp slice.
    setValueInput(selectedTransferType === "WB"
      ? marginWithdrawalPreset(marginBalanceInput, maxExecutableWithdraw)
      : floorAmountToInput(targetMax));
  };

  const transferMutation = useMutation({
    onMutate: () => {
      showTxStep(
        `${selectedTransferType === "MB" ? "Transferring" : "Withdrawing"} ${valueInput || 0} ${selectedCurrency} ${selectedTransferType === "MB" ? "to your margin account" : "to your wallet"}`
      );
    },
    mutationFn: async () => {
      // String-based conversion (not Number(valueInput) * 1e6 then *1e12) —
      // that math only kept 6 of Stellar's 7 decimal places, silently
      // truncating the last digit and stranding it as un-transferable dust
      // on every Max/100% transfer (the same bug the Repay form had, fixed
      // there via this same helper — see decimalAmountToWad's doc comment).
      const amountWad = decimalAmountToWad(valueInput).toString();

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

      if (!result.success) {
        throw new Error(result.error || 'Transfer failed');
      }
      return result;
    },
    onSuccess: async (result) => {
      showTxSuccess(
        `${selectedTransferType === "MB" ? "Transfer to margin successful!" : "Transfer to wallet successful!"}`
      );

      // Reset the form and invalidate RQ caches first so the UI updates even
      // if the imperative Zustand refresh below throws (Freighter's getAddress
      // can transiently return undefined right after a signed tx popup closes,
      // which trips strkey decoding inside getCollateralBalances). The ledger
      // tick will pick up the latest state on the next close regardless.
      setValueInput("");
      qc.invalidateQueries({ queryKey: ['margin'] });

      try {
        await refreshBorrowedBalances(marginAccount, true);
        await refreshTokenBalances(userAddress, marginAccount);
      } catch (error) {
        console.warn("Post-transfer balance refresh failed; ledger tick will reconcile.", error);
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Transfer failed";
      const friendlyMessage = getFriendlyTransferError(message);
      showTxError(friendlyMessage);
    },
  });

  const handleTransferClick = () => {
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
      Number(valueInput) > maxExecutableWithdraw
    ) {
      const safeMaxDisplay = (Math.floor(maxExecutableWithdraw * 100) / 100).toFixed(2);
      if (!hasMeaningfulDebt) {
        toast.error(
          `Max transferable right now: ${safeMaxDisplay} ${selectedCurrency}.`
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

    transferMutation.mutate();
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
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`text-[12px] font-medium truncate ${
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
              className={`cursor-pointer rounded-md py-0.5 px-2 text-[11px] font-semibold shrink-0 ${
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
            <ConversionRatio
              tokenSymbol={selectedCurrency}
              tokenPrice={selectedTokenPrice}
              variant="inline"
            />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`text-[13px] font-semibold ${
                isDark ? "text-white" : "text-[#111111]"
              }`}
            >
              {displayedSourceBalance.toFixed(2)} {selectedCurrency}
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

      {/* Transaction preview — collateral / HF / liquidation buffer before vs after */}
      <TransferPreviewSection
        transferAmount={Number(valueInput) || 0}
        selectedTokenPrice={selectedTokenPrice}
        transferType={selectedTransferType}
      />


      {/* Action buttons */}
      <motion.section
        className="flex flex-col gap-4"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.4 }}
      >
        {isWbBelowLiqThreshold && (
          <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-4 py-2.5 text-xs font-semibold text-red-700">
            ⚠ This withdrawal would drop your Health Factor to {projectedHfAfterWb.toFixed(2)} (below 1.10). Reduce the amount or repay some debt first.
          </div>
        )}
        <Button
          text={transferMutation.isPending ? "Processing..." : "Transfer"}
          size="large"
          type="gradient"
          disabled={!(Number(valueInput) > 0 && !transferMutation.isPending && marginAccount && !isOverSourceBalance) || isWbBelowLiqThreshold}
          onClick={handleTransferClick}
        />
      </motion.section>
    </motion.section>
  );
};

interface TransferPreviewSectionProps {
  /** Transfer amount in token units (converted to USD via `selectedTokenPrice`). */
  transferAmount: number;
  /** Live oracle price of the selected token. */
  selectedTokenPrice: number;
  /** "MB" = wallet → margin (collateral grows). "WB" = margin → wallet (collateral shrinks). */
  transferType: "MB" | "WB";
}

/**
 * Computes the after-state of a collateral transfer and renders the
 * before → after preview. Reads margin totals from the store; the actual
 * before/after math lives in `computeCollateralPreviewRows` (shared with the
 * Portfolio page's Deposit/Withdraw modals).
 *
 * - MB (deposit into margin): collateral grows, debt unchanged → HF improves.
 * - WB (withdraw from margin): collateral shrinks, debt unchanged → HF drops.
 */
const TransferPreviewSection = ({
  transferAmount,
  selectedTokenPrice,
  transferType,
}: TransferPreviewSectionProps) => {
  const totalCollateralValue = useMarginAccountInfoStore((s) => s.totalCollateralValue);
  const totalBorrowedValue = useMarginAccountInfoStore((s) => s.totalBorrowedValue);
  const avgHealthFactor = useMarginAccountInfoStore((s) => s.avgHealthFactor);

  const transferUsd = Math.max(0, transferAmount * selectedTokenPrice);
  if (transferUsd <= 0) return null;

  const rows = computeCollateralPreviewRows({
    totalCollateralValue,
    totalBorrowedValue,
    avgHealthFactor,
    transferUsd,
    isInbound: transferType === "MB",
  });

  return <MarginActionPreview rows={rows} />;
};
