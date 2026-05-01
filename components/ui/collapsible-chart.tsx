"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Chart } from "@/components/earn/chart";
import { ChevronDownIcon } from "@/components/icons";
import { useTheme } from "@/contexts/theme-context";

interface CollapsibleChartProps {
  /** Label shown above the stat value */
  label: string;
  /** The stat value to display in collapsed mode on mobile */
  statValue: string;
  /** All Chart component props */
  chartProps: {
    type: "overall-deposit" | "net-apy" | "my-supply" | "deposit-apy" | "net-volume" | "net-profit-loss" | "farm" | "profitAndLoss";
    currencyTab?: boolean;
    height?: number;
    containerWidth?: string;
    containerHeight?: string;
    heading?: string;
    downtrend?: string;
    uptrend?: string;
    customData?: Array<{ date: string; amount: number }>;
    supplyAPY?: number;
    borrowAPY?: number;
  };
  /** Desktop chart height */
  desktopHeight?: number;
  /** Desktop container height class */
  desktopContainerHeight?: string;
  /** Whether the data is loading */
  loading?: boolean;
}

export const CollapsibleChart = ({
  label,
  statValue,
  chartProps,
  desktopHeight = 220,
  desktopContainerHeight = "h-[320px]",
  loading = false,
}: CollapsibleChartProps) => {
  const { isDark } = useTheme();
  const [isOpen, setIsOpen] = useState(false);

  // --- Desktop: original chart as-is (hidden on mobile) ---
  const desktopView = (
    <div className="hidden sm:block w-full">
      {loading ? (
        <div className={`w-full ${desktopContainerHeight} flex items-center justify-center rounded-2xl border ${
          isDark ? "border-[#2A2A2A]" : "border-[#E8E8E8]"
        }`}>
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-[#703AE6]" />
        </div>
      ) : (
        <Chart
          {...chartProps}
          containerWidth="w-full"
          containerHeight={desktopContainerHeight}
          height={desktopHeight}
        />
      )}
    </div>
  );

  // --- Mobile: collapsible stat card (hidden on desktop) ---
  const mobileView = (
    <div className="sm:hidden w-full">
      {loading ? (
        <div
          className={`w-full rounded-2xl p-3 border ${
            isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]"
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <span className={`text-[11px] font-medium ${isDark ? "text-[#A7A7A7]" : "text-[#777777]"}`}>
                {label}
              </span>
              <div className="h-5 w-20 rounded bg-gray-700/30 animate-pulse" />
            </div>
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-[#703AE6]" />
          </div>
        </div>
      ) : (
        <div
          className={`w-full rounded-2xl border transition-colors overflow-hidden ${
            isDark
              ? "bg-[#1A1A1A] border-[#2A2A2A] hover:border-[#333333]"
              : "bg-white border-[#E8E8E8] hover:border-[#E2E2E2]"
          }`}
        >
          {/* Stat header — tap to toggle chart dropdown */}
          <button
            type="button"
            onClick={() => setIsOpen((prev) => !prev)}
            className="w-full flex items-center justify-between p-3 cursor-pointer"
          >
            <div className="flex flex-col gap-0.5 text-left">
              <span
                className={`text-[11px] font-medium leading-[18px] ${
                  isDark ? "text-[#A7A7A7]" : "text-[#777777]"
                }`}
              >
                {label}
              </span>
              <span
                className={`text-[17px] font-semibold ${
                  isDark ? "text-white" : "text-[#111111]"
                }`}
              >
                {statValue}
              </span>
            </div>

            {/* Chevron toggle */}
            <motion.div
              animate={{ rotate: isOpen ? 180 : 0 }}
              transition={{ duration: 0.25 }}
            >
              <ChevronDownIcon
                width={18}
                height={18}
                stroke={isDark ? "#A7A7A7" : "#777777"}
                strokeWidth={2}
              />
            </motion.div>
          </button>

          {/* Expandable chart area (dropdown) — hideTitle so no duplicate heading */}
          <AnimatePresence initial={false}>
            {isOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.3, ease: "easeInOut" }}
                className="overflow-hidden"
              >
                <div className="pb-2 overflow-hidden">
                  <Chart
                    {...chartProps}
                    containerWidth="w-full"
                    containerHeight=""
                    height={180}
                    hideTitle
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );

  return (
    <>
      {desktopView}
      {mobileView}
    </>
  );
};
