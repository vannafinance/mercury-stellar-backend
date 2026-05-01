"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useWithdraw } from "@/hooks/use-wallet";
import { ASSET_TYPES, AssetType } from "@/lib/stellar-utils";
import { useUserStore } from "@/store/user";
import { useTheme } from "@/contexts/theme-context";
import toast from "react-hot-toast";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";

interface WithdrawModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const ASSET_CONFIG: Record<string, { label: string; sub: string; bg: string }> = {
  XLM:           { label: "XLM",  sub: "Stellar Lumens",  bg: "#703AE6" },
  USDC:          { label: "USDC", sub: "USD Coin",        bg: "#2775CA" },
  AQUARIUS_USDC: { label: "AQU",  sub: "Aquarius USDC",   bg: "#00B2FF" },
  SOROSWAP_USDC: { label: "SRS",  sub: "Soroswap USDC",   bg: "#9333EA" },
};

const AssetIcon = ({ asset, size = 36 }: { asset: string; size?: number }) => {
  const cfg = ASSET_CONFIG[asset] ?? { bg: "#703AE6", label: asset[0] };
  return (
    <div
      className="rounded-full flex items-center justify-center font-bold shrink-0"
      style={{ width: size, height: size, background: cfg.bg, color: "#fff", fontSize: size * 0.36 }}
    >
      {cfg.label.slice(0, 2)}
    </div>
  );
};

