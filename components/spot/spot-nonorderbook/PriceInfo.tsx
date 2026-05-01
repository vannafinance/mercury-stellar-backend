"use client";

import { useTheme } from "@/contexts/theme-context";
import { Token, PriceImpactLevel } from "./types";

interface PriceInfoProps {
  tokenIn: Token | null;
  tokenOut: Token | null;
  rate: string | null;
  rateInverse: string | null;
  priceImpact: string | null;
  priceImpactLevel: PriceImpactLevel;
  isLoading?: boolean;
}

const impactColors: Record<string, { text: string; bg: string }> = {
  low: { text: "#01BC8D", bg: "rgba(1, 188, 141, 0.1)" },
  medium: { text: "#F59E0B", bg: "rgba(245, 158, 11, 0.1)" },
  high: { text: "#FC5457", bg: "rgba(252, 84, 87, 0.1)" },
};

export const PriceInfo = ({
  tokenIn,
  tokenOut,
  rate,
  rateInverse,
  priceImpact,
  priceImpactLevel,
  isLoading,
}: PriceInfoProps) => {
  const { isDark } = useTheme();

  if (!tokenIn || !tokenOut || (!rate && !isLoading)) return null;

  return (
    <div
      className={`rounded-xl p-4 flex flex-col gap-3 transition-colors ${
        isDark
          ? "bg-[#1A1A1A] border border-[#2A2A2A]"
          : "bg-[#F7F7F7] border border-[#EEEEEE]"
      }`}
    >
      <div className="flex items-center justify-between">
        <span
          className={`text-[12px] font-semibold leading-[18px] ${isDark ? "text-[#A7A7A7]" : "text-[#777777]"}`}
        >
          Price Info
        </span>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2">
          <div className={`h-4 w-48 rounded animate-pulse ${isDark ? "bg-[#333333]" : "bg-[#E2E2E2]"}`} />
          <div className={`h-4 w-36 rounded animate-pulse ${isDark ? "bg-[#333333]" : "bg-[#E2E2E2]"}`} />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {/* Rates */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
            {rate && (
              <span
                className={`text-[13px] font-medium leading-[18px] ${isDark ? "text-[#CCCCCC]" : "text-[#444444]"}`}
              >
                {rate}
              </span>
            )}
            {rateInverse && (
              <>
                <span className={`hidden sm:block text-[10px] ${isDark ? "text-[#555555]" : "text-[#CCCCCC]"}`}>
                  |
                </span>
                <span
                  className={`text-[13px] font-medium leading-[18px] ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}
                >
                  {rateInverse}
                </span>
              </>
            )}
          </div>

          {/* Price impact */}
          {priceImpact && priceImpactLevel && (
            <div className="flex items-center gap-2">
              <span
                className={`text-[12px] font-medium leading-[18px] ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}
              >
                Price Impact:
              </span>
              <span
                className="text-[12px] font-semibold leading-[18px] px-2 py-0.5 rounded-full"
                style={{
                  color: impactColors[priceImpactLevel]?.text,
                  backgroundColor: impactColors[priceImpactLevel]?.bg,
                }}
              >
                {priceImpact}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
