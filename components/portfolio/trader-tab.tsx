"use client";

import { useState, useRef, useEffect } from "react";
import { ReusableChart } from "@/components/ui/reusable-chart";
import { Positionstable } from "@/components/margin/positions-table";
import { FarmSection } from "./farm-section";
import { useTheme } from "@/contexts/theme-context";

const TRADE_TABS = ["Margin", "Spot", "Perps", "Farm"] as const;
type TradeTab = (typeof TRADE_TABS)[number];

const MARGIN_STATS = [
  { id: "totalMarginBalance", label: "Total Margin Balance", value: "$1000" },
  { id: "totalCollateralDeposited", label: "Total Collateral Deposited", value: "$100" },
  { id: "totalLoanTaken", label: "Total Loan Taken", value: "$10" },
  { id: "crossAccountLeverage", label: "Cross Account Leverage", value: "1.6x/10x", special: "leverage" },
  { id: "healthFactor", label: "Health Factor", value: "1.5", special: "gauge" },
  { id: "crossMarginRatio", label: "Cross Margin Ratio", value: "10%" },
  { id: "collateralLeftBeforeLiquidation", label: "Collateral Left Before Liquidation", value: "$10" },
  { id: "netBorrowedInterestAccrued", label: "Net Borrowed Interest Accrued", value: "$10" },
  { id: "marginBalanceAllocation", label: "Margin Balance Allocation", value: "", special: "allocation" },
] as const;

const MARGIN_ALLOCATION = [
  { label: "Spot",   pct: 25, color: "#703ae6" },
  { label: "Perps",  pct: 40, color: "#9d6ef0" },
  { label: "Farm",   pct: 25, color: "#c4a8f8" },
  { label: "Unused", pct: 10, color: "#E5E7EB", darkColor: "#3F3F46" },
];

const MARGIN_INFO = [
  { label: "Unrealised P&L", value: "+$123122", positive: true },
  { label: "Realised P&L", value: "-$150712", positive: false },
  { label: "Sharpe Ratio", value: "-29.06%", positive: false },
  { label: "Max Drawdown", value: "-$8.31", positive: false },
  { label: "Overall Trading Volume", value: "$1M", positive: null },
  { label: "Win Rate", value: "$72.02", positive: null },
  { label: "Total Fees Paid", value: "$2.20", positive: null },
  { label: "Total Fees Rebates Earned", value: "$69.83", positive: null },
];

const CHART_FILTER_TABS = ["Total Equity", "Cumulative PnL", "PnL", "Return Percentage"] as const;

