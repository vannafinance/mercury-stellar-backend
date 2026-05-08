"use client";

import { motion } from "framer-motion";
import { useTheme } from "@/contexts/theme-context";

export type PreviewTone = "default" | "positive" | "negative";

export interface PreviewRow {
  label: string;
  /** Pre-formatted "before" value (e.g. "$174.48", "2.00", "∞"). Omit for a static single-value row. */
  before?: string;
  /** Pre-formatted "after" value (or the single value when `before` is omitted). */
  after: string;
  /** Optional colour hint for the after-value (e.g. green for HF improving). */
  tone?: PreviewTone;
}

interface MarginActionPreviewProps {
  /** Heading shown at the top of the panel (e.g. "Transaction Details"). */
  title?: string;
  /** Rows rendered as `label  before → after`. */
  rows: PreviewRow[];
  className?: string;
}

/**
 * Generic before/after preview panel used across Repay and Transfer
 * Collateral flows. The caller pre-formats every value (currency, ratio,
 * sentinel like "∞") so this component stays presentation-only.
 */
export const MarginActionPreview = ({
  title = "Transaction Details",
  rows,
  className = "",
}: MarginActionPreviewProps) => {
  const { isDark } = useTheme();

  const cardClass = isDark
    ? "bg-[#1A1A1A] border-[#2A2A2A]"
    : "bg-white border-[#E8E8E8]";
  const titleClass = isDark ? "text-[#A7A7A7]" : "text-[#777777]";
  const labelClass = isDark ? "text-[#919191]" : "text-[#76737B]";
  const beforeClass = isDark ? "text-[#666666]" : "text-[#A7A7A7]";
  const afterClass = isDark ? "text-white" : "text-[#111111]";
  const arrowClass = isDark ? "text-[#555555]" : "text-[#BFBFBF]";

  const toneClass = (tone?: PreviewTone) => {
    if (tone === "positive") return "text-emerald-500";
    if (tone === "negative") return "text-rose-500";
    return afterClass;
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.2 }}
      className={`w-full rounded-xl border p-3 sm:p-4 flex flex-col gap-2 ${cardClass} ${className}`}
    >
      <div className={`text-[12px] font-semibold uppercase tracking-wide ${titleClass}`}>
        {title}
      </div>
      <div className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-2">
            <span className={`text-[12px] font-medium ${labelClass}`}>
              {row.label}
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              {row.before !== undefined && (
                <>
                  <span className={`text-[12px] font-medium ${beforeClass}`}>
                    {row.before}
                  </span>
                  <span className={arrowClass} aria-hidden="true">→</span>
                </>
              )}
              <span className={`text-[12px] font-semibold ${toneClass(row.tone)}`}>
                {row.after}
              </span>
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
};
