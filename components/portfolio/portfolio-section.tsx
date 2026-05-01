"use client";

import { useState, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useUserStore } from "@/store/user";
import { useTheme } from "@/contexts/theme-context";
import { Button } from "../ui/button";
import { AccountStats } from "../margin/account-stats";
import { ReusableChart } from "../ui/reusable-chart";
import { AnimatedTabs } from "../ui/animated-tabs";
import { PORTFOLIO_STATS_ITEMS } from "@/lib/constants/portfolio";
import { LenderTab } from "./lender-tab";
import { TraderTab } from "./trader-tab";

const PORTFOLIO_TABS = [
  { id: "lender", label: "Lender" },
  { id: "trader", label: "Trader" },
];

const TIME_FILTERS = ["3 months", "6 months", "1 year", "All Time"] as const;

const MOCK_EARNINGS_DATA: Record<string, number> = {
  "2025-08-01": 8420,
  "2025-08-08": 9050,
  "2025-08-15": 9780,
  "2025-08-22": 10200,
  "2025-08-29": 9820,
  "2025-09-05": 10450,
  "2025-09-12": 11100,
  "2025-09-19": 11720,
  "2025-09-26": 12280,
  "2025-10-03": 12050,
  "2025-10-10": 12680,
  "2025-10-17": 13240,
  "2025-10-24": 13680,
  "2025-10-31": 13920,
};

const MOCK_VOLUME_DATA: Record<string, number> = {
  "2025-08-01": 43200,
  "2025-08-08": 52800,
  "2025-08-15": 61400,
  "2025-08-22": 58200,
  "2025-08-29": 69800,
  "2025-09-05": 78400,
  "2025-09-12": 88200,
  "2025-09-19": 84600,
  "2025-09-26": 96400,
  "2025-10-03": 108200,
  "2025-10-10": 118800,
  "2025-10-17": 114200,
  "2025-10-24": 128600,
  "2025-10-31": 142400,
};

interface PortfolioChartCardProps {
  title: string;
  value: string;
  data: Record<string, number>;
  isDark: boolean;
}

