"use client";

import { motion } from "framer-motion";
import { useState } from "react";
import { useTheme } from "@/contexts/theme-context";

export interface TabItem {
  id: string;
  label: string;
  shortLabel?: string;
}

type TabType = "gradient" | "solid" | "underline" | "ghost" | "ghost-compact" | "segment" | "border";

type ShortLabelBreakpoint = "sm" | "md" | "lg" | "xl" | "2xl";

interface AnimatedTabsProps {
  tabs: TabItem[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  type?: TabType;
  containerClassName?: string;
  tabClassName?: string;
  indicatorClassName?: string;
  customTabWidth?: string; // Custom width for tabs (e.g., "w-[200px]")
  /** Below this breakpoint, render `tab.shortLabel` (if provided) instead of `tab.label`. Defaults to "sm". Only applied by the "border" variant. */
  shortLabelBelow?: ShortLabelBreakpoint;
}

// Literal class pairs so Tailwind's JIT picks them up. First entry shows on
// narrow viewports, second on wide.
const SHORT_LABEL_CLASSES: Record<ShortLabelBreakpoint, readonly [string, string]> = {
  sm: ["sm:hidden", "hidden sm:inline"],
  md: ["md:hidden", "hidden md:inline"],
  lg: ["lg:hidden", "hidden lg:inline"],
  xl: ["xl:hidden", "hidden xl:inline"],
  "2xl": ["2xl:hidden", "hidden 2xl:inline"],
};

const HOVER_GRADIENT = "linear-gradient(135deg, rgba(112, 58, 230, 0.08) 0%, rgba(112, 58, 230, 0.04) 100%)";
const SPRING_CONFIG = {
  type: "spring" as const,
  stiffness: 300,
  damping: 30,
  mass: 0.8,
};

export const AnimatedTabs = ({
  tabs,
  activeTab,
  onTabChange,
  type = "gradient",
  containerClassName = "",
  tabClassName = "",
  indicatorClassName = "",
  customTabWidth,
  shortLabelBelow = "sm",
}: AnimatedTabsProps) => {
  const [shortCls, longCls] = SHORT_LABEL_CLASSES[shortLabelBelow];
  const [hoveredTab, setHoveredTab] = useState<string | null>(null);
  const { isDark } = useTheme();
  const currentIndex = tabs.findIndex((tab) => tab.id === activeTab);
  const indicatorWidth = `calc((100% - 12px) / ${tabs.length})`;

  // Helper to get text color
  const getTextColor = (isActive: boolean, isHovered: boolean) => {
    if (type === "solid" && isActive) return "#FFFFFF";
    if (type === "ghost") {
      if (isActive) return "#703AE6";
      if (isDark) {
        return "#FFFFFF"; // Inactive ghost tabs: white in dark mode
      }
      return "#64748b"; // Inactive ghost tabs: gray in light mode
    }
    if (type === "underline") {
      if (isActive) return "#703AE6";
      if (isDark) {
        if (isHovered && !isActive) return "#C7C7C7";
        return "#FFFFFF";
      }
      if (isHovered) return "#000000";
      return "#A7A7A7";
    }
    if (type === "gradient" || type === "solid") {
      if (isDark) return "#FFFFFF";
      if (isActive || isHovered) return "#000000";
      return "#64748b";
    }
    if (isActive || isHovered) return "#000000";
    return "#64748b";
  };

  // Helper to get background color
  const getBackground = (isActive: boolean, isHovered: boolean) => {
    if (isHovered && !isActive) return HOVER_GRADIENT;
    if (type === "solid" && isActive) return "#703AE6";
    if (type === "ghost" && isActive) return "#F1EBFD";
    return "transparent";
  };

  

  // Render underline type
  if (type === "underline") {
    return (
      <div className={`h-fit overflow-x-auto scrollbar-hide ${containerClassName}`}>
        <div className="flex min-w-max" onMouseLeave={() => setHoveredTab(null)}>
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            const isHovered = hoveredTab === tab.id;

            return (
              <motion.div
                key={tab.id}
                onClick={() => onTabChange(tab.id)}
                onMouseEnter={() => setHoveredTab(tab.id)}
                className={`whitespace-nowrap px-3 py-2.5 text-[13px] font-semibold flex items-center justify-center cursor-pointer relative ${tabClassName}`}
                animate={{
                  color: getTextColor(isActive, isHovered),
                  borderBottomWidth: isActive ? "2px" : "0px",
                  borderBottomColor: isActive ? "#703AE6" : "transparent",
                }}
                whileTap={{ scale: 0.95 }}
                transition={{ duration: 0.2 }}
              >
                {tab.label}
              </motion.div>
            );
          })}
        </div>
      </div>
    );
  }

  

  // Render segment type
  if (type === "segment") {
    return (
      <div className={`flex gap-4 rounded-xl p-1.5 ${isDark ? "border border-[#333333] bg-[#111111]" : "border border-[#E2E2E2] bg-white"} ${containerClassName}`}>
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              className={`cursor-pointer flex-1 rounded-lg p-0.5 text-[12px] font-semibold transition-colors ${isActive ? "bg-linear-to-r from-[#FC5457] to-[#703AE6]" : "bg-transparent"}`}
            >
              <div className={`rounded-lg p-3 ${isDark ? "bg-[#111111] text-[#FFFFFF]" : "bg-white text-black"}`}>
                {tab.label}
              </div>
            </button>
          );
        })}
      </div>
    );
  }

  // Render ghost-compact type
  if (type === "ghost-compact") {
    return (
      <div
        className={`flex gap-1 ${isDark ? "bg-[#222222]" : "bg-white"} p-1 rounded-lg w-full overflow-x-auto ${containerClassName}`}
        onMouseLeave={() => setHoveredTab(null)}
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          const isHovered = hoveredTab === tab.id;
          return (
            <motion.button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              onMouseEnter={() => setHoveredTab(tab.id)}
              className={`cursor-pointer px-2 md:px-4 min-h-[39px] py-2 rounded-lg text-[12px] font-semibold text-center whitespace-nowrap ${tabClassName}`}
              animate={{
                backgroundColor: isActive
                  ? isDark ? "#3D2A6E" : "#F1EBFD"
                  : isHovered
                    ? isDark ? "rgba(61, 42, 110, 0.5)" : "rgba(241, 235, 253, 0.5)"
                    : "transparent",
                color: isActive
                  ? isDark ? "#B794F6" : "#703AE6"
                  : isDark ? "#FFFFFF" : "#111111",
              }}
              whileTap={{ scale: 0.95 }}
              transition={{ duration: 0.2 }}
            >
              {tab.label}
            </motion.button>
          );
        })}
      </div>
    );
  }

  // Render border type — gradient border on active tab via background-clip trick
  if (type === "border") {
    const bgColor = isDark ? "#222222" : "#ffffff";
    return (
      <div className={`flex w-full gap-0 ${containerClassName}`}>
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <motion.div
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`h-12 px-4 flex items-center justify-center text-center text-[14px] font-semibold rounded-lg whitespace-nowrap cursor-pointer transition-colors ${
                isActive
                  ? isDark ? "text-[#F0F0F0]" : "text-[#1F1F1F]"
                  : "text-[#9CA3AF]"
              } ${tabClassName}`}
              style={
                isActive
                  ? {
                      background: `linear-gradient(${bgColor}, ${bgColor}) padding-box, linear-gradient(135deg, #FC5457 10%, #703AE6 80%) border-box`,
                      border: "1.70px solid transparent",
                    }
                  : {}
              }
              whileTap={{ scale: 0.95 }}
              transition={{ duration: 0.15 }}
            >
              {tab.shortLabel ? (
                <>
                  <span className={shortCls}>{tab.shortLabel}</span>
                  <span className={longCls}>{tab.label}</span>
                </>
              ) : tab.label}
            </motion.div>
          );
        })}
      </div>
    );
  }

  // Render gradient/solid/ghost types
  const containerPadding = type === "solid" || type === "ghost" ? "p-[4px] w-fit h-fit" : "p-1";
  const containerWidth = type === "solid" || type === "ghost" ? "w-full" : "w-full";
  const tabWidth = customTabWidth
    ? customTabWidth
    : type === "solid"
      ? "w-[160px]"
      : type === "ghost"
        ? "w-[180px]"
        : "";
  const tabPadding = type === "solid" || type === "ghost" ? "py-[12px] px-[8px]" : "";
  const tabHeight = type === "solid" ? "h-fit" : type === "ghost" ? "h-[38px]" : "h-9";
  const useFlex1 = type !== "solid" && type !== "ghost";

  return (
    <div className={containerClassName}>
      <div
        className={`border ${containerWidth} flex gap-4 ${containerPadding} rounded-xl h-fit relative overflow-hidden ${
          isDark ? "bg-[#111111]" : "bg-white"
        }`}
        onMouseLeave={() => setHoveredTab(null)}
      >
        {/* Gradient indicator */}
        {type === "gradient" && (
          <motion.div
            className={`absolute top-1 left-1 h-9 rounded-xl bg-gradient p-0.5 ${indicatorClassName}`}
            style={{ width: indicatorWidth }}
            animate={{ x: `${currentIndex * 100}%` }}
            transition={SPRING_CONFIG}
          >
            <div className={`rounded-xl h-full w-full ${isDark ? "bg-[#111111]" : "bg-white"}`} />
          </motion.div>
        )}

        {/* Tab buttons */}
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          const isHovered = hoveredTab === tab.id;

          return (
            <motion.div
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              onMouseEnter={() => setHoveredTab(tab.id)}
              className={`${tabWidth} ${tabPadding} hover:cursor-pointer text-[13px] font-semibold flex flex-col justify-center text-center ${tabHeight} rounded-[10px] ${useFlex1 ? "flex-1" : ""} relative z-10 ${tabClassName}`}
              animate={{
                color: getTextColor(isActive, isHovered),
                background: getBackground(isActive, isHovered),
              }}
              whileTap={{ scale: 0.95 }}
              transition={{ duration: 0.2 }}
            >
              {tab.label}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
};
