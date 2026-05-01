"use client";

import { useTheme } from "@/contexts/theme-context";
import { RouteStep } from "./types";

interface RouteInfoProps {
  route: RouteStep[] | null;
  isLoading?: boolean;
  dex: string | null;
}

export const RouteInfo = ({ route, isLoading, dex }: RouteInfoProps) => {
  const { isDark } = useTheme();

  if (!route && !isLoading) return null;

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
          Route
        </span>
        {dex && (
          <span
            className={`text-[11px] font-medium leading-[15px] px-2 py-0.5 rounded-full ${
              isDark ? "bg-[#2A2A2A] text-[#A7A7A7]" : "bg-[#EEEEEE] text-[#777777]"
            }`}
          >
            via {dex}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-3">
          <div className={`w-8 h-8 rounded-full animate-pulse ${isDark ? "bg-[#333333]" : "bg-[#E2E2E2]"}`} />
          <div className={`flex-1 h-1 rounded animate-pulse ${isDark ? "bg-[#333333]" : "bg-[#E2E2E2]"}`} />
          <div className={`w-8 h-8 rounded-full animate-pulse ${isDark ? "bg-[#333333]" : "bg-[#E2E2E2]"}`} />
        </div>
      ) : route && route.length > 0 ? (
        <div className="flex items-center gap-0 overflow-x-auto scrollbar-hide">
          {route.map((step, index) => (
            <div key={index} className="flex items-center shrink-0">
              {/* Token In logo */}
              {index === 0 && (
                <div className="flex flex-col items-center gap-1">
                  <div className="w-8 h-8 rounded-full overflow-hidden flex items-center justify-center bg-[#444444]">
                    {step.tokenIn.logo ? (
                      <img
                        src={step.tokenIn.logo}
                        alt={step.tokenIn.symbol}
                        className="w-8 h-8 object-cover"
                      />
                    ) : (
                      <span className="text-[10px] font-semibold text-white">
                        {step.tokenIn.symbol.slice(0, 2)}
                      </span>
                    )}
                  </div>
                  <span
                    className={`text-[10px] font-semibold leading-[15px] ${isDark ? "text-[#CCCCCC]" : "text-[#555555]"}`}
                  >
                    {step.tokenIn.symbol}
                  </span>
                </div>
              )}

              {/* Arrow + Protocol badge */}
              <div className="flex flex-col items-center mx-2 gap-0.5">
                <div
                  className={`px-2 py-1 rounded-md text-[9px] font-semibold leading-none whitespace-nowrap ${
                    isDark ? "bg-[#2A2A2A] text-[#A7A7A7]" : "bg-[#EEEEEE] text-[#777777]"
                  }`}
                >
                  {step.protocol}
                  {step.poolFee && ` · ${step.poolFee}`}
                </div>
                <div className="flex items-center">
                  <div
                    className={`w-6 h-px ${isDark ? "bg-[#444444]" : "bg-[#CCCCCC]"}`}
                  />
                  <svg width="6" height="8" viewBox="0 0 6 8" fill="none">
                    <path
                      d="M1 1L5 4L1 7"
                      stroke={isDark ? "#555555" : "#AAAAAA"}
                      strokeWidth="1.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <div
                    className={`w-6 h-px ${isDark ? "bg-[#444444]" : "bg-[#CCCCCC]"}`}
                  />
                </div>
              </div>

              {/* Token Out logo */}
              <div className="flex flex-col items-center gap-1">
                <div className="w-8 h-8 rounded-full overflow-hidden flex items-center justify-center bg-[#444444]">
                  {step.tokenOut.logo ? (
                    <img
                      src={step.tokenOut.logo}
                      alt={step.tokenOut.symbol}
                      className="w-8 h-8 object-cover"
                    />
                  ) : (
                    <span className="text-[10px] font-semibold text-white">
                      {step.tokenOut.symbol.slice(0, 2)}
                    </span>
                  )}
                </div>
                <span
                  className={`text-[10px] font-semibold leading-[15px] ${isDark ? "text-[#CCCCCC]" : "text-[#555555]"}`}
                >
                  {step.tokenOut.symbol}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};