const PortfolioChartCard = ({
  title,
  value,
  data,
  isDark,
}: PortfolioChartCardProps) => {
  const [timeFilter, setTimeFilter] = useState<string>("All Time");
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isChartOpen, setIsChartOpen] = useState(false);

  const formatYAxisLabel = useCallback((val: number) => {
    if (val >= 1000) return `${(val / 1000).toFixed(0)}k USD`;
    return `${val} USD`;
  }, []);

  const chartColors: [string, string] = useMemo(
    () => ["rgba(112, 58, 230, 0.18)", "rgba(112, 58, 230, 0.02)"],
    [],
  );

  return (
    <>
      {/* Desktop: full card */}
      <div
        className={`hidden sm:flex w-full min-w-0 rounded-[16px] border-[1px] p-[20px] flex-col gap-3 ${
          isDark ? "bg-[#111111] border-[#333]" : "bg-white border-[#e2e2e2]"
        }`}
      >
        <div className="flex items-start justify-between">
          <div>
            <p className={`text-[13px] font-medium ${isDark ? "text-[#919191]" : "text-[#5c5b5b]"}`}>
              {title}
            </p>
            <p className={`text-[20px] font-bold ${isDark ? "text-white" : "text-[#111]"}`}>
              {value}
            </p>
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
              className={`h-[34px] px-[12px] rounded-[8px] border-[1px] text-[13px] font-medium cursor-pointer flex items-center gap-[6px] ${
                isDark
                  ? "bg-[#1a1a1a] border-[#333] text-white"
                  : "bg-white border-[#e2e2e2] text-[#111]"
              }`}
            >
              {timeFilter}
              <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
                <path d="M1 1L5 5L9 1" stroke={isDark ? "#fff" : "#111"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {isDropdownOpen && (
              <div
                className={`absolute right-0 top-[38px] z-10 rounded-[8px] border-[1px] py-[4px] min-w-[120px] ${
                  isDark ? "bg-[#1a1a1a] border-[#333]" : "bg-white border-[#e2e2e2]"
                }`}
              >
                {TIME_FILTERS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => { setTimeFilter(f); setIsDropdownOpen(false); }}
                    className={`w-full text-left px-[12px] py-[6px] text-[12px] font-medium cursor-pointer transition ${
                      f === timeFilter ? "text-[#703ae6]" : isDark ? "text-white hover:bg-[#333]" : "text-[#111] hover:bg-[#f7f7f7]"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="w-full min-w-0">
          <ReusableChart
            data={data}
            gradientColors={chartColors}
            lineColor="#703ae6"
            height={220}
            showGrid={true}
            showVertGrid={false}
            gridColor={isDark ? "rgba(226, 226, 226, 0.1)" : "rgba(226, 226, 226, 0.5)"}
            formatYAxisLabel={formatYAxisLabel}
            textColor={isDark ? "#919191" : "#5c5b5b"}
          />
        </div>
      </div>

      {/* Mobile: collapsible card */}
      <div
        className={`sm:hidden w-full rounded-2xl border overflow-hidden transition-colors ${
          isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]"
        }`}
      >
        <button
          type="button"
          onClick={() => setIsChartOpen((prev) => !prev)}
          className="w-full flex items-center justify-between p-3 cursor-pointer"
        >
          <div className="flex flex-col gap-0.5 text-left">
            <span className={`text-[11px] font-medium leading-[18px] ${isDark ? "text-[#A7A7A7]" : "text-[#777777]"}`}>
              {title}
            </span>
            <span className={`text-[17px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
              {value}
            </span>
          </div>
          <motion.div
            animate={{ rotate: isChartOpen ? 180 : 0 }}
            transition={{ duration: 0.25 }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={isDark ? "#A7A7A7" : "#777777"} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </motion.div>
        </button>

        <AnimatePresence initial={false}>
          {isChartOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: "easeInOut" }}
              className="overflow-hidden"
            >
              <div className="pb-2 px-1">
                <ReusableChart
                  data={data}
                  gradientColors={chartColors}
                  lineColor="#703ae6"
                  height={180}
                  showGrid={true}
                  showVertGrid={false}
                  gridColor={isDark ? "rgba(226, 226, 226, 0.1)" : "rgba(226, 226, 226, 0.5)"}
                  textColor={isDark ? "#919191" : "#5c5b5b"}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
};

export const PortfolioSection = () => {
  const userAddress = useUserStore((user) => user.address);
  const { isDark } = useTheme();
  const [activeTab, setActiveTab] = useState("lender");

  const statsValues = {
    totalPortfolioBalance: userAddress ? "$1,000.00" : "-",
    netAvailableCollateral: userAddress ? "$1,000.00" : "-",
    marginAccountBalance: userAddress ? "$600.00" : "-",
    availablePortfolioBalance: userAddress ? "$600.00" : "-",
  };

  return (
    <div className="w-full h-fit flex flex-col gap-[16px]">
      {/* Stats grid */}
      <AccountStats
        gridCols="grid-cols-4"
        items={PORTFOLIO_STATS_ITEMS}
        values={statsValues}
      />

      {/* Charts row */}
      <div className="w-full h-fit flex flex-col md:flex-row gap-4 md:gap-[16px]">
        <PortfolioChartCard
          title="Net Earnings"
          value="$ 2000 USD"
          data={MOCK_EARNINGS_DATA}
          isDark={isDark}
        />
        <PortfolioChartCard
          title="Net Volume"
          value="$ 2000 USD"
          data={MOCK_VOLUME_DATA}
          isDark={isDark}
        />
      </div>

      {/* Tabs */}
      <div className="w-full h-fit flex flex-col">
        <AnimatedTabs
          type="underline"
          tabs={PORTFOLIO_TABS}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          containerClassName="w-fit"
          tabClassName="h-[40px] sm:h-[44px] text-[13px] sm:text-[14px] w-[100px] sm:w-[120px]"
        />

        {!userAddress ? (
          <div
            className={`w-full h-[260px] rounded-b-[20px] flex items-center justify-center ${
              isDark ? "bg-[#222222]" : "bg-[#F7F7F7]"
            }`}
          >
            <div className="w-[70px]">
              <Button text="Login" size="small" type="solid" disabled={false} />
            </div>
          </div>
        ) : (
          <div className="w-full h-fit pt-4 sm:pt-[16px]">
            {activeTab === "lender" && <LenderTab />}
            {activeTab === "trader" && <TraderTab />}
          </div>
        )}
      </div>
    </div>
  );
};
