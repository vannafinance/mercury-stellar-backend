"use client";

import { useTheme } from "@/contexts/theme-context";
import { motion } from "framer-motion";
import { useRef } from "react";
import { DexOption } from "./types";

interface DexSelectorProps {
  dexes: DexOption[];
  selectedDex: string;
  onChange: (dexId: string) => void;
}

export const DexSelector = ({ dexes, selectedDex, onChange }: DexSelectorProps) => {
  const { isDark } = useTheme();
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleWheel = (e: React.WheelEvent) => {
    if (!scrollRef.current) return;
    e.preventDefault();
    scrollRef.current.scrollLeft += e.deltaY;
  };

  if (dexes.length <= 1) return null;

  return (
    <div
      ref={scrollRef}
      className="w-full overflow-x-auto scrollbar-hide"
      onWheel={handleWheel}
    >
      <div className="flex items-center gap-2 px-1 py-1">
        {dexes.map((dex) => {
          const isActive = selectedDex === dex.id;

          return (
            <motion.button
              key={dex.id}
              type="button"
              onClick={() => onChange(dex.id)}
              whileTap={{ scale: 0.95 }}
              className={`relative flex items-center gap-2 px-4 py-2.5 rounded-xl text-[12px] font-semibold leading-[18px] cursor-pointer whitespace-nowrap transition-all shrink-0 ${
                isActive
                  ? isDark
                    ? "bg-[#3D2A6E] text-[#703AE6] border border-[#703AE6]/30"
                    : "bg-[#F1EBFD] text-[#703AE6] border border-[#703AE6]/20"
                  : isDark
                    ? "bg-[#1A1A1A] text-[#A7A7A7] border border-[#2A2A2A] hover:border-[#333333] hover:text-white"
                    : "bg-[#F7F7F7] text-[#777777] border border-[#EEEEEE] hover:border-[#E2E2E2] hover:text-[#111111]"
              } ${!dex.isAvailable && dex.isAvailable !== undefined ? "opacity-40 cursor-not-allowed" : ""}`}
              disabled={dex.isAvailable === false}
            >
              {/* DEX logo */}
              {dex.logo && (
                <div className="w-4 h-4 rounded-full overflow-hidden shrink-0">
                  <img
                    src={dex.logo}
                    alt={dex.name}
                    className="w-4 h-4 object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                </div>
              )}

              {/* Auto icon for best rate */}
              {dex.id === "auto" && (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path
                    d="M7 1L8.5 5.5L13 7L8.5 8.5L7 13L5.5 8.5L1 7L5.5 5.5L7 1Z"
                    fill={isActive ? "#703AE6" : isDark ? "#777777" : "#A7A7A7"}
                  />
                </svg>
              )}

              <span>{dex.name}</span>

              {/* Tag badge */}
              {dex.tag && isActive && (
                <span
                  className={`text-[9px] font-semibold leading-none px-1.5 py-0.5 rounded-full ${
                    isDark ? "bg-[#703AE6]/20 text-[#BDA4F4]" : "bg-[#703AE6]/10 text-[#703AE6]"
                  }`}
                >
                  {dex.tag}
                </span>
              )}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
};
