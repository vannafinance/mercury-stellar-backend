"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useWithdrawCollateral } from "@/hooks/use-margin";
import { ASSET_TYPES, AssetType } from "@/lib/stellar-utils";
import { useUserStore } from "@/store/user";
import { checkUserMarginAccount, useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useTheme } from "@/contexts/theme-context";
import { Button } from "@/components/ui/button";
import { Dropdown } from "@/components/ui/dropdown";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";
import { normalizeTransferCollateralError } from "@/lib/errors/normalize";
import { DEPOSIT_PERCENTAGES, PERCENTAGE_COLORS } from "@/lib/constants/margin";
import { MarginActionPreview } from "@/components/margin/margin-action-preview";
import { computeCollateralPreviewRows } from "@/lib/utils/margin-preview";

interface WithdrawModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const ASSET_DISPLAY: Record<string, { label: string; sub: string }> = {
  XLM: { label: "XLM", sub: "Stellar Lumens" },
  USDC: { label: "USDC", sub: "USD Coin" },
  AQUARIUS_USDC: { label: "AqUSDC", sub: "Aquarius USDC" },
  SOROSWAP_USDC: { label: "SoUSDC", sub: "Soroswap USDC" },
};

const WITHDRAW_ASSETS: AssetType[] = [
  ASSET_TYPES.XLM,
  ASSET_TYPES.USDC,
  ASSET_TYPES.AQUARIUS_USDC,
  ASSET_TYPES.SOROSWAP_USDC,
];

/** Maps an AssetType to the margin store's `collateralBalances` key (matches transfer-collateral.tsx). */
const normalizeContractTokenSymbol = (symbol: string): string =>
  symbol === "USDC" || symbol === "BLEND_USDC" || symbol === "BLUSDC"
    ? "USDC"
    : symbol === "AQUARIUS_USDC" || symbol === "AqUSDC"
      ? "AQUSDC"
      : symbol === "SOROSWAP_USDC" || symbol === "SoUSDC"
        ? "SOUSDC"
        : symbol;

const LIQUIDATION_THRESHOLD = 1.1;
const BORROW_DUST_USD = 0.01;
const XLM_TRANSFER_EPSILON = 1e-7;
// See transfer-collateral.tsx's identical constant for the on-chain-reserve
// rationale (base reserve + storage TTL/rent + b_rate rounding dust).
const XLM_MARGIN_WITHDRAW_BUFFER = 5;

