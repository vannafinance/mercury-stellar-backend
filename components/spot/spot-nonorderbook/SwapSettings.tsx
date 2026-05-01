"use client";

import { useTheme } from "@/contexts/theme-context";
import { Modal } from "@/components/ui/modal";
import { SlippageSelector } from "./SlippageSelector";

interface SwapSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  slippage: string;
  onSlippageChange: (val: string) => void;
  slippageMode: "auto" | "custom";
  onSlippageModeChange: (mode: "auto" | "custom") => void;
  deadline: number;
  onDeadlineChange: (minutes: number) => void;
}

export const SwapSettings = ({
  isOpen,
  onClose,
  slippage,
  onSlippageChange,
  slippageMode,
  onSlippageModeChange,
  deadline,
  onDeadlineChange,
}: SwapSettingsProps) => {
  const { isDark } = useTheme();

  return (
    <Modal open={isOpen} onClose={onClose} bottomSheet>
      <div
        className={`w-full min-[550px]:w-[380px] rounded-2xl p-5 flex flex-col gap-5 ${
          isDark
            ? "bg-[#1A1A1A] border border-[#2A2A2A]"
            : "bg-white border border-[#E8E8E8]"
        }`}
        style={{
          boxShadow: isDark
            ? "0 12px 40px rgba(0,0,0,0.5)"
            : "0 8px 32px rgba(0,0,0,0.12)",
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <span
            className={`text-[15px] font-semibold leading-[22px] ${
              isDark ? "text-white" : "text-[#111111]"
            }`}
          >
            Swap Settings
          </span>
          <button
            type="button"
            onClick={onClose}
            className={`w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer transition-colors ${
              isDark ? "hover:bg-[#2A2A2A]" : "hover:bg-[#F4F4F4]"
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M10.5 3.5L3.5 10.5M3.5 3.5L10.5 10.5"
                stroke={isDark ? "#666666" : "#999999"}
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Divider */}
        <div className={`h-px -mx-5 ${isDark ? "bg-[#2A2A2A]" : "bg-[#F0F0F0]"}`} />

        {/* Slippage Tolerance */}
        <div className="flex flex-col gap-2.5">
          <label
            className={`text-[11px] font-semibold leading-[16px] uppercase tracking-[0.5px] ${
              isDark ? "text-[#888888]" : "text-[#999999]"
            }`}
          >
            Slippage Tolerance
          </label>
          <SlippageSelector
            value={slippage}
            mode={slippageMode}
            onValueChange={onSlippageChange}
            onModeChange={onSlippageModeChange}
          />
        </div>

        {/* Transaction Deadline */}
        <div className="flex flex-col gap-2.5">
          <label
            className={`text-[11px] font-semibold leading-[16px] uppercase tracking-[0.5px] ${
              isDark ? "text-[#888888]" : "text-[#999999]"
            }`}
          >
            Transaction Deadline
          </label>
          <div
            className={`flex items-center h-[42px] rounded-xl border px-3 transition-colors ${
              isDark
                ? "bg-[#111111] border-[#2A2A2A] focus-within:border-[#703AE6]"
                : "bg-[#F7F7F7] border-[#E2E2E2] focus-within:border-[#703AE6]"
            }`}
          >
            <input
              type="text"
              inputMode="numeric"
              placeholder="20"
              value={deadline}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (!isNaN(val) && val > 0) onDeadlineChange(val);
              }}
              className={`flex-1 bg-transparent outline-none text-[13px] font-medium leading-[20px] ${
                isDark
                  ? "text-white placeholder:text-[#555555]"
                  : "text-[#111111] placeholder:text-[#A7A7A7]"
              }`}
            />
            <span
              className={`text-[12px] font-medium ${
                isDark ? "text-[#555555]" : "text-[#A7A7A7]"
              }`}
            >
              min
            </span>
          </div>
        </div>
      </div>
    </Modal>
  );
};
