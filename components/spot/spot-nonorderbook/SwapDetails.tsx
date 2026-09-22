"use client";

import { useTheme } from "@/contexts/theme-context";
import { motion, AnimatePresence } from "framer-motion";
import { PriceImpactLevel } from "./types";

interface SwapDetailsProps {
  isVisible: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  exchangeRate: string | null;
  /** When provided, clicking the rate text flips the direction (A→B ↔ B→A). */
  onFlipRate?: () => void;
  /** Actual executed swap rate from the DEX quote — shown alongside the
   *  oracle-driven rate inside the expanded panel so users can see the gap. */
  quoteRate?: string | null;
  priceImpact: string | null;
  priceImpactLevel: PriceImpactLevel;
  slippage: string;
  minReceived: string | null;
  fee: string | null;
  networkCost: string | null;
  onRefreshRate: () => void;
  isRefreshing?: boolean;
  onEditSlippage?: () => void;
}

const priceImpactColors: Record<string, string> = {
  low: "#01BC8D",
  medium: "#F59E0B",
  high: "#FC5457",
};

export const SwapDetails = ({
  isVisible,
  isExpanded,
  onToggleExpand,
  exchangeRate,
  onFlipRate,
  quoteRate,
  priceImpact,
  priceImpactLevel,
  slippage,
  minReceived,
  fee,
  networkCost,
  onRefreshRate,
  isRefreshing,
  onEditSlippage,
}: SwapDetailsProps) => {
  const { isDark } = useTheme();

  if (!isVisible) return null;

  return (
    <div
      className={`rounded-xl overflow-hidden transition-colors ${
        isDark ? "bg-[#1A1A1A] border border-[#2A2A2A]" : "bg-[#F7F7F7] border border-[#EEEEEE]"
      }`}
    >
      {/* Header row - always visible */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleExpand}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleExpand();
          }
        }}
        className="w-full flex items-center justify-between px-4 py-3 cursor-pointer"
      >
        <div className="flex items-center gap-2">
          {exchangeRate && (
            onFlipRate ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onFlipRate();
                }}
                title="Click to flip direction"
                className={`text-[12px] font-medium leading-[18px] cursor-pointer transition-colors ${
                  isDark ? "text-[#CCCCCC] hover:text-white" : "text-[#555555] hover:text-[#111111]"
                }`}
              >
                {exchangeRate}
              </button>
            ) : (
              <span
                className={`text-[12px] font-medium leading-[18px] ${isDark ? "text-[#CCCCCC]" : "text-[#555555]"}`}
              >
                {exchangeRate}
              </span>
            )
          )}
          {/* Refresh button */}
          <motion.button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRefreshRate();
            }}
            animate={{ rotate: isRefreshing ? 360 : 0 }}
            transition={{ duration: 0.6, ease: "linear" }}
            className="p-0.5 cursor-pointer"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M11.67 7A4.67 4.67 0 1 1 7 2.33M7 2.33L9.33 4.67M7 2.33L4.67 4.67"
                stroke={isDark ? "#777777" : "#A7A7A7"}
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </motion.button>
        </div>

        {/* Expand chevron */}
        <motion.div
          animate={{ rotate: isExpanded ? 180 : 0 }}
          transition={{ duration: 0.2 }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M3.5 5.25L7 8.75L10.5 5.25"
              stroke={isDark ? "#777777" : "#A7A7A7"}
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </motion.div>
      </div>

      {/* Expandable details */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div
              className={`px-4 pb-3 flex flex-col gap-2.5 border-t ${isDark ? "border-[#2A2A2A]" : "border-[#EEEEEE]"}`}
            >
              <div className="pt-2.5" />

              {/* Price Impact */}
              {priceImpact && (
                <DetailRow
                  label="Price Impact"
                  isDark={isDark}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className="text-[12px] font-medium leading-[18px]"
                      style={{
                        color: priceImpactLevel
                          ? priceImpactColors[priceImpactLevel]
                          : isDark
                            ? "#CCCCCC"
                            : "#555555",
                      }}
                    >
                      {priceImpact}
                    </span>
                    {priceImpactLevel && (
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{
                          backgroundColor: priceImpactColors[priceImpactLevel],
                        }}
                      />
                    )}
                  </div>
                </DetailRow>
              )}

              {/* Actual quote rate (DEX-executed) — distinct from the
                  oracle rate shown in the header so users see the spread. */}
              {quoteRate && (
                <DetailRow label="Quote Rate" isDark={isDark}>
                  <span
                    className={`text-[12px] font-medium leading-[18px] ${isDark ? "text-[#CCCCCC]" : "text-[#555555]"}`}
                  >
                    {quoteRate}
                  </span>
                </DetailRow>
              )}

              {/* Slippage */}
              <DetailRow label="Slippage Tolerance" isDark={isDark}>
                <div className="flex items-center gap-1.5">
                  <span
                    className={`text-[12px] font-medium leading-[18px] ${isDark ? "text-[#CCCCCC]" : "text-[#555555]"}`}
                  >
                    {slippage}%
                  </span>
                  {onEditSlippage && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditSlippage();
                      }}
                      className="text-[11px] font-semibold text-[#703AE6] hover:text-[#8D61EB] cursor-pointer transition-colors"
                    >
                      Edit
                    </button>
                  )}
                </div>
              </DetailRow>

              {/* Min Received */}
              {minReceived && (
                <DetailRow label="Min. Received" isDark={isDark}>
                  <span
                    className={`text-[12px] font-medium leading-[18px] ${isDark ? "text-[#CCCCCC]" : "text-[#555555]"}`}
                  >
                    {minReceived}
                  </span>
                </DetailRow>
              )}

              {/* Fee */}
              {fee && (
                <DetailRow label="Fee" isDark={isDark}>
                  <span
                    className={`text-[12px] font-medium leading-[18px] ${isDark ? "text-[#CCCCCC]" : "text-[#555555]"}`}
                  >
                    {fee}
                  </span>
                </DetailRow>
              )}

              {/* Network Cost */}
              {networkCost && (
                <DetailRow label="Network Cost" isDark={isDark}>
                  <span
                    className={`text-[12px] font-medium leading-[18px] ${isDark ? "text-[#CCCCCC]" : "text-[#555555]"}`}
                  >
                    {networkCost}
                  </span>
                </DetailRow>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const DetailRow = ({
  label,
  isDark,
  children,
}: {
  label: string;
  isDark: boolean;
  children: React.ReactNode;
}) => (
  <div className="flex items-center justify-between">
    <span
      className={`text-[12px] font-medium leading-[18px] ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}
    >
      {label}
    </span>
    {children}
  </div>
);
