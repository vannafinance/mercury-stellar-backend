"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { ReusableChart } from "@/components/ui/reusable-chart";
import { Table } from "@/components/earn/table";
import { useTheme } from "@/contexts/theme-context";
import { farmTableHeadings } from "@/lib/constants/farm";

const FARMING_INFO_STATS = [
  { label: "Your Total Asset Supplied\nto Farm(USD)", value: "$123,122",  positive: null  },
  { label: "Overall Farm TVL(USD)",                   value: "$150,712",  positive: null  },
  { label: "Percentage of Your Margin\nAllocated to Farm(%)", value: "-29.06%", positive: false },
  { label: "Unrealised P&L",                          value: "-$8.31",    positive: false },
  { label: "Realised P&L",                            value: "$72.02",    positive: true  },
  { label: "Farm Volume",                             value: "$72.02",    positive: null  },
] as const;

const CHART_FILTER_TABS = ["Total Equity", "Cumulative PnL", "PnL", "Return Percentage"] as const;

const ChevronDown = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const FarmSection = () => {
  const { isDark } = useTheme();
  const [activeChartFilter, setActiveChartFilter] = useState("Total Equity");
  const [timeFilter, setTimeFilter] = useState("All Time");
  const [isTimeDropdownOpen, setIsTimeDropdownOpen] = useState(false);
  const [activeFilterTab, setActiveFilterTab] = useState("current-position");
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const [chartHeight, setChartHeight] = useState(280);

  useEffect(() => {
    const el = chartContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (h && h > 0) setChartHeight(Math.floor(h));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const filterTabTypeOptions = [
    { id: "current-position", label: "Current Position" },
    { id: "position-history", label: "Position History" },
  ];

  const tableData = useMemo(() => ({
    headings: farmTableHeadings,
    body: { rows: [] as any[] },
  }), []);

  const handleFilterTabChange = useCallback((tabId: string) => {
    setActiveFilterTab(tabId);
  }, []);

  return (
    <div className="w-full h-fit flex flex-col gap-[20px]">
      {/* Info + Chart row */}
      <div className="w-full flex flex-col lg:flex-row gap-4 sm:gap-[20px] lg:h-[420px]">

        {/* Farming Info panel */}
        <div className={`w-full lg:w-[422px] flex-shrink-0 flex flex-col rounded-xl border overflow-hidden ${
          isDark ? "bg-[#222222] border-[#333333]" : "bg-[#F7F7F7] border-[#E5E7EB]"
        }`}>
          <div className={`px-5 pt-5 pb-4 border-b flex-shrink-0 ${isDark ? "border-[#333333]" : "border-[#e5e7eb]"}`}>
            <h3 className={`text-[16px] font-bold ${isDark ? "text-white" : "text-[#0f172a]"}`}>Farming Info</h3>
          </div>
          <div className="flex flex-col overflow-y-auto px-5 pb-5">
            {FARMING_INFO_STATS.map(({ label, value, positive }) => (
              <div key={label} className="flex justify-between items-center py-[10px]">
                <span className={`text-[14px] font-medium tracking-[0.01em] ${isDark ? "text-[#919191]" : "text-[#6b7280]"}`}>
                  {label}
                </span>
                <span className={`text-[14px] font-semibold flex-shrink-0 ${
                  positive === true ? "text-[#16a34a]"
                  : positive === false ? "text-[#dc2626]"
                  : isDark ? "text-white" : "text-[#0f172a]"
                }`}>
                  {value}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Chart panel */}
        <div className={`flex-1 min-w-0 flex flex-col gap-4 rounded-[16px] border p-5 ${
          isDark ? "bg-[#1a1a1a] border-[#333]" : "bg-white border-[#e2e2e2]"
        }`}>
          <div className="flex items-center justify-between flex-shrink-0 gap-2">
            <div className="flex items-center gap-[4px] flex-wrap">
              {CHART_FILTER_TABS.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveChartFilter(tab)}
                  className={`h-[40px] px-[12px] py-[8px] rounded-[8px] text-[12px] font-semibold cursor-pointer transition whitespace-nowrap ${
                    activeChartFilter === tab
                      ? "bg-[#f1ebfd] text-[#703ae6]"
                      : isDark ? "bg-transparent text-white hover:bg-[#333]" : "bg-white text-[#111] hover:bg-[#f7f7f7]"
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
            <div className="relative">
              <button
                type="button"
                onClick={() => setIsTimeDropdownOpen(!isTimeDropdownOpen)}
                className={`h-[40px] pl-[8px] pr-[12px] flex items-center gap-[4px] rounded-[8px] border-[1px] text-[13px] font-medium cursor-pointer transition ${
                  isDark ? "bg-[#1a1a1a] border-[#333] text-white hover:bg-[#222]" : "bg-white border-[#e2e2e2] text-[#111] hover:bg-[#f7f7f7]"
                }`}
              >
                {timeFilter}
                <ChevronDown />
              </button>
              {isTimeDropdownOpen && (
                <div className={`absolute right-0 top-[44px] z-10 rounded-[8px] border-[1px] py-[4px] min-w-[120px] ${
                  isDark ? "bg-[#1a1a1a] border-[#333]" : "bg-white border-[#e2e2e2]"
                }`}>
                  {["All Time", "3 Months", "6 Months", "1 Year"].map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => { setTimeFilter(f); setIsTimeDropdownOpen(false); }}
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

          <div ref={chartContainerRef} className="flex-1 min-h-0 overflow-hidden rounded-xl">
            <ReusableChart
              data={{
                "2025-08-01": 22100,
                "2025-08-08": 22680,
                "2025-08-15": 23280,
                "2025-08-22": 23900,
                "2025-08-29": 24540,
                "2025-09-05": 25200,
                "2025-09-12": 25880,
                "2025-09-19": 26580,
                "2025-09-26": 27300,
                "2025-10-03": 28040,
                "2025-10-10": 28800,
                "2025-10-17": 29580,
                "2025-10-24": 30380,
                "2025-10-31": 31200,
              }}
              gradientColors={["rgba(112, 58, 230, 0.18)", "rgba(112, 58, 230, 0.02)"]}
              lineColor="#703ae6"
              height={chartHeight}
              showGrid={true}
              showVertGrid={false}
              gridColor={isDark ? "rgba(226, 226, 226, 0.1)" : "rgba(226, 226, 226, 0.5)"}
              textColor={isDark ? "#919191" : "#5c5b5b"}
            />
          </div>
        </div>
      </div>

      {/* Positions Table */}
      <Table
        filterDropdownPosition="left"
        heading={{
          heading: "Positions Table",
          tabType: "solid",
        }}
        filters={{
          allChainDropdown: true,
          filters: [],
          filterTabType: "solid",
        }}
        filterTabTypeOptions={filterTabTypeOptions}
        activeFilterTab={activeFilterTab}
        onFilterTabTypeChange={handleFilterTabChange}
        tableHeadings={tableData.headings}
        tableBody={tableData.body}
      />
    </div>
  );
};