const InfoIcon = ({ isDark }: { isDark: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" className="flex-shrink-0">
    <path
      d="M6 3.33333H7.33333V4.66667H6V3.33333ZM6 6H7.33333V10H6V6ZM6.66667 0C2.98667 0 0 2.98667 0 6.66667C0 10.3467 2.98667 13.3333 6.66667 13.3333C10.3467 13.3333 13.3333 10.3467 13.3333 6.66667C13.3333 2.98667 10.3467 0 6.66667 0ZM6.66667 12C3.72667 12 1.33333 9.60667 1.33333 6.66667C1.33333 3.72667 3.72667 1.33333 6.66667 1.33333C9.60667 1.33333 12 3.72667 12 6.66667C12 9.60667 9.60667 12 6.66667 12Z"
      fill={isDark ? "#A0A0A0" : "#6B7280"}
    />
  </svg>
);

const ChevronDown = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const MarginStatsGrid = ({ isDark }: { isDark: boolean }) => {
  const d = isDark;
  const border = d ? "border-[#2D2D2D]" : "border-[#E5E7EB]";
  const labelClass = `text-[13px] font-medium leading-tight ${d ? "text-[#A0A0A0]" : "text-[#6B7280]"}`;
  const valueClass = `text-[20px] font-bold leading-tight ${d ? "text-white" : "text-[#111]"}`;
  const [hoveredAlloc, setHoveredAlloc] = useState<string | null>(null);
  const [showHFTooltip, setShowHFTooltip] = useState(false);

  const row1 = MARGIN_STATS.slice(0, 4);
  const row2 = MARGIN_STATS.slice(4, 8);

  const renderGauge = (stat: (typeof MARGIN_STATS)[number]) => (
    <div className="flex flex-col gap-2">
      <div className={`flex items-center gap-1 ${labelClass}`}>
        {stat.label}
        <div
          className="relative flex items-center"
          onMouseEnter={() => setShowHFTooltip(true)}
          onMouseLeave={() => setShowHFTooltip(false)}
        >
          <InfoIcon isDark={d} />
          {showHFTooltip && (
            <div
              className={`absolute bottom-[18px] left-1/2 -translate-x-1/2 w-[220px] px-3 py-2 rounded-[8px] text-[12px] leading-[1.5] font-medium shadow-md border z-50 pointer-events-none ${
                d ? "bg-[#2a2a2a] border-[#3a3a3a] text-[#ccc]" : "bg-white border-[#E5E7EB] text-[#374151]"
              }`}
            >
              Measures collateral safety. Values above&nbsp;1.5 are healthy; below&nbsp;1.1 risks liquidation.
            </div>
          )}
        </div>
      </div>
      <span className={valueClass}>{stat.value}</span>
    </div>
  );

  const renderAllocation = () => {
    const segments = MARGIN_ALLOCATION.map((item) => ({
      ...item,
      resolvedColor: "darkColor" in item && d ? (item as any).darkColor : item.color,
    }));
    return (
      <div className="w-full flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 min-w-0">
        <span className={`text-[13px] font-medium whitespace-nowrap shrink-0 ${d ? "text-[#A0A0A0]" : "text-[#6B7280]"}`}>
          Margin Allocation
        </span>
        <div className="w-full sm:flex-1 flex items-center gap-0.5 min-w-0">
          {segments.map(({ label, pct, resolvedColor }) => (
            <div
              key={label}
              className="relative h-[6px] rounded-full cursor-pointer transition-opacity hover:opacity-80"
              style={{ flex: pct, backgroundColor: resolvedColor }}
              onMouseEnter={() => setHoveredAlloc(label)}
              onMouseLeave={() => setHoveredAlloc(null)}
            >
              {hoveredAlloc === label && (
                <div
                  className={`absolute bottom-[10px] left-1/2 -translate-x-1/2 px-[10px] py-[5px] rounded-[8px] shadow-md border whitespace-nowrap z-50 flex items-center gap-[6px] text-[12px] font-semibold pointer-events-none ${
                    d ? "bg-[#2a2a2a] border-[#3a3a3a] text-white" : "bg-white border-[#E5E7EB] text-[#111]"
                  }`}
                >
                  <span className="w-[8px] h-[8px] rounded-full shrink-0 inline-block" style={{ backgroundColor: resolvedColor }} />
                  {label} · {pct}%
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 sm:gap-3 shrink-0 flex-wrap">
          {segments.map(({ label, pct, resolvedColor }) => (
            <div key={label} className="flex items-center gap-[5px]">
              <div className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full shrink-0" style={{ backgroundColor: resolvedColor }} />
              <span className={`text-[11px] sm:text-[12px] font-medium ${d ? "text-[#919191]" : "text-[#6B7280]"}`}>{label}</span>
              <span className={`text-[11px] sm:text-[12px] font-bold ${d ? "text-white" : "text-[#111]"}`}>{pct}%</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderCell = (stat: (typeof MARGIN_STATS)[number]) => {
    if ((stat as any).special === "gauge") return renderGauge(stat);
    if ((stat as any).special === "allocation") return renderAllocation();
    if ((stat as any).special === "leverage") {
      const [current, max] = stat.value.split("/");
      return (
        <div className="flex flex-col gap-2">
          <span className={labelClass}>{stat.label}</span>
          <div className="flex items-baseline gap-1">
            <span className={valueClass}>{current}</span>
            <span className={`text-[14px] font-medium ${d ? "text-[#A0A0A0]" : "text-[#6B7280]"}`}>/ {max}</span>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-2">
        <span className={labelClass}>{stat.label}</span>
        <span className={valueClass}>{stat.value}</span>
      </div>
    );
  };

  return (
    <div className={`w-full rounded-[16px] overflow-hidden border ${border} ${d ? "bg-[#222222]" : "bg-[#f7f7f7]"}`}>
      <div className="grid grid-cols-2 lg:grid-cols-4">
        {row1.map((stat) => (
          <div key={stat.id} className="flex flex-col gap-2 px-5 py-4">
            {renderCell(stat as any)}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4">
        {row2.map((stat) => (
          <div key={stat.id} className="flex flex-col px-5 py-4">
            {renderCell(stat as any)}
          </div>
        ))}
      </div>
      <div className={`flex items-center px-5 py-[14px] border-t ${border}`}>
        {renderAllocation()}
      </div>
    </div>
  );
};

export const TraderTab = () => {
  const { isDark } = useTheme();
  const [activeSubTab, setActiveSubTab] = useState<TradeTab>("Margin");
  const [activeChartFilter, setActiveChartFilter] = useState("Total Equity");
  const [timeFilter, setTimeFilter] = useState("All Time");
  const [isTimeDropdownOpen, setIsTimeDropdownOpen] = useState(false);
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

  const subTabBase = `flex-1 sm:flex-none sm:w-[101px] rounded-[8px] px-[8px] sm:px-[12px] py-[10px] text-[11px] sm:text-[12px] font-semibold cursor-pointer transition text-center`;
  const subTabActive = "bg-[#f1ebfd] text-[#703ae6]";
  const subTabInactive = isDark ? "text-white hover:bg-[#333]" : "text-[#111] hover:bg-[#f7f7f7]";

  return (
    <div className="w-full h-fit flex flex-col gap-[16px]">
      {/* Trade sub-tabs */}
      <div
        className={`flex items-center rounded-[8px] border-[1px] p-1 gap-1 w-full sm:w-fit overflow-x-auto ${
          isDark ? "bg-[#1a1a1a] border-[#333]" : "bg-white border-[#e2e2e2]"
        }`}
      >
        {TRADE_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveSubTab(tab)}
            className={`${subTabBase} ${activeSubTab === tab ? subTabActive : subTabInactive}`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Margin content */}
      {activeSubTab === "Margin" ? (
        <div className="w-full flex flex-col gap-[16px]">
          <MarginStatsGrid isDark={isDark} />

          {/* Margin Info + Chart row */}
          <div className="w-full flex flex-col lg:flex-row gap-4 sm:gap-[16px] lg:h-[420px]">
            {/* Margin Info panel */}
            <div
              className={`w-full lg:w-[422px] flex-shrink-0 flex flex-col rounded-xl border overflow-hidden ${
                isDark ? "bg-[#222222] border-[#333333]" : "bg-[#F7F7F7] border-[#E5E7EB]"
              }`}
            >
              <div className={`px-5 pt-5 pb-4 border-b flex-shrink-0 ${isDark ? "border-[#333333]" : "border-[#e5e7eb]"}`}>
                <h3 className={`text-[16px] font-bold ${isDark ? "text-white" : "text-[#0f172a]"}`}>
                  Margin Info
                </h3>
              </div>
              <div className="flex flex-col overflow-y-auto px-5 pb-5">
                {MARGIN_INFO.map(({ label, value, positive }) => (
                  <div key={label} className="flex justify-between items-center py-[10px]">
                    <span className={`text-[14px] font-medium tracking-[0.01em] ${isDark ? "text-[#919191]" : "text-[#6b7280]"}`}>
                      {label}
                    </span>
                    <span
                      className={`text-[14px] font-semibold flex-shrink-0 ${
                        positive === true ? "text-[#16a34a]"
                        : positive === false ? "text-[#dc2626]"
                        : isDark ? "text-white" : "text-[#0f172a]"
                      }`}
                    >
                      {value}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Chart panel */}
            <div
              className={`flex-1 min-w-0 flex flex-col gap-4 rounded-[16px] border p-5 ${
                isDark ? "bg-[#1a1a1a] border-[#333]" : "bg-white border-[#e2e2e2]"
              }`}
            >
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
                      isDark
                        ? "bg-[#1a1a1a] border-[#333] text-white hover:bg-[#222]"
                        : "bg-white border-[#e2e2e2] text-[#111] hover:bg-[#f7f7f7]"
                    }`}
                  >
                    {timeFilter}
                    <ChevronDown />
                  </button>
                  {isTimeDropdownOpen && (
                    <div
                      className={`absolute right-0 top-[44px] z-10 rounded-[8px] border-[1px] py-[4px] min-w-[120px] ${
                        isDark ? "bg-[#1a1a1a] border-[#333]" : "bg-white border-[#e2e2e2]"
                      }`}
                    >
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
                    "2025-08-01": 18200,
                    "2025-08-07": 19800,
                    "2025-08-13": 21200,
                    "2025-08-19": 19400,
                    "2025-08-25": 17200,
                    "2025-08-31": 15000,
                    "2025-09-06": 13200,
                    "2025-09-12": 14800,
                    "2025-09-18": 16600,
                    "2025-09-24": 18400,
                    "2025-09-30": 20400,
                    "2025-10-06": 22200,
                    "2025-10-12": 23800,
                    "2025-10-18": 25200,
                    "2025-10-24": 26400,
                    "2025-10-31": 27800,
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
          <Positionstable />
        </div>
      ) : activeSubTab === "Farm" ? (
        <FarmSection />
      ) : (
        <div
          className={`w-full h-[300px] rounded-[16px] border-[1px] flex items-center justify-center ${
            isDark ? "bg-[#222222] border-[#333]" : "bg-[#f7f7f7] border-[#e2e2e2]"
          }`}
        >
          <p className={`text-[14px] font-medium ${isDark ? "text-[#919191]" : "text-[#5c5b5b]"}`}>
            {activeSubTab} coming soon
          </p>
        </div>
      )}
    </div>
  );
};
