"use client";

import { useTheme } from "@/contexts/theme-context";
import { motion } from "framer-motion";

interface SlippageSelectorProps {
  value: string;
  mode: "auto" | "custom";
  onValueChange: (val: string) => void;
  onModeChange: (mode: "auto" | "custom") => void;
  presets?: string[];
  warningThreshold?: number;
  dangerThreshold?: number;
}

export const SlippageSelector = ({
  value,
  mode,
  onValueChange,
  onModeChange,
  presets = ["0.1", "0.5", "1.0"],
  warningThreshold = 1.0,
  dangerThreshold = 5.0,
}: SlippageSelectorProps) => {
  const { isDark } = useTheme();
  const numValue = parseFloat(value) || 0;
  const isWarning = numValue >= warningThreshold && numValue < dangerThreshold;
  const isDanger = numValue >= dangerThreshold;

  return (
    <div className="flex flex-col gap-3">
      {/* Auto / Custom toggle */}
      <div
        className={`flex items-center rounded-xl p-1 ${isDark ? "bg-[#1A1A1A] border border-[#2A2A2A]" : "bg-[#F4F4F4] border border-[#EEEEEE]"}`}
      >
        {(["auto", "custom"] as const).map((m) => (
          <motion.button
            key={m}
            type="button"
            onClick={() => onModeChange(m)}
            whileTap={{ scale: 0.95 }}
            className={`flex-1 py-2 rounded-lg text-[12px] font-semibold leading-[18px] cursor-pointer transition-colors capitalize ${
              mode === m
                ? isDark
                  ? "bg-[#3D2A6E] text-[#703AE6]"
                  : "bg-[#F1EBFD] text-[#703AE6]"
                : isDark
                  ? "text-[#777777]"
                  : "text-[#A7A7A7]"
            }`}
          >
            {m}
          </motion.button>
        ))}
      </div>

      {/* Preset chips */}
      <div className="flex items-center gap-2">
        {presets.map((preset) => (
          <motion.button
            key={preset}
            type="button"
            onClick={() => {
              onValueChange(preset);
              onModeChange("custom");
            }}
            whileTap={{ scale: 0.95 }}
            className={`flex-1 py-2 rounded-lg text-[12px] font-semibold leading-[18px] cursor-pointer transition-colors ${
              value === preset && mode === "custom"
                ? isDark
                  ? "bg-[#3D2A6E] text-[#703AE6]"
                  : "bg-[#F1EBFD] text-[#703AE6]"
                : isDark
                  ? "bg-[#2A2A2A] text-[#CCCCCC] hover:bg-[#333333]"
                  : "bg-[#F4F4F4] text-[#555555] hover:bg-[#EEEEEE]"
            }`}
          >
            {preset}%
          </motion.button>
        ))}
      </div>

      {/* Custom input */}
      <div
        className={`flex items-center h-[44px] rounded-xl border px-3 transition-colors ${
          isDark
            ? "bg-[#1A1A1A] border-[#2A2A2A] focus-within:border-[#703AE6]"
            : "bg-[#F7F7F7] border-[#E2E2E2] focus-within:border-[#703AE6]"
        }`}
      >
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.5"
          value={mode === "auto" ? "" : value}
          onChange={(e) => {
            const val = e.target.value;
            if (val === "" || /^\d*\.?\d*$/.test(val)) {
              onValueChange(val);
              onModeChange("custom");
            }
          }}
          disabled={mode === "auto"}
          className={`flex-1 bg-transparent outline-none text-[14px] font-medium leading-[21px] ${
            mode === "auto" ? "opacity-40" : ""
          } ${isDark ? "text-white placeholder:text-[#555555]" : "text-[#111111] placeholder:text-[#A7A7A7]"}`}
        />
        <span
          className={`text-[14px] font-medium ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}
        >
          %
        </span>
      </div>

      {/* Warning text */}
      {mode === "custom" && (isWarning || isDanger) && (
        <p
          className={`text-[11px] font-medium leading-[15px] ${isDanger ? "text-[#FC5457]" : "text-[#F59E0B]"}`}
        >
          {isDanger
            ? "Very high slippage. You may lose a significant portion of your trade."
            : "High slippage may result in an unfavorable trade."}
        </p>
      )}
    </div>
  );
};
