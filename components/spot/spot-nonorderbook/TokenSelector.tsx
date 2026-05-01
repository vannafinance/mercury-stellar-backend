"use client";

import { useTheme } from "@/contexts/theme-context";
import { Token } from "./types";

interface TokenSelectorProps {
  token: Token | null;
  onClick: () => void;
  disabled?: boolean;
}

export const TokenSelector = ({ token, onClick, disabled }: TokenSelectorProps) => {
  const { isDark } = useTheme();

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-2 px-3 py-2 rounded-full transition-all cursor-pointer shrink-0 ${
        token
          ? isDark
            ? "bg-[#333333] hover:bg-[#3D3D3D]"
            : "bg-[#EEEEEE] hover:bg-[#E2E2E2]"
          : "bg-[#703AE6] hover:bg-[#6635D1] text-white"
      } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      {token ? (
        <>
          {/* Token logo */}
          <div className="w-6 h-6 rounded-full overflow-hidden flex items-center justify-center bg-[#444444] shrink-0">
            {token.logo ? (
              <img
                src={token.logo}
                alt={token.symbol}
                className="w-6 h-6 object-cover"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                  (e.target as HTMLImageElement).nextElementSibling?.classList.remove("hidden");
                }}
              />
            ) : null}
            <span
              className={`text-[10px] font-semibold ${token.logo ? "hidden" : ""} ${isDark ? "text-white" : "text-[#111111]"}`}
            >
              {token.symbol.slice(0, 2)}
            </span>
          </div>
          <span
            className={`text-[14px] font-semibold leading-[21px] ${isDark ? "text-white" : "text-[#111111]"}`}
          >
            {token.symbol}
          </span>
          {/* Chevron */}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M3 4.5L6 7.5L9 4.5"
              stroke={isDark ? "#A7A7A7" : "#777777"}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </>
      ) : (
        <>
          <span className="text-[14px] font-semibold leading-[21px] whitespace-nowrap">
            Select token
          </span>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M3 4.5L6 7.5L9 4.5"
              stroke="white"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </>
      )}
    </button>
  );
};
