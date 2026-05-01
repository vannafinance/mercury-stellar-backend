"use client";

import { useState, useRef, useEffect } from "react";
import { RewardsTable } from "@/components/earn/rewards-table";
import { ReusableChart } from "@/components/ui/reusable-chart";
import { Table } from "@/components/earn/table";
import { useTheme } from "@/contexts/theme-context";

const LENDER_MINI_STATS = [
  { id: "1", name: "Total Holdings",    amount: "$1000", positive: null  },
  { id: "2", name: "Due Amount",        amount: "$100",  positive: null  },
  { id: "3", name: "Net Returns (USD)", amount: "$10",   positive: true  },
  { id: "4", name: "Net Returns (%)",   amount: "10%",   positive: true  },
];

const POSITION_TABS = [
  { id: "current-positions", label: "Current Positions" },
  { id: "positions-history", label: "Positions History" },
];

const TABLE_HEADINGS = [
  { id: "pool",                label: "Pool" },
  { id: "amount-supplied",     label: "Amount Supplied",     icon: true },
  { id: "earn-supply-apy",     label: "Earn Supply APY",     icon: true },
  { id: "transaction-history", label: "Transaction History", icon: true },
];

const TABLE_ROWS = [
  { cell: [{ title: "XLM",       tag: "Active" }, { title: "500 XLM",      tag: "$60"    }, { title: "4.2%", tag: "300 USD"  }, { title: "500 USD" }] },
  { cell: [{ title: "USDC",      tag: "Active" }, { title: "1000 USDC",    tag: "$1000"  }, { title: "5.1%", tag: "1000 USD" }, { title: "1k USD"  }] },
  { cell: [{ title: "WBTC",      tag: "Active" }, { title: "0.0109 WBTC",  tag: "$1000"  }, { title: "3.3%", tag: "1000 USD" }, { title: "10k USD" }] },
  { cell: [{ title: "ETH",       tag: "Active" }, { title: "0.5 ETH",      tag: "$1200"  }, { title: "2.8%", tag: "500 USD"  }, { title: "5k USD"  }] },
];

export const LenderTab = () => {
  const { isDark } = useTheme();
  const [positionTab, setPositionTab] = useState("current-positions");
  const [timeFilter, setTimeFilter] = useState("All Time");
  const [isTimeDropdownOpen, setIsTimeDropdownOpen] = useState(false);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const [chartHeight, setChartHeight] = useState(400);

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

  return (
    <div className="w-full h-fit flex flex-col gap-6 sm:gap-8">
      {/* Top row: left stats/rewards + right P&L chart */}
      <div className="w-full flex flex-col lg:flex-row gap-4 lg:gap-[16px]">
        {/* Left column */}
        <div className="w-full lg:w-[422px] flex-shrink-0 flex flex-col gap-4 sm:gap-[16px] lg:h-[500px]">
          {/* Mini stats */}
          <div
            className={`w-full flex flex-col rounded-xl border overflow-hidden flex-shrink-0 ${
              isDark ? "bg-[#222222] border-[#333333]" : "bg-[#F7F7F7] border-[#E5E7EB]"
            }`}
          >
            <div className={`px-5 pt-5 pb-4 border-b shrink-0 ${isDark ? "border-[#333333]" : "border-[#e5e7eb]"}`}>
              <h3 className={`text-[16px] font-bold ${isDark ? "text-white" : "text-[#0f172a]"}`}>
                Lender Stats
              </h3>
            </div>
            <div className="flex flex-col px-5 pb-5">
              {LENDER_MINI_STATS.map(({ id, name, amount, positive }) => (
                <div key={id} className="flex justify-between items-center py-2.5">
                  <span className={`text-[14px] font-medium tracking-[0.01em] ${isDark ? "text-[#919191]" : "text-[#6b7280]"}`}>
                    {name}
                  </span>
                  <span
                    className={`text-[14px] font-semibold shrink-0 ${
                      positive === true ? "text-[#16a34a]"
                      : positive === false ? "text-[#dc2626]"
                      : isDark ? "text-white" : "text-[#0f172a]"
                    }`}
                  >
                    {amount}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Rewards table */}
          <div className="flex-1 min-h-0">
            <RewardsTable />
          </div>
        </div>

        {/* Right column: P&L chart */}
        <div
          className={`flex-1 min-w-0 flex flex-col gap-4 rounded-[16px] border p-5 lg:h-[500px] lg:self-start ${
            isDark ? "bg-[#1a1a1a] border-[#333]" : "bg-white border-[#e2e2e2]"
          }`}
        >
          <div className="flex items-center justify-between flex-shrink-0">
            <div className="flex flex-col gap-0.5">
              <span className={`text-[16px] font-bold ${isDark ? "text-white" : "text-[#0f172a]"}`}>
                P&L
              </span>
              <span className="text-[13px] font-medium text-[#a7a7a7]">
                Total Value
              </span>
            </div>
            <div className="flex items-center gap-[8px]">
              <button
                type="button"
                className={`h-[40px] px-[12px] pl-[8px] flex items-center justify-center rounded-[8px] border-[1px] text-[13px] font-medium whitespace-nowrap cursor-pointer transition ${
                  isDark
                    ? "bg-[#1a1a1a] border-[#333] text-white hover:bg-[#222]"
                    : "bg-white border-[#e2e2e2] text-[#111] hover:bg-[#f7f7f7]"
                }`}
              >
                Calendar
              </button>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setIsTimeDropdownOpen(!isTimeDropdownOpen)}
                  className={`h-[40px] pl-[8px] pr-[12px] flex items-center justify-center gap-[4px] rounded-[8px] border-[1px] text-[13px] font-medium whitespace-nowrap cursor-pointer ${
                    isDark
                      ? "bg-[#1a1a1a] border-[#333] text-white"
                      : "bg-white border-[#e2e2e2] text-[#111]"
                  }`}
                >
                  {timeFilter}
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
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
          </div>

          <div ref={chartContainerRef} className="flex-1 min-h-0 overflow-hidden rounded-xl">
            <ReusableChart
              data={{
                "2025-08-01": 4120,
                "2025-08-08": 4380,
                "2025-08-15": 4640,
                "2025-08-22": 4880,
                "2025-08-29": 5120,
                "2025-09-05": 5360,
                "2025-09-12": 5580,
                "2025-09-19": 5800,
                "2025-09-26": 6020,
                "2025-10-03": 5880,
                "2025-10-10": 6100,
                "2025-10-17": 6340,
                "2025-10-24": 6560,
                "2025-10-31": 6720,
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

      {/* Positions table */}
      <Table
        heading={{
          heading: "Positions Table",
          tabsItems: POSITION_TABS,
          tabType: "solid",
        }}
        activeTab={positionTab}
        onTabChange={setPositionTab}
        tableHeadings={TABLE_HEADINGS}
        tableBody={{ rows: TABLE_ROWS }}
        tableBodyBackground={isDark ? "bg-[#222222]" : "bg-[#F4F4F4]"}
        filters={{ customizeDropdown: true, filters: ["All"] }}
      />
    </div>
  );
};
