"use client";

import { useTheme } from "@/contexts/theme-context";
import { motion } from "framer-motion";
import { SwapButtonState } from "./types";

interface SwapButtonProps {
  state: SwapButtonState;
  onClick: () => void;
  tokenSymbol?: string;
  isLoading?: boolean;
}

const getButtonConfig = (
  state: SwapButtonState,
  tokenSymbol?: string,
): { label: string; variant: "primary" | "disabled" | "danger" | "gradient" } => {
  switch (state) {
    case "connect_wallet":
      return { label: "Connect Wallet", variant: "gradient" };
    case "select_token":
      return { label: "Select a Token", variant: "disabled" };
    case "enter_amount":
      return { label: "Enter an Amount", variant: "disabled" };
    case "loading_quote":
      return { label: "Fetching Best Price...", variant: "disabled" };
    case "insufficient_balance":
      return { label: "Insufficient Balance", variant: "danger" };
    case "approve_token":
      return { label: `Approve ${tokenSymbol || "Token"}`, variant: "primary" };
    case "ready":
      return { label: "Swap", variant: "gradient" };
    case "disabled":
      return { label: "Swap", variant: "disabled" };
    default:
      return { label: "Swap", variant: "disabled" };
  }
};

export const SwapButton = ({ state, onClick, tokenSymbol, isLoading }: SwapButtonProps) => {
  const { isDark } = useTheme();
  const { label, variant } = getButtonConfig(state, tokenSymbol);
  const isDisabled = variant === "disabled" || variant === "danger" || isLoading;

  const bgClass = (() => {
    switch (variant) {
      case "gradient":
        return "bg-gradient hover:opacity-90";
      case "primary":
        return "bg-[#703AE6] hover:bg-[#6635D1]";
      case "danger":
        return isDark ? "bg-[#3D1F1F]" : "bg-[#FEE2E2]";
      case "disabled":
        return isDark ? "bg-[#2A2A2A]" : "bg-[#E2E2E2]";
    }
  })();

  const textClass = (() => {
    switch (variant) {
      case "gradient":
      case "primary":
        return "text-white";
      case "danger":
        return "text-[#FC5457]";
      case "disabled":
        return isDark ? "text-[#555555]" : "text-[#A7A7A7]";
    }
  })();

  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      whileTap={!isDisabled ? { scale: 0.98 } : undefined}
      className={`w-full h-[52px] rounded-2xl text-[16px] font-semibold leading-none transition-all cursor-pointer flex items-center justify-center gap-2 ${bgClass} ${textClass} ${
        isDisabled ? "cursor-not-allowed" : ""
      }`}
    >
      {isLoading && (
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
          className="w-4 h-4"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle
              cx="8"
              cy="8"
              r="6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray="28"
              strokeDashoffset="14"
            />
          </svg>
        </motion.div>
      )}
      {label}
    </motion.button>
  );
};
