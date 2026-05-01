"use client";

import { useTheme } from "@/contexts/theme-context";
import { Token } from "./types";
import { TokenSelector } from "./TokenSelector";
import { motion } from "framer-motion";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";

const PRESET_COLORS: Record<number, string> = {
  25: "bg-[#703AE6]",
  50: "bg-[#FC5457]",
  75: "bg-[#E63ABB]",
  100: "bg-[#FF007A]",
};

interface SwapInputProps {
  label: string;
  token: Token | null;
  amount: string;
  amountUsd: string | null;
  balance: string | null;
  isReadOnly?: boolean;
  isLoading?: boolean;
  onTokenSelect: () => void;
  onAmountChange?: (val: string) => void;
  onMaxClick?: () => void;
  showMax?: boolean;
  showPresets?: boolean;
  activePercent?: number | null;
  onPercentClick?: (percent: number) => void;
  showModeTabs?: boolean;
  swapMode?: "wallet" | "margin";
  onSwapModeChange?: (mode: "wallet" | "margin") => void;
}

export const SwapInput = ({
  label,
  token,
  amount,
  amountUsd,
  balance,
  isReadOnly = false,
  isLoading = false,
  onTokenSelect,
  onAmountChange,
  onMaxClick,
  showMax = false,
  showPresets = false,
  activePercent = null,
  onPercentClick,
  showModeTabs = false,
  swapMode = "wallet",
  onSwapModeChange,
}: SwapInputProps) => {
  const { isDark } = useTheme();

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const sanitized = validateAmountChange(e.target.value);
    if (sanitized === null) return;
    onAmountChange?.(sanitized);
  };

  return (
    <div
      className={`rounded-2xl p-3 sm:p-4 flex flex-col gap-1.5 sm:gap-2 transition-colors ${
        isDark
          ? "bg-[#1A1A1A] border border-[#2A2A2A] hover:border-[#333333]"
          : "bg-[#F7F7F7] border border-[#EEEEEE] hover:border-[#E2E2E2]"
      }`}
    >
      {/* Label row + presets */}
      <div className="flex items-center justify-between">
        <span
          className={`text-[12px] font-medium leading-[18px] ${isDark ? "text-[#A7A7A7]" : "text-[#777777]"}`}
        >
          {label}
        </span>
        {showPresets && balance !== null && (
          <div className="flex items-center gap-1 sm:gap-1.5">
            {[25, 50, 75, 100].map((percent) => {
              const isActive = activePercent === percent;
              return (
                <motion.button
                  key={percent}
                  type="button"
                  onClick={() => onPercentClick?.(percent)}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.93 }}
                  transition={{ duration: 0.1 }}
                  className={`px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-md sm:rounded-lg text-[9px] sm:text-[10px] font-semibold leading-[14px] cursor-pointer transition-all ${
                    isActive
                      ? `${PRESET_COLORS[percent]} text-white`
                      : isDark
                        ? "bg-[#2A2A2A] text-[#A7A7A7] hover:text-white border border-[#333333]"
                        : "bg-[#F0F0F0] text-[#888888] hover:text-[#555555] border border-[#E2E2E2]"
                  }`}
                >
                  {percent === 100 ? "Max" : `${percent}%`}
                </motion.button>
              );
            })}
          </div>
        )}
      </div>

      {/* Token + Amount row */}
      <div className="flex items-center justify-between gap-3">
        <TokenSelector token={token} onClick={onTokenSelect} />

        {/* Amount input */}
        <div className="flex-1 min-w-0">
          {isLoading ? (
            <div className="flex justify-end">
              <div
                className={`h-8 w-32 rounded-lg animate-pulse ${isDark ? "bg-[#333333]" : "bg-[#E2E2E2]"}`}
              />
            </div>
          ) : (
            <input
              type="text"
              inputMode="decimal"
              placeholder="0"
              value={amount}
              onChange={handleInputChange}
              readOnly={isReadOnly}
              className={`w-full text-right text-[22px] sm:text-[28px] md:text-[32px] font-semibold leading-none bg-transparent outline-none placeholder:opacity-30 ${
                isReadOnly ? "cursor-default" : ""
              } ${isDark ? "text-white placeholder:text-[#555555]" : "text-[#111111] placeholder:text-[#CCCCCC]"}`}
            />
          )}
        </div>
      </div>

      {/* Balance + mode tabs row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {balance !== null && (
            <span
              className={`text-[12px] font-medium leading-[18px] ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}
            >
              Balance: {(parseFloat(String(balance)) || 0).toFixed(2)}
            </span>
          )}
          {showMax && balance !== null && (
            <motion.button
              type="button"
              onClick={onMaxClick}
              whileTap={{ scale: 0.95 }}
              className="text-[12px] font-semibold leading-[18px] text-[#703AE6] hover:text-[#8D61EB] cursor-pointer transition-colors"
            >
              MAX
            </motion.button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {amountUsd && (
            <span
              className={`text-[12px] font-medium leading-[18px] ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}
            >
              ≈ ${amountUsd}
            </span>
          )}
          {showModeTabs && (
            <div
              className={`flex items-center gap-0.5 p-0.5 rounded-lg ${
                isDark ? "bg-[#222222] border border-[#2A2A2A]" : "bg-[#EBEBEB] border border-[#E2E2E2]"
              }`}
            >
              <button
                type="button"
                onClick={() => onSwapModeChange?.("wallet")}
                className={`px-2 py-0.5 rounded-md text-[10px] font-semibold leading-[16px] cursor-pointer transition-all ${
                  swapMode === "wallet"
                    ? isDark
                      ? "bg-[#703AE6] text-white shadow-[0_1px_4px_rgba(112,58,230,0.4)]"
                      : "bg-white text-[#111111] shadow-[0_1px_3px_rgba(0,0,0,0.10)]"
                    : isDark
                      ? "text-[#666666] hover:text-[#999999]"
                      : "text-[#999999] hover:text-[#555555]"
                }`}
              >
                WB
              </button>
              <button
                type="button"
                onClick={() => onSwapModeChange?.("margin")}
                className={`px-2 py-0.5 rounded-md text-[10px] font-semibold leading-[16px] cursor-pointer transition-all ${
                  swapMode === "margin"
                    ? isDark
                      ? "bg-[#703AE6] text-white shadow-[0_1px_4px_rgba(112,58,230,0.4)]"
                      : "bg-white text-[#111111] shadow-[0_1px_3px_rgba(0,0,0,0.10)]"
                    : isDark
                      ? "text-[#666666] hover:text-[#999999]"
                      : "text-[#999999] hover:text-[#555555]"
                }`}
              >
                MB
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
