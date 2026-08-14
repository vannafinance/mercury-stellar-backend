"use client";

import type { ReactNode } from "react";

import { useTheme } from "@/contexts/theme-context";

interface InfoTooltipProps {
  content: ReactNode;
  label: string;
  className?: string;
  placement?: "top" | "bottom" | "right" | "right-end";
  size?: "compact" | "regular";
}

/** Accessible hover/focus/tap information tooltip used by financial values. */
export const InfoTooltip = ({
  content,
  label,
  className = "",
  placement = "top",
  size = "compact",
}: InfoTooltipProps) => {
  const { isDark } = useTheme();
  const placementClass = placement === "right-end"
    ? "right-0 top-[22px] xl:bottom-0 xl:left-[22px] xl:right-auto xl:top-auto"
    : placement === "right"
    ? "right-0 top-[22px] xl:left-[22px] xl:right-auto xl:top-0"
    : placement === "bottom"
      ? "left-1/2 top-[22px] -translate-x-1/2"
      : "bottom-[22px] left-1/2 -translate-x-1/2";

  return (
    <span className={`group relative inline-flex shrink-0 items-center ${className}`}>
      <button
        type="button"
        aria-label={label}
        className={`flex h-[15px] w-[15px] items-center justify-center rounded-full border text-[9px] font-bold leading-none outline-none transition-colors ${
          isDark
            ? "border-[#555555] text-[#A7A7A7] hover:border-[#8B5CF6] hover:text-white focus-visible:border-[#8B5CF6]"
            : "border-[#B8B8B8] text-[#777777] hover:border-[#703AE6] hover:text-[#703AE6] focus-visible:border-[#703AE6]"
        }`}
      >
        i
      </button>
      <span
        role="tooltip"
        className={`pointer-events-none absolute ${placementClass} z-[70] w-max border text-left font-medium opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${
          size === "regular"
            ? "max-w-[290px] rounded-lg px-3 py-2 text-[11px] leading-[1.5] shadow-xl"
            : "max-w-[240px] rounded-md px-2.5 py-1.5 text-[10px] leading-[1.4] shadow-lg"
        } ${
          isDark
            ? "border-[#3A3A3A] bg-[#252525] text-[#E5E5E5]"
            : "border-[#E5E7EB] bg-white text-[#374151]"
        }`}
      >
        {content}
      </span>
    </span>
  );
};
