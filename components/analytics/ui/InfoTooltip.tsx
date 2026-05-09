"use client";

import { cn } from "@/lib/analytics/utils";

/**
 * Inline info icon with hover tooltip.
 * Two sizes: "sm" (13px, for KPI titles) and "md" (15px, for section/table headings).
 */
export default function InfoTooltip({
  text,
  size = "sm",
}: {
  text: string;
  size?: "sm" | "md";
}) {
  const dim = size === "sm" ? "w-[13px] h-[13px] text-[7px]" : "w-[15px] h-[15px] text-[8px]";

  return (
    <div className="relative group inline-flex items-center justify-center">
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-full border border-vgray-300 font-bold text-vgray-400 cursor-help leading-none select-none hover:border-violet-400 hover:text-violet-500 transition-colors",
          dim,
        )}
      >
        i
      </span>
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-52 px-3 py-2 rounded-lg bg-vgray-50 border border-vgray-200 text-vgray-700 text-[11px] leading-relaxed shadow-lg opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity duration-150 z-50">
        {text}
        <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-x-[5px] border-x-transparent border-t-[5px] border-t-vgray-50" />
      </div>
    </div>
  );
}
