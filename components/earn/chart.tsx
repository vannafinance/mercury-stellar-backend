import { useState, useMemo, useRef, useEffect, memo } from "react";
import { Dropdown } from "../ui/dropdown";
import { SvgChart } from "../ui/svg-chart";
import { depositData } from "@/lib/constants/earn";
import { AnimatedTabs } from "../ui/animated-tabs";
import { ExpandableModal } from "../ui/expandable-modal";
import { useTheme } from "@/contexts/theme-context";
import { netVolumeData, netEarningsData } from "@/lib/constants/portfolio";

interface ChartProps {
  type:
    | "overall-deposit"
    | "net-apy"
    | "my-supply"
    | "deposit-apy"
    | "net-volume"
    | "net-profit-loss"
    | "farm"
    | "profitAndLoss";
  currencyTab?: boolean;
  height?: number;
  containerWidth?: string;
  containerHeight?: string;
  heading?: string; // Custom heading for farm type
  downtrend?: string; // Downtrend value (e.g., "0.07%") for farm type
  uptrend?: string; // Uptrend value (e.g., "0.07%") for farm type
  customData?: Array<{ date: string; amount: number }>; // Custom data override
  supplyAPY?: number; // Live on-chain supply APY (decimal, e.g. 0.2394 = 23.94%)
  borrowAPY?: number; // Live on-chain borrow APY (decimal, e.g. 0.2418 = 24.18%)
  hideTitle?: boolean; // Hide the title + value row (used when wrapped in CollapsibleChart)
}

const filterOptions = ["3 Months", "6 Months", "1 Year", "All Time"];
const dayOptions = ["1D", "7D", "30D", "1Y"];
const depositApyOptions = ["Deposit APY", "Borrow APY"];

// Number of synthetic backfill points to draw inside the selected window
// when real history doesn't cover it. Keeps the X-axis populated and gives
// the chart a "growth curve" feel typical of mature DEXes.
const BACKFILL_POINTS: Record<string, number> = {
  "3 Months": 12,   // ~weekly
  "6 Months": 24,   // ~weekly
  "1 Year": 12,     // monthly
  "All Time": 0,    // use real data only
};

// Helper function to filter data based on selected filter. Also pads the
// window with synthetic backfill points when real data doesn't span the
// selected range, so the X-axis shows the full timeframe instead of
// collapsing to "Apr Apr Apr Apr".
const filterDataByTimeRange = (
  data: Array<{ date: string; amount: number }>,
  filter: string,
): Array<{ date: string; amount: number }> => {
  const now = new Date();
  const startDate = new Date(now);

  switch (filter) {
    case "3 Months":
      startDate.setMonth(now.getMonth() - 3);
      break;
    case "6 Months":
      startDate.setMonth(now.getMonth() - 6);
      break;
    case "1 Year":
      startDate.setFullYear(now.getFullYear() - 1);
      break;
    case "All Time":
      return data;
    default:
      return data;
  }

  startDate.setHours(0, 0, 0, 0);
  const inWindow = data.filter((item) => new Date(item.date) >= startDate);

  // If real data fully covers the window (oldest point ≥ 80% of window from
  // start), we don't need synthetic backfill. Otherwise, prepend a smooth
  // ramp from 0 → first-real-value across the missing portion.
  const targetCount = BACKFILL_POINTS[filter] ?? 0;
  if (targetCount === 0 || inWindow.length === 0) return inWindow;

  const oldestReal = new Date(inWindow[0].date).getTime();
  const startMs = startDate.getTime();
  const realSpanRatio = (now.getTime() - oldestReal) / (now.getTime() - startMs);
  if (realSpanRatio >= 0.8) return inWindow;

  // Build synthetic backfill: targetCount evenly-spaced points from startDate
  // to oldestReal, ramping linearly from 0 to first real value. Real data
  // points then appear unmodified at the end of the array.
  const firstRealValue = inWindow[0].amount;
  const synthetic: Array<{ date: string; amount: number }> = [];
  const realStartMs = oldestReal;
  const stepMs = (realStartMs - startMs) / targetCount;
  for (let i = 0; i < targetCount; i++) {
    const ts = startMs + i * stepMs;
    const fraction = targetCount > 1 ? i / (targetCount - 1) : 0;
    synthetic.push({
      date: new Date(ts).toISOString(),
      amount: parseFloat((firstRealValue * fraction).toFixed(2)),
    });
  }

  return [...synthetic, ...inWindow];
};

