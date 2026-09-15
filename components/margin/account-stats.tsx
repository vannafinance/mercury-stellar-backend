"use client";

import { motion } from "framer-motion";
import Image from "next/image";
import { useTheme } from "@/contexts/theme-context";
import { InfoTooltip } from "@/components/ui/info-tooltip";

export interface AccountStatItem {
  id: string;
  name: string;
  icon: string;
  tooltip?: string;
}

interface AccountStatsProps {
  items: readonly AccountStatItem[];
  values: Record<string, string | number | null | undefined>;
  /**
   * Optional per-item Tailwind class overrides for the value text. Lets the
   * parent color a stat (e.g. green/red for P&L) without leaking domain rules
   * into this generic renderer.
   */
  valueColors?: Record<string, string>;
  gridCols?: string;
  gridRows?: string;
  backgroundColor?: string;
  darkBackgroundColor?: string;
  // When true, every value renders a shimmer placeholder (Uniswap/Aave style)
  // instead of a number — so a not-yet-loaded account shows a skeleton rather
  // than a misleading "0" or a spinner.
  loading?: boolean;
  /**
   * Five-up KPI strip: one row on tablet/desktop with smaller type so all
   * items (e.g. Net Leverage Taken) fit horizontally instead of wrapping.
   */
  compact?: boolean;
}

export const AccountStats = ({
  items,
  values,
  valueColors,
  gridCols = "grid-cols-1 sm:grid-cols-2 md:grid-cols-3",
  gridRows,
  backgroundColor = "#F7F7F7",
  darkBackgroundColor = "#222222",
  loading = false,
  compact = false,
}: AccountStatsProps) => {
  const { isDark } = useTheme();
  const calculatedGridRows = gridRows || "";
  // Five KPI items (incl. Net Leverage Taken) always render as one desktop row.
  // Inline style bypasses any Tailwind class-scan misses for grid-cols-5.
  const fiveUp = compact || items.length >= 5;
  const desktopGrid = fiveUp ? "grid-cols-5" : gridCols;

  const renderShimmer = (className: string) => (
    <span
      className={`inline-block rounded animate-pulse ${className} ${
        isDark ? "bg-[#3a3a3a]" : "bg-[#E5E7EB]"
      }`}
      aria-hidden="true"
    />
  );

  return (
    <>
      {/* Mobile: 2-col wrap (< 768px) */}
      <div className="md:hidden w-full grid grid-cols-2 gap-2">
        {items.filter(item => item.id !== "netProfitAndLoss").map((item, idx, arr) => {
          const raw = values[item.id];
          const displayValue = (!raw || raw === "-") ? "0" : raw;
          return (
            <motion.article
              key={item.id}
              className={`rounded-2xl p-3 border ${
                idx === arr.length - 1 && arr.length % 2 !== 0 ? "col-span-2" : ""
              } ${
                isDark ? `bg-[${darkBackgroundColor}]` : `bg-[${backgroundColor}]`
              }`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: idx * 0.06 }}
            >
              <div
                className={`w-6 h-6 flex items-center justify-center rounded-full mb-1.5 ${
                  isDark ? "bg-black" : "bg-white"
                }`}
              >
                <Image width={14} height={14} alt={item.id} src={item.icon} />
              </div>
              <div
                className={`flex items-center gap-1 text-[11px] font-medium mb-1 ${
                  isDark ? "text-[#919191]" : "text-[#919191]"
                }`}
              >
                <span>{item.name}</span>
                {item.tooltip && (
                  <InfoTooltip content={item.tooltip} label={`${item.name} information`} placement="bottom" />
                )}
              </div>
              <p
                className={`text-[15px] font-bold leading-tight ${
                  valueColors?.[item.id] ?? (isDark ? "text-white" : "text-neutral-800")
                }`}
              >
                {loading ? renderShimmer("h-4 w-14 align-middle") : displayValue}
              </p>
            </motion.article>
          );
        })}
      </div>

      {/* Tablet/Desktop: single-row grid (768px+) */}
      <div
        className={`hidden md:grid border rounded-2xl w-full h-auto overflow-visible ${desktopGrid} ${calculatedGridRows} ${
          isDark ? `bg-[${darkBackgroundColor}]` : `bg-[${backgroundColor}]`
        }`}
        style={fiveUp ? { gridTemplateColumns: "repeat(5, minmax(0, 1fr))" } : undefined}
      >
        {items.map((item, idx) => {
          const raw = values[item.id];
          const displayValue = (!raw || raw === "-") ? "0" : raw;
          return (
            <motion.article
              className={`flex flex-col justify-center items-center w-full col-span-1 ${
                fiveUp
                  ? "gap-1.5 px-2 py-4 min-h-[120px]"
                  : "gap-2.5 px-4 h-[150px]"
              }`}
              key={item.id}
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ duration: 0.3, delay: idx * 0.06, ease: "easeOut" }}
            >
              {/* Icon + label row */}
              <div className="flex items-center gap-1.5 justify-center w-full px-1">
                <div
                  className={`flex items-center justify-center rounded-full shrink-0 ${
                    fiveUp ? "w-6 h-6" : "w-7 h-7"
                  } ${isDark ? "bg-[#1A1A1A]" : "bg-white"}`}
                >
                  <Image
                    width={fiveUp ? 12 : 14}
                    height={fiveUp ? 12 : 14}
                    alt={item.id}
                    src={item.icon}
                  />
                </div>
                <span
                  className={`font-medium leading-tight text-center ${
                    fiveUp ? "text-[11px]" : "text-[13px]"
                  } ${isDark ? "text-[#A0A0A0]" : "text-[#6B7280]"}`}
                >
                  {item.name}
                </span>
                {item.tooltip && (
                  <InfoTooltip content={item.tooltip} label={`${item.name} information`} placement="bottom" />
                )}
              </div>
              {/* Value */}
              <motion.div
                className={`font-bold leading-none text-center ${
                  fiveUp ? "text-[18px] lg:text-[22px]" : "text-[26px]"
                } ${
                  valueColors?.[item.id] ?? (isDark ? "text-white" : "text-[#111111]")
                }`}
                initial={{ opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 0.3, delay: idx * 0.06 + 0.15 }}
              >
                {loading ? renderShimmer(fiveUp ? "h-5 w-16" : "h-7 w-24") : displayValue}
              </motion.div>
            </motion.article>
          );
        })}
      </div>
    </>
  );
};