export const WithdrawModal: React.FC<WithdrawModalProps> = ({ isOpen, onClose }) => {
  const [amount, setAmount] = useState("");
  const [selectedAsset, setSelectedAsset] = useState<AssetType>(ASSET_TYPES.XLM);
  const [percentage, setPercentage] = useState<number | null>(null);
  // Withdrawals here move collateral OUT of the margin account back to the
  // wallet (AccountManagerContract::withdraw_collateral_balance) — the same
  // call transfer-collateral.tsx's "WB" mode makes — NOT the plain
  // lending-pool redeem flow (that's the Earn page's Withdraw).
  const withdrawMutation = useWithdrawCollateral();
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" | "info" }>({
    text: "",
    type: "info",
  });
  const clearMessage = () => setMessage({ text: "", type: "info" });
  const isLoading = withdrawMutation.isPending;

  const userAddress = useUserStore((state) => state.address);
  const { collateralBalances, totalCollateralValue, totalBorrowedValue, avgHealthFactor } = useMarginAccountInfoStore();
  const tokenPrices = useTokenPrices(["XLM", "USDC", "BLUSDC", "AQUSDC", "SOUSDC"]);
  const { isDark } = useTheme();

  useEffect(() => {
    if (isOpen && userAddress) {
      checkUserMarginAccount(userAddress).catch(() => {});
    }
  }, [isOpen, userAddress]);

  const sym = normalizeContractTokenSymbol(selectedAsset);
  const cfg = ASSET_DISPLAY[selectedAsset] ?? ASSET_DISPLAY.XLM;
  const availableBalance = collateralBalances[sym]?.amount || "0";
  const numAvailable = parseFloat(availableBalance) || 0;
  const hasMeaningfulDebt = totalBorrowedValue > BORROW_DUST_USD;
  const selectedTokenPrice = tokenPrices[sym] ?? 1;

  // Health-factor-aware safe withdraw cap — identical math to
  // transfer-collateral.tsx's "WB" mode: gross_before = avgHF × debt,
  // withdrawing W keeps gross_after / debt ≥ 1.1 only while W ≤ (avgHF − 1.1) × debt.
  const maxRiskSafeWithdraw = (() => {
    if (!hasMeaningfulDebt) return numAvailable;
    const withdrawableUsd = Math.max(0, (avgHealthFactor - LIQUIDATION_THRESHOLD) * totalBorrowedValue);
    if (selectedTokenPrice <= 0) return 0;
    const rawToken = withdrawableUsd / selectedTokenPrice;
    const withdrawableToken =
      numAvailable > 0 && rawToken < numAvailable && (numAvailable - rawToken) / numAvailable < 0.001
        ? numAvailable
        : rawToken;
    return Math.max(0, Math.min(numAvailable, withdrawableToken) - XLM_TRANSFER_EPSILON);
  })();
  const maxExecutableWithdraw = (() => {
    if (sym === "XLM" && !hasMeaningfulDebt) {
      return Math.max(0, Math.min(maxRiskSafeWithdraw, numAvailable - XLM_MARGIN_WITHDRAW_BUFFER));
    }
    return Math.max(0, maxRiskSafeWithdraw - XLM_TRANSFER_EPSILON);
  })();

  const numAmount = parseFloat(amount) || 0;
  const projectedHfAfter = (() => {
    if (!hasMeaningfulDebt) return Infinity;
    if (avgHealthFactor <= 0) return Infinity;
    const withdrawUsd = numAmount * selectedTokenPrice;
    const grossBefore = avgHealthFactor * totalBorrowedValue;
    return Math.max(0, grossBefore - withdrawUsd) / totalBorrowedValue;
  })();
  const isBelowLiqThreshold =
    numAmount > 0 && hasMeaningfulDebt && projectedHfAfter < LIQUIDATION_THRESHOLD;

  const previewRows =
    numAmount > 0
      ? computeCollateralPreviewRows({
          totalCollateralValue,
          totalBorrowedValue,
          avgHealthFactor,
          transferUsd: numAmount * selectedTokenPrice,
          isInbound: false,
        })
      : null;

  const withdraw = async (amt: number, asset: AssetType): Promise<{ success: boolean }> => {
    setMessage({ text: "", type: "info" });
    try {
      await withdrawMutation.mutateAsync({ amount: amt, assetType: asset });
      setMessage({ text: "Withdrawal to wallet successful!", type: "success" });
      return { success: true };
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Withdrawal failed. Please try again.";
      setMessage({
        text: normalizeTransferCollateralError(raw, cfg.label, {
          maxSafe: maxExecutableWithdraw,
          isFullWithdraw: !hasMeaningfulDebt,
          maxExecutableWithdraw,
          xlmBuffer: XLM_MARGIN_WITHDRAW_BUFFER,
        }),
        type: "error",
      });
      return { success: false };
    }
  };

  const handleWithdraw = async () => {
    if (numAmount > 0) {
      const result = await withdraw(numAmount, selectedAsset);
      if (result.success) {
        setAmount("");
        setPercentage(null);
        setTimeout(() => {
          onClose();
          clearMessage();
        }, 2000);
      }
    }
  };

  const handleClose = () => {
    setAmount("");
    setPercentage(null);
    clearMessage();
    onClose();
  };

  const handleAssetChange = (label: string) => {
    const asset = WITHDRAW_ASSETS.find((a) => ASSET_DISPLAY[a].label === label);
    if (asset) {
      setSelectedAsset(asset);
      setAmount("");
      setPercentage(null);
    }
  };

  const handlePercentageClick = (pct: number) => {
    setPercentage(pct);
    setAmount(((maxExecutableWithdraw * pct) / 100).toFixed(2));
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const sanitized = validateAmountChange(e.target.value);
    if (sanitized === null) return;
    setAmount(sanitized);
    setPercentage(null);
  };

  const isValid =
    !!amount && numAmount > 0 && numAmount <= maxExecutableWithdraw + XLM_TRANSFER_EPSILON && !isBelowLiqThreshold;
  const exceedsBalance = !!amount && numAmount > numAvailable && numAvailable > 0;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={handleClose}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 16 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 16 }}
            transition={{ type: "spring", damping: 28, stiffness: 320 }}
            className={`w-full max-w-[440px] rounded-2xl shadow-2xl overflow-hidden ${
              isDark ? "bg-[#171717] border border-[#2A2A2A]" : "bg-white border border-[#E8E8E8]"
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className={`px-6 py-4 flex items-center justify-between border-b ${isDark ? "border-[#2A2A2A]" : "border-[#F0F0F0]"}`}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-linear-to-br from-[#703AE6] to-[#9B6BFF] flex items-center justify-center shadow-md">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m18 9-6-6-6 6" />
                    <path d="M12 3v14" />
                    <path d="M5 21h14" />
                  </svg>
                </div>
                <div>
                  <h2 className={`text-[16px] font-bold leading-tight ${isDark ? "text-white" : "text-[#1A1A1A]"}`}>
                    Withdraw Assets
                  </h2>
                  <p className={`text-[12px] ${isDark ? "text-[#777]" : "text-[#777777]"}`}>
                    Move collateral from margin account to wallet
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleClose}
                className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
                  isDark ? "hover:bg-[#2A2A2A] text-[#777]" : "hover:bg-[#F5F5F5] text-[#9ca3af]"
                }`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Body */}
            <div className="px-6 py-5 flex flex-col gap-4">
              <div
                className={`w-full rounded-2xl border p-4 flex flex-col gap-3 ${
                  isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#EEEEEE]"
                }`}
              >
                {/* Row 1: label + % chips */}
                <div className="flex items-center justify-between">
                  <span className={`text-[13px] font-medium ${isDark ? "text-[#A7A7A7]" : "text-[#777777]"}`}>
                    Amount
                  </span>
                  <div className="flex items-center gap-1.5" role="group" aria-label="Withdraw percentage">
                    {DEPOSIT_PERCENTAGES.map((pct) => (
                      <motion.button
                        key={pct}
                        type="button"
                        onClick={() => handlePercentageClick(pct)}
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.93 }}
                        transition={{ duration: 0.1 }}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold cursor-pointer border transition-all ${
                          percentage === pct
                            ? `${PERCENTAGE_COLORS[pct]} text-white border-transparent`
                            : isDark
                            ? "bg-[#2A2A2A] text-[#A7A7A7] border-[#2A2A2A] hover:text-white"
                            : "bg-[#F0F0F0] text-[#888888] hover:text-[#555555] border-[#E2E2E2]"
                        }`}
                      >
                        {pct}%
                      </motion.button>
                    ))}
                  </div>
                </div>

                {/* Row 2: asset dropdown + amount input */}
                <div className="flex items-center justify-between gap-3">
                  <div className="shrink-0">
                    <Dropdown
                      classname={`gap-2 px-3 py-2 rounded-full text-[14px] font-semibold transition-colors ${
                        isDark ? "bg-[#2A2A2A] hover:bg-[#2A2A2A] text-white" : "bg-[#F0F0F0] hover:bg-[#E2E2E2]"
                      }`}
                      selectedOption={cfg.label}
                      setSelectedOption={handleAssetChange}
                      items={WITHDRAW_ASSETS.map((a) => ASSET_DISPLAY[a].label)}
                      dropdownClassname="text-[13px] gap-2"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <label htmlFor="withdraw-amount" className="sr-only">Withdraw amount</label>
                    <input
                      id="withdraw-amount"
                      value={amount}
                      onChange={handleAmountChange}
                      type="text"
                      inputMode="decimal"
                      placeholder="0"
                      disabled={isLoading}
                      className={`w-full text-right text-[26px] font-semibold bg-transparent outline-none placeholder:opacity-30 ${
                        isDark ? "text-white placeholder:text-[#555555]" : "text-[#111111] placeholder:text-[#CCCCCC]"
                      } ${isLoading ? "opacity-50" : ""}`}
                    />
                  </div>
                </div>

                {/* Row 3: balance */}
                <div className="flex items-center justify-between">
                  <span className={`text-[12px] font-medium ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}>
                    {cfg.sub}
                  </span>
                  <span className={`text-[12px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
                    Available: {numAvailable.toFixed(2)} {cfg.label}
                  </span>
                </div>
              </div>

              {/* Transaction preview — collateral / HF / liquidation buffer before vs after */}
              {previewRows && <MarginActionPreview rows={previewRows} />}

              {/* Exceeds balance warning */}
              {exceedsBalance && (
                <p className="text-[12px] font-medium text-red-500 -mt-2">
                  Exceeds available balance
                </p>
              )}

              {/* Liquidation-risk warning — blocks submit, mirrors transfer-collateral.tsx */}
              {isBelowLiqThreshold && (
                <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-2.5 text-[12px] font-semibold text-red-700">
                  ⚠ This withdrawal would drop your Health Factor to {Number.isFinite(projectedHfAfter) ? projectedHfAfter.toFixed(2) : "∞"} (below 1.10). Reduce the amount or repay some debt first.
                </div>
              )}

              {/* Status message */}
              <AnimatePresence>
                {message.text && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className={`flex items-center gap-3 px-4 py-3 rounded-xl text-[13px] font-medium ${
                      message.type === "success"
                        ? "bg-green-500/10 border border-green-500/20 text-green-600"
                        : message.type === "error"
                        ? "bg-red-500/10 border border-red-500/20 text-red-500"
                        : "bg-[#703AE6]/10 border border-[#703AE6]/20 text-[#703AE6]"
                    }`}>
                      {message.type === "success" && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="shrink-0">
                          <path d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                      {message.type === "error" && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="shrink-0">
                          <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                      )}
                      {message.type === "info" && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0 animate-spin">
                          <circle cx="12" cy="12" r="10" strokeOpacity="0.25" strokeWidth="4" />
                          <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                      )}
                      {message.text}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Footer */}
            <div className="px-6 pb-5 flex gap-3">
              <Button
                text="Cancel"
                size="large"
                type="ghost"
                disabled={isLoading}
                onClick={handleClose}
              />
              <Button
                text={isLoading ? "Processing..." : "Withdraw"}
                size="large"
                type="gradient"
                disabled={isLoading || !isValid}
                onClick={handleWithdraw}
              />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