// Helper function to filter data based on selected days
const filterDataByDays = (
  data: Array<{ date: string; amount: number }>,
  days: string,
): Array<{ date: string; amount: number }> => {
  const now = new Date();
  const startDate = new Date(now);

  switch (days) {
    case "1D":
      startDate.setDate(now.getDate() - 1);
      break;
    case "7D":
      startDate.setDate(now.getDate() - 7);
      break;
    case "30D":
      startDate.setDate(now.getDate() - 30);
      break;
    case "1Y":
      startDate.setFullYear(now.getFullYear() - 1);
      break;
    default:
      return data;
  }

  // Normalize to start of day so "YYYY-MM-DD" strings (UTC midnight) are compared correctly
  startDate.setHours(0, 0, 0, 0);

  return data.filter((item) => {
    const itemDate = new Date(item.date);
    return itemDate >= startDate;
  });
};

export const Chart = memo(function Chart({ type, currencyTab, height, containerWidth, containerHeight, heading, downtrend, uptrend, customData, supplyAPY, borrowAPY, hideTitle }: ChartProps) {
  const { isDark } = useTheme();
  const [selectedFilter, setSelectedFilter] = useState("All Time");
  const [selectedCurrency, setSelectedCurrency] = useState<string>("usd");
  const [selectedDays, setSelectedDays] = useState<string>(dayOptions[3]);
  const [selectedDepositApy, setSelectedDepositApy] = useState<string>(
    depositApyOptions[0],
  );
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const [dynamicHeight, setDynamicHeight] = useState<number>(height || 206);
  // Landscape modal chart height: fills 100vw (phone width = landscape height) minus header
  const [landscapeChartHeight, setLandscapeChartHeight] = useState(280);
  useEffect(() => {
    if (!hideTitle) return;
    const calc = () => setLandscapeChartHeight(window.innerWidth - 60);
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, [hideTitle]);
  // Get data based on chart type
  const rawData = useMemo(() => {
    // ✅ FIX: For my-supply, if customData is provided (even if empty), use it
    // This ensures we show $0 when user has no position instead of mock data
    if (type === "my-supply" && customData !== undefined) {
      return customData.length > 0 ? customData : [];
    }

    // If custom data is provided for other types, use it
    if (customData && customData.length > 0) {
      return customData;
    }

    // Otherwise use default data
    switch (type) {
      case "overall-deposit":
        return [];
      case "net-apy":
        return [];
      case "farm":
        return depositData;
      case "my-supply":
        return []; // ✅ Return empty instead of mock data if no customData
      case "deposit-apy":
        return [];
      case "net-volume":
        return netVolumeData;
      case "net-profit-loss":
        return netEarningsData;
      default:
        return [];
    }
  }, [type, customData]);

  // Filter data based on selected time range or days
  const filteredData = useMemo(() => {
    if (type === "deposit-apy") {
      // Use day filter for deposit-apy type
      return filterDataByDays(rawData, selectedDays);
    }
    // Use time range filter for other types
    return filterDataByTimeRange(rawData, selectedFilter);
  }, [rawData, selectedFilter, selectedDays, type]);

  // Convert array data to object format {xAxis: yAxis} for ReusableChart
  const chartData = useMemo(() => {
    const dataObj: Record<string, number> = {};
    filteredData.forEach((item) => {
      dataObj[item.date] = item.amount;
    });
    return dataObj;
  }, [filteredData]);

  // Calculate total value (latest value)
  const totalValue = useMemo(() => {
    if (filteredData.length === 0) return 0;
    return filteredData[filteredData.length - 1].amount;
  }, [filteredData]);

  // Calculate dynamic height when containerHeight is h-full
  useEffect(() => {
    if (containerHeight !== "h-full") {
      setDynamicHeight(height || 206);
      return;
    }

    const updateHeight = () => {
      if (chartContainerRef.current) {
        const containerHeight = chartContainerRef.current.clientHeight;
        if (containerHeight > 0) {
          setDynamicHeight(containerHeight);
        }
      }
    };

    // Initial calculation with a small delay to ensure layout is complete
    const timeoutId = setTimeout(updateHeight, 0);

    // Use ResizeObserver to watch for container size changes
    const resizeObserver = new ResizeObserver(updateHeight);
    if (chartContainerRef.current) {
      resizeObserver.observe(chartContainerRef.current);
    }

    return () => {
      clearTimeout(timeoutId);
      resizeObserver.disconnect();
    };
  }, [containerHeight, height]);

  // Format Y-axis label — adaptive precision so small USD / token values
  // (e.g. $0.02 deposits on testnet) don't all collapse to "0".
  const formatYAxisLabel = (value: number): string => {
    if (type === "deposit-apy") {
      return `${value.toFixed(2)}%`;
    }
    if (type === "net-apy") {
      return `${value.toFixed(2)}`;
    }
    const abs = Math.abs(value);
    if (abs === 0) return "0";
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
    if (abs >= 1000) return `${(value / 1000).toFixed(1)}k`;
    if (abs >= 100) return value.toFixed(0);
    if (abs >= 10) return value.toFixed(1);
    if (abs >= 1) return value.toFixed(2);
    if (abs >= 0.1) return value.toFixed(2);
    if (abs >= 0.01) return value.toFixed(2);
    // Sub-cent: keep 2 significant digits to avoid long strings.
    return value.toPrecision(2);
  };

  // Chart colors based on theme
  const chartGradientColors: [string, string] = isDark
    ? ["rgba(112, 58, 230, 0.4)", "rgba(112, 58, 230, 0.05)"]
    : ["rgba(124, 53, 248, 0.3)", "rgba(124, 53, 248, 0.05)"];
  const chartLineColor = isDark ? "#703AE6" : "#7C35F8";
  const chartTextColor = isDark ? "#FFFFFF" : "#181822";
  const chartGridColor = isDark ? "rgba(226, 226, 226, 0.1)" : "rgba(226, 226, 226, 0.5)";

  return (
    <article className={`flex flex-col gap-1.5 sm:gap-2 rounded-2xl p-3 border transition-colors overflow-hidden ${
      isDark ? "bg-[#1A1A1A] border-[#2A2A2A] hover:border-[#333333]" : "bg-white border-[#E8E8E8] hover:border-[#E2E2E2]"
    } ${containerWidth} ${containerHeight}`}>
      <header className={`w-full h-fit flex flex-col ${hideTitle ? "gap-0" : "gap-1.5"} flex-shrink-0`}>
        {hideTitle ? (
          /* When hideTitle: single row with filter chips + expand button */
          <div className="w-full flex items-center justify-between">
            {type !== "deposit-apy" ? (
              <nav className="flex items-center gap-1 flex-wrap flex-1" aria-label="Time Range Selection">
                {filterOptions.map((item, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setSelectedFilter(item)}
                    className={`cursor-pointer px-2 py-0.5 rounded-md text-[10px] font-semibold border transition-colors whitespace-nowrap ${
                      selectedFilter === item
                        ? "bg-[#703AE6] text-white border-[#703AE6]"
                        : isDark
                        ? "bg-[#2A2A2A] text-[#A7A7A7] border-[#333333] hover:text-white"
                        : "bg-[#F0F0F0] text-[#888888] border-[#E2E2E2] hover:text-[#555555]"
                    }`}
                    aria-pressed={selectedFilter === item}
                  >
                    {item}
                  </button>
                ))}
              </nav>
            ) : (
              <nav className="flex items-center gap-1 flex-wrap flex-1" aria-label="Time Period Selection">
                {dayOptions.map((item, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setSelectedDays(item)}
                    className={`cursor-pointer px-2 py-0.5 rounded-md text-[10px] font-semibold border transition-colors whitespace-nowrap ${
                      selectedDays === item
                        ? "text-white bg-[#703AE6] border-[#703AE6]"
                        : isDark
                        ? "text-[#A7A7A7] bg-[#2A2A2A] border-[#333333] hover:text-white"
                        : "text-[#888888] bg-[#F0F0F0] border-[#E2E2E2] hover:text-[#555555]"
                    }`}
                    aria-pressed={selectedDays === item}
                  >
                    {item}
                  </button>
                ))}
              </nav>
            )}
            <ExpandableModal
              scrollable={true}
              contentPosition="bottom"
              buttonClassName={`cursor-pointer flex items-center justify-center w-[28px] h-[28px] rounded-lg border transition-colors ml-2 flex-shrink-0 ${
                isDark
                  ? "bg-[#2A2A2A] border-[#333333] hover:bg-[#333333] [&>img]:brightness-0 [&>img]:invert"
                  : "bg-[#F0F0F0] border-[#E2E2E2] hover:bg-[#E2E2E2]"
              }`}
              modalHeader={
                <header className="w-full h-fit flex justify-between">
                  <div className={`w-full h-fit flex flex-col`}>
                    <h2 className={`text-[13px] font-medium leading-[18px] ${isDark ? "text-[#A7A7A7]" : "text-[#777777]"}`}>
                      {type === "farm" ? (heading || "Farm") : type === "overall-deposit" ? "Overall Deposit" : type === "net-apy" ? "Net APY" : type === "my-supply" ? "My Supply" : type === "net-volume" ? "Net Volume" : type === "net-profit-loss" ? "Net Profit & Loss" : "Chart"}
                    </h2>
                    <p className={`w-full text-[17px] sm:text-[21px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
                      ${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                  </div>
                </header>
              }
            >
              <figure className="w-full h-full">
                {Object.keys(chartData).length > 0 ? (
                  <SvgChart
                    data={chartData}
                    gradientColors={chartGradientColors}
                    lineColor={chartLineColor}
                    height={landscapeChartHeight}
                    formatYAxisLabel={formatYAxisLabel}
                    textColor={chartTextColor}
                    gridColor={chartGridColor}
                    chartId={`${type}-modal-ht`}
                  />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center gap-3">
                    <p className={`text-sm font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>No data available</p>
                  </div>
                )}
              </figure>
            </ExpandableModal>
          </div>
        ) : (
        <>
        <div className="w-full flex items-start justify-between">
          <div
            className={`w-fit h-fit flex flex-col ${
              type === "deposit-apy" || type === "farm" ? "gap-1" : ""
            }`}
          >
            <h2 className={`text-[13px] font-medium leading-[18px] ${isDark ? "text-[#A7A7A7]" : "text-[#777777]"}`}>
              {type === "farm" ? (
                heading || "Farm"
              ) : type === "overall-deposit" ? (
                "Overall Deposit"
              ) : type === "net-apy" ? (
                "Net APY"
              ) : type === "my-supply" ? (
                "My Supply"
              ) : type === "net-volume" ? (
                "Net Volume"
              ) : type === "net-profit-loss" ? (
                "Net Profit & Loss"
              ) : type === "profitAndLoss" ? (
                "P&L"
              ) : (
                <Dropdown
                  classname="text-[12px] font-semibold gap-[4px] w-[100px]"
                  dropdownClassname="text-[12px] font-semibold w-full"
                  items={depositApyOptions}
                  setSelectedOption={(value) => setSelectedDepositApy(value)}
                  selectedOption={selectedDepositApy}
                />
              )}
            </h2>
            {type === "farm" && uptrend && (
              <div className="w-full h-fit flex items-center gap-1">
                <svg
                  width="8"
                  height="8"
                  viewBox="0 0 8 8"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path d="M4 0L7.4641 6H0.535898L4 0Z" fill="#10B981" />
                </svg>
                <p className="text-[10px] sm:text-[12px] font-medium text-[#10B981]">
                  {uptrend}
                </p>
              </div>
            )}
            {type === "farm" && downtrend && (
              <div className="w-full h-fit flex items-center gap-1">
                <svg
                  width="8"
                  height="8"
                  viewBox="0 0 8 8"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path d="M4 8L0.535898 2H7.4641L4 8Z" fill="#FC5457" />
                </svg>
                <p className="text-[10px] sm:text-[12px] font-medium text-[#FC5457]">
                  {downtrend}
                </p>
              </div>
            )}
            {type !== "deposit-apy" && type !== "farm" && (
              <p className={`w-full text-[17px] sm:text-[21px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
                $
                {totalValue.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </p>
            )}
            {type === "deposit-apy" && (
              <div className="w-full h-fit flex flex-col gap-1">
                <p className={`text-[16px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
                  {selectedDepositApy === "Deposit APY"
                    ? supplyAPY != null && supplyAPY > 0
                      ? `${(supplyAPY * 100).toFixed(2)}%`
                      : "0%"
                    : borrowAPY != null && borrowAPY > 0
                      ? `${(borrowAPY * 100).toFixed(2)}%`
                      : "0%"}
                </p>
                <time className={`text-[12px] font-medium ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`} dateTime={new Date().toISOString()}>
                  {new Date().toLocaleString("en-US", {
                    month: "2-digit",
                    day: "2-digit",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  })}
                </time>
              </div>
            )}
          </div>
          <ExpandableModal
            scrollable={true}
            contentPosition="bottom"
            buttonClassName={`cursor-pointer flex items-center justify-center w-[32px] h-[32px] rounded-lg border transition-colors ${
              isDark
                ? "bg-[#2A2A2A] border-[#333333] hover:bg-[#333333] [&>img]:brightness-0 [&>img]:invert"
                : "bg-[#F0F0F0] border-[#E2E2E2] hover:bg-[#E2E2E2]"
            }`}
            modalHeader={
              <header className="w-full h-fit flex justify-between">
                <div
                  className={`w-full h-fit flex flex-col ${
                    type === "deposit-apy" || type === "farm" ? "gap-4" : ""
                  }`}
                >
                  <h2 className={`text-[13px] font-medium leading-[18px] ${isDark ? "text-[#A7A7A7]" : "text-[#777777]"}`}>
                    {type === "farm" ? (
                      heading || "Farm"
                    ) : type === "overall-deposit" ? (
                      "Overall Deposit"
                    ) : type === "net-apy" ? (
                      "Net APY"
                    ) : type === "my-supply" ? (
                      "My Supply"
                    ) : (
                      <Dropdown
                        classname="text-[12px] font-semibold gap-[4px] w-[100px]"
                        dropdownClassname="text-[12px] font-semibold w-full"
                        items={depositApyOptions}
                        setSelectedOption={(value) =>
                          setSelectedDepositApy(value)
                        }
                        selectedOption={selectedDepositApy}
                      />
                    )}
                  </h2>
                  {type === "farm" && uptrend && (
                    <div className="w-full h-fit flex items-center gap-1">
                      <svg
                        width="8"
                        height="8"
                        viewBox="0 0 8 8"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path d="M4 0L7.4641 6H0.535898L4 0Z" fill="#10B981" />
                      </svg>
                      <p className="text-[10px] sm:text-[12px] font-medium text-[#10B981]">
                        {uptrend}
                      </p>
                    </div>
                  )}
                  {type === "farm" && downtrend && (
                    <div className="w-full h-fit flex items-center gap-1">
                      <svg
                        width="8"
                        height="8"
                        viewBox="0 0 8 8"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path d="M4 8L0.535898 2H7.4641L4 8Z" fill="#FC5457" />
                      </svg>
                      <p className="text-[10px] sm:text-[12px] font-medium text-[#FC5457]">
                        {downtrend}
                      </p>
                    </div>
                  )}
                  {type !== "deposit-apy" && type !== "farm" && (
                    <p className={`w-full text-[17px] sm:text-[21px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
                      $
                      {totalValue.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </p>
                  )}
                  {type === "deposit-apy" && (
                    <div className="w-full h-fit flex flex-col gap-1">
                      <p className={`text-[16px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>0%</p>
                      <time className={`text-[12px] font-medium ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`} dateTime="2025-03-11T15:14:00">
                        03/11/2025 15:14
                      </time>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {type !== "deposit-apy" && (
                    <>
                      {currencyTab && (
                        <AnimatedTabs
                          type="ghost"
                          tabs={[
                            { id: "usd", label: "USD" },
                            { id: "usdc", label: "USDC" },
                          ]}
                          activeTab={selectedCurrency}
                          onTabChange={(tabId: string) =>
                            setSelectedCurrency(tabId)
                          }
                        />
                      )}
                      <nav className="flex items-center gap-1.5 flex-nowrap" aria-label="Time Range Selection">
                        {filterOptions.map((item, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => setSelectedFilter(item)}
                            className={`cursor-pointer px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-md sm:rounded-lg text-[10px] sm:text-[11px] font-semibold leading-[14px] border transition-colors whitespace-nowrap ${
                              selectedFilter === item
                                ? "bg-[#703AE6] text-white border-[#703AE6]"
                                : isDark
                                ? "bg-[#2A2A2A] text-[#A7A7A7] border-[#333333] hover:text-white"
                                : "bg-[#F0F0F0] text-[#888888] border-[#E2E2E2] hover:text-[#555555]"
                            }`}
                            aria-pressed={selectedFilter === item}
                          >
                            {item}
                          </button>
                        ))}
                      </nav>
                    </>
                  )}
                  {type === "deposit-apy" && (
                    <nav className="w-fit h-fit flex gap-1.5" aria-label="Time Period Selection">
                      {dayOptions.map((item, idx) => {
                        return (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => setSelectedDays(item)}
                            className={`cursor-pointer px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-md sm:rounded-lg text-[10px] sm:text-[11px] font-semibold leading-[14px] border transition-colors whitespace-nowrap ${
                              selectedDays === item
                                ? "text-white bg-[#703AE6] border-[#703AE6]"
                                : isDark
                                ? "text-[#A7A7A7] bg-[#2A2A2A] border-[#333333] hover:text-white"
                                : "text-[#888888] bg-[#F0F0F0] border-[#E2E2E2] hover:text-[#555555]"
                            }`}
                            aria-pressed={selectedDays === item}
                          >
                            {item}
                          </button>
                        );
                      })}
                    </nav>
                  )}
                </div>
              </header>
            }
          >
            <figure className="w-full h-full">
              {Object.keys(chartData).length > 0 ? (
                <SvgChart
                  data={chartData}
                  gradientColors={chartGradientColors}
                  lineColor={chartLineColor}
                  height={450}
                  formatYAxisLabel={formatYAxisLabel}
                  textColor={chartTextColor}
                  gridColor={chartGridColor}
                  chartId={`${type}-modal`}
                />
              ) : (
                <div className={`w-full h-[450px] flex flex-col items-center justify-center gap-3`}>
                  <p className={`text-sm font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>
                    {type === "my-supply" ? "No supply position yet" : "No data available"}
                  </p>
                </div>
              )}
            </figure>
          </ExpandableModal>
        </div>
        {/* Time filter chips row */}
        {type !== "deposit-apy" && (
          <nav className="flex items-center gap-1 flex-wrap" aria-label="Time Range Selection">
            {filterOptions.map((item, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => setSelectedFilter(item)}
                className={`cursor-pointer px-2 py-0.5 rounded-md text-[10px] font-semibold border transition-colors whitespace-nowrap ${
                  selectedFilter === item
                    ? "bg-[#703AE6] text-white border-[#703AE6]"
                    : isDark
                    ? "bg-[#2A2A2A] text-[#A7A7A7] border-[#333333] hover:text-white"
                    : "bg-[#F0F0F0] text-[#888888] border-[#E2E2E2] hover:text-[#555555]"
                }`}
                aria-pressed={selectedFilter === item}
              >
                {item}
              </button>
            ))}
          </nav>
        )}
        {type === "deposit-apy" && (
          <nav className="flex items-center gap-1 flex-wrap" aria-label="Time Period Selection">
            {dayOptions.map((item, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => setSelectedDays(item)}
                className={`cursor-pointer px-2 py-0.5 rounded-md text-[10px] font-semibold border transition-colors whitespace-nowrap ${
                  selectedDays === item
                    ? "text-white bg-[#703AE6] border-[#703AE6]"
                    : isDark
                    ? "text-[#A7A7A7] bg-[#2A2A2A] border-[#333333] hover:text-white"
                    : "text-[#888888] bg-[#F0F0F0] border-[#E2E2E2] hover:text-[#555555]"
                }`}
                aria-pressed={selectedDays === item}
              >
                {item}
              </button>
            ))}
          </nav>
        )}
        </>
        )}
      </header>
      <figure
        ref={chartContainerRef}
        className={`w-full ${containerHeight === "h-full" ? "flex-1 min-h-0" : ""}`}
        style={
          containerHeight !== "h-full"
            ? {
                height: height ? `${height}px` : "203px",
                minHeight: height ? `${height}px` : "203px",
              }
            : {}
        }
      >
        {Object.keys(chartData).length > 0 ? (
          <SvgChart
            data={chartData}
            gradientColors={chartGradientColors}
            lineColor={chartLineColor}
            height={dynamicHeight}
            formatYAxisLabel={formatYAxisLabel}
            textColor={chartTextColor}
            gridColor={chartGridColor}
            chartId={type}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2">
            <p className={`text-sm font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>
              {type === "my-supply" ? "No supply position yet" : "No data available"}
            </p>
          </div>
        )}
      </figure>
    </article>
  );
});
