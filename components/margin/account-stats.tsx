"use client";

import { motion } from "framer-motion";
import Image from "next/image";
import { useTheme } from "@/contexts/theme-context";

export interface AccountStatItem {
  id: string;
  name: string;
  icon: string;
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
}: AccountStatsProps) => {
  const { isDark } = useTheme();
  const calculatedGridRows = gridRows || "";

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
      {/* Mobile/Small-tablet: 2x2 grid (< 768px) */}
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
              <p
                className={`text-[11px] font-medium mb-1 ${
                  isDark ? "text-[#919191]" : "text-[#919191]"
                }`}
              >
                {item.name}
              </p>
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

      {/* Tablet/Desktop: grid layout (768px+) */}
      <div
        className={`hidden md:grid border rounded-2xl w-full h-auto overflow-hidden ${gridCols} ${calculatedGridRows} ${
          isDark ? `bg-[${darkBackgroundColor}]` : `bg-[${backgroundColor}]`
        }`}
      >
        {items.map((item, idx) => {
          const raw = values[item.id];
          const displayValue = (!raw || raw === "-") ? "0" : raw;
          return (
            <motion.article
              className="flex flex-col justify-center items-center gap-2.5 px-4 w-full col-span-1 h-[150px]"
              key={item.id}
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ duration: 0.3, delay: idx * 0.06, ease: "easeOut" }}
            >
              {/* Icon + label row */}
              <div className="flex items-center gap-2 justify-center w-full">
                <div
                  className={`w-7 h-7 flex items-center justify-center rounded-full shrink-0 ${
                    isDark ? "bg-[#1A1A1A]" : "bg-white"
                  }`}
                >
                  <Image width={14} height={14} alt={item.id} src={item.icon} />
                </div>
                <span
                  className={`text-[13px] font-medium leading-tight text-center ${
                    isDark ? "text-[#A0A0A0]" : "text-[#6B7280]"
                  }`}
                >
                  {item.name}
                </span>
              </div>
              {/* Value */}
              <motion.div
                className={`text-[26px] font-bold leading-none text-center ${
                  valueColors?.[item.id] ?? (isDark ? "text-white" : "text-[#111111]")
                }`}
                initial={{ opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 0.3, delay: idx * 0.06 + 0.15 }}
              >
                {loading ? renderShimmer("h-7 w-24") : displayValue}
              </motion.div>
            </motion.article>
          );
        })}
      </div>
    </>
  );
};
