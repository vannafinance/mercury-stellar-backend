"use client";

import { motion } from "framer-motion";
import { useTheme } from "@/contexts/theme-context";

interface ComingSoonCardProps {
  title: string;
  description: string;
  icon: "perps" | "spot" | "deploy";
  accent: string;
  status: "development" | "soon" | "live";
  index: number;
}

const STATUS_LABEL: Record<string, string> = {
  development: "In Development",
  soon: "Coming Soon",
  live: "Live",
};

export const ComingSoonCard = ({ title, description, status, index }: ComingSoonCardProps) => {
  const { isDark } = useTheme();

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: 0.15 + index * 0.08, ease: "easeOut" }}
      className={`flex flex-col w-full border rounded-xl overflow-hidden ${
        isDark ? "bg-[#222222] border-[#333333]" : "bg-[#F7F7F7] border-[#E5E7EB]"
      }`}
    >
      {/* Header row — title + status pill */}
      <div
        className={`flex items-center justify-between px-4 py-3 border-b ${
          isDark ? "border-[#333333]" : "border-[#E5E7EB]"
        }`}
      >
        <h3 className={`text-[13px] font-semibold leading-5 ${isDark ? "text-white" : "text-[#111111]"}`}>
          {title}
        </h3>
        <span
          className={`text-[10px] font-semibold uppercase tracking-[0.5px] px-2 py-0.5 rounded-full ${
            isDark ? "bg-[#2C2C2C] text-[#919191]" : "bg-[#F4F4F4] text-[#6B7280]"
          }`}
        >
          {STATUS_LABEL[status]}
        </span>
      </div>

      {/* Description */}
      <div className="px-4 py-3">
        <p className={`text-[12px] leading-[18px] ${isDark ? "text-[#919191]" : "text-[#6B7280]"}`}>
          {description}
        </p>
      </div>
    </motion.div>
  );
};