export const WithdrawModal: React.FC<WithdrawModalProps> = ({ isOpen, onClose }) => {
  const [amount, setAmount] = useState("");
  const [selectedAsset, setSelectedAsset] = useState<AssetType>(ASSET_TYPES.XLM);
  const { withdraw, isLoading, message, clearMessage } = useWithdraw();
  const { depositedBalances } = useUserStore();
  const { isDark } = useTheme();
  const lastToastedRef = useRef<string>("");

  useEffect(() => {
    if (!message.text || message.text === lastToastedRef.current) return;
    lastToastedRef.current = message.text;
    if (message.type === "success") toast.success(message.text);
    else if (message.type === "error") toast.error(message.text);
    else toast(message.text);
  }, [message.text, message.type]);

  const handleWithdraw = async () => {
    const numAmount = parseFloat(amount);
    if (numAmount > 0) {
      const result = await withdraw(numAmount, selectedAsset);
      if (result.success) {
        setAmount("");
        setTimeout(() => {
          onClose();
          clearMessage();
        }, 2000);
      }
    }
  };

  const handleClose = () => {
    setAmount("");
    clearMessage();
    onClose();
  };

  const availableBalance = depositedBalances[selectedAsset] || "0";

  const setPercentage = (percent: number) => {
    const currentBalance = parseFloat(availableBalance) || 0;
    setAmount((currentBalance * percent).toFixed(2));
  };

  const withdrawAssets: AssetType[] = [
    ASSET_TYPES.XLM,
    ASSET_TYPES.USDC,
    ASSET_TYPES.AQUARIUS_USDC,
    ASSET_TYPES.SOROSWAP_USDC,
  ];

  const numAmount = parseFloat(amount);
  const numAvailable = parseFloat(availableBalance) || 0;
  const isValid = !!amount && numAmount > 0 && numAmount <= numAvailable;
  const cfg = ASSET_CONFIG[selectedAsset] ?? ASSET_CONFIG.XLM;

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
              isDark ? "bg-[#171717] border border-[#2A2A2A]" : "bg-white border border-[#E5E7EB]"
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className={`px-6 py-4 flex items-center justify-between border-b ${isDark ? "border-[#2A2A2A]" : "border-[#F0F0F0]"}`}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-linear-to-br from-[#703AE6] to-[#9B6BFF] flex items-center justify-center shadow-md">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </div>
                <div>
                  <h2 className={`text-[16px] font-bold leading-tight ${isDark ? "text-white" : "text-[#0f172a]"}`}>
                    Withdraw Assets
                  </h2>
                  <p className={`text-[12px] ${isDark ? "text-[#777]" : "text-[#6b7280]"}`}>
                    Remove funds from your portfolio
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
            <div className="px-6 py-5 flex flex-col gap-5">

              {/* Asset selector */}
              <div className="flex flex-col gap-2">
                <label className={`text-[13px] font-semibold ${isDark ? "text-[#A0A0A0]" : "text-[#374151]"}`}>
                  Select Asset
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {withdrawAssets.map((asset) => {
                    const c = ASSET_CONFIG[asset] ?? ASSET_CONFIG.XLM;
                    const active = selectedAsset === asset;
                    return (
                      <button
                        key={asset}
                        type="button"
                        onClick={() => setSelectedAsset(asset)}
                        className={`flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl border transition-all cursor-pointer ${
                          active
                            ? isDark
                              ? "border-[#703AE6] bg-[#703AE6]/10"
                              : "border-[#703AE6] bg-[#703AE6]/8"
                            : isDark
                            ? "border-[#2A2A2A] bg-[#1F1F1F] hover:border-[#444]"
                            : "border-[#E5E7EB] bg-[#FAFAFA] hover:border-[#D1D5DB]"
                        }`}
                      >
                        <AssetIcon asset={asset} size={32} />
                        <span className={`text-[11px] font-semibold leading-none ${
                          active ? "text-[#703AE6]" : isDark ? "text-[#A0A0A0]" : "text-[#374151]"
                        }`}>
                          {c.label}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Selected asset info row */}
                <div className={`flex items-center gap-2 px-3 py-2 rounded-lg ${isDark ? "bg-[#1F1F1F]" : "bg-[#F9F9F9]"}`}>
                  <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: cfg.bg }} />
                  <span className={`text-[12px] font-medium ${isDark ? "text-[#A0A0A0]" : "text-[#6b7280]"}`}>
                    {cfg.sub}
                  </span>
                  <span className={`ml-auto text-[11px] font-semibold ${isDark ? "text-[#777]" : "text-[#9ca3af]"}`}>
                    {selectedAsset}
                  </span>
                </div>
              </div>

              {/* Available balance card */}
              <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${
                isDark ? "bg-[#1F1F1F] border-[#2A2A2A]" : "bg-[#FAFAFA] border-[#E5E7EB]"
              }`}>
                <AssetIcon asset={selectedAsset} size={36} />
                <div className="flex flex-col gap-0.5">
                  <span className={`text-[11px] font-medium ${isDark ? "text-[#777]" : "text-[#9ca3af]"}`}>
                    Available to withdraw
                  </span>
                  <span className={`text-[16px] font-bold ${isDark ? "text-white" : "text-[#0f172a]"}`}>
                    {(parseFloat(String(availableBalance)) || 0).toFixed(2)}{" "}
                    <span className={`text-[13px] font-medium ${isDark ? "text-[#A0A0A0]" : "text-[#6b7280]"}`}>
                      {cfg.label}
                    </span>
                  </span>
                </div>
              </div>

              {/* Amount input */}
              <div className="flex flex-col gap-2">
                <label className={`text-[13px] font-semibold ${isDark ? "text-[#A0A0A0]" : "text-[#374151]"}`}>
                  Amount
                </label>
                <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border-2 transition-colors ${
                  isDark
                    ? "bg-[#1F1F1F] border-[#2A2A2A] focus-within:border-[#703AE6]"
                    : "bg-[#FAFAFA] border-[#E5E7EB] focus-within:border-[#703AE6]"
                }`}>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => {
                      const sanitized = validateAmountChange(e.target.value);
                      if (sanitized === null) return;
                      setAmount(sanitized);
                    }}
                    placeholder="0.00"
                    className={`flex-1 bg-transparent text-[20px] font-bold outline-none min-w-0 ${
                      isDark ? "text-white placeholder-[#444]" : "text-[#0f172a] placeholder-[#D1D5DB]"
                    }`}
                  />
                  <div className="flex items-center gap-2 shrink-0">
                    <AssetIcon asset={selectedAsset} size={24} />
                    <span className={`text-[13px] font-semibold ${isDark ? "text-[#A0A0A0]" : "text-[#6b7280]"}`}>
                      {cfg.label}
                    </span>
                  </div>
                </div>

                {/* Exceeds balance warning */}
                {amount && numAmount > numAvailable && numAvailable > 0 && (
                  <p className="text-[12px] font-medium text-red-500">
                    Exceeds available balance
                  </p>
                )}

                {/* Quick amount buttons */}
                <div className="grid grid-cols-4 gap-2">
                  {[{ label: "25%", pct: 0.25 }, { label: "50%", pct: 0.5 }, { label: "75%", pct: 0.75 }, { label: "MAX", pct: 1 }].map(({ label, pct }) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => setPercentage(pct)}
                      className={`py-1.5 rounded-lg text-[12px] font-semibold transition-colors cursor-pointer ${
                        isDark
                          ? "bg-[#2A2A2A] text-[#A0A0A0] hover:bg-[#703AE6]/20 hover:text-[#703AE6]"
                          : "bg-[#F0F0F0] text-[#6b7280] hover:bg-[#703AE6]/10 hover:text-[#703AE6]"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

            </div>

            {/* Footer */}
            <div className="px-6 pb-5 flex gap-3">
              <button
                type="button"
                onClick={handleClose}
                disabled={isLoading}
                className={`flex-1 h-11 rounded-xl text-[14px] font-semibold transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                  isDark
                    ? "bg-[#2A2A2A] text-[#A0A0A0] hover:bg-[#333] hover:text-white"
                    : "bg-[#F5F5F5] text-[#6b7280] hover:bg-[#EBEBEB] hover:text-[#374151]"
                }`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleWithdraw}
                disabled={isLoading || !isValid}
                className="flex-1 h-11 rounded-xl text-[14px] font-semibold text-white transition-all cursor-pointer bg-[#703AE6] hover:bg-[#6030CC] disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-[#703AE6]/20"
              >
                {isLoading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="animate-spin">
                      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" strokeWidth="4" />
                      <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Processing...
                  </span>
                ) : "Withdraw"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
