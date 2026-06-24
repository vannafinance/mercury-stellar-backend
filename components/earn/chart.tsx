/**
 * Time-series chart used across the earn surfaces (overall deposit, net APY,
 * my-supply, deposit/borrow APY, farm, volume, P&L). Wraps {@link SvgChart}
 * with a header (title/value + currency tabs), timeframe filter chips, and an
 * expandable full-screen modal.
 *
 * Two non-obvious behaviours live here:
 * - Per-timeframe bucketing collapses dense snapshot history into ~one point
 *   per bucket (latest value wins) so the line doesn't reshape on every refresh.
 * - The x-axis is anchored at the start of the selected window (prepending a
 *   zero point when needed) so e.g. a "3 Months" view always spans 3 months
 *   even when all real activity is recent.
 */
import { useState, useMemo, useRef, useEffect, memo } from "react";
import { Dropdown } from "../ui/dropdown";
import { SvgChart } from "../ui/svg-chart";
import { depositData } from "@/lib/constants/earn";
import { AnimatedTabs } from "../ui/animated-tabs";
import { ExpandableModal } from "../ui/expandable-modal";
import { useTheme } from "@/contexts/theme-context";
import { netVolumeData, netEarningsData } from "@/lib/constants/portfolio";

/** Props for {@link Chart}. `customData` overrides the built-in series for the given `type`. */
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

const filterOptions = ["1 Week", "1 Month", "3 Months", "All Time"];
const dayOptions = ["1D", "7D", "30D", "1Y"];
const depositApyOptions = ["Deposit APY", "Borrow APY"];

// Bucket width per timeframe. Snapshots that fall into the same bucket are
// collapsed to a single point (latest value wins). Without this, every
// per-minute snapshot pushes a new chart point even on multi-month views,
// which makes the chart visibly reshape every refresh tick.
const BUCKET_MS_BY_FILTER: Record<string, number> = {
  "1 Week": 6 * 60 * 60 * 1000,           // 6 hours
  "1 Month": 24 * 60 * 60 * 1000,         // 1 day
  "3 Months": 24 * 60 * 60 * 1000,        // 1 day
  // "All Time" uses an adaptive bucket computed from the actual span — see
  // bucketByInterval() below — so a 2-day-old account doesn't collapse to a
  // single point but a 2-year-old account doesn't render 100k+ points.
};

const bucketByInterval = (
  data: Array<{ date: string; amount: number }>,
  bucketMs: number,
): Array<{ date: string; amount: number }> => {
  if (bucketMs <= 0 || data.length === 0) return data;

  // If the entire raw-data span is shorter than a single bucket, bucketing
  // would collapse same-day deposits + withdrawals into one "latest value"
  // point and erase the rise-then-fall curve. In that case skip bucketing
  // and return raw points so a "1 Year" view of a fresh wallet still shows
  // the intra-day movement instead of a flat line at the latest value.
  const timestamps = data
    .map((item) => new Date(item.date).getTime())
    .filter((ts) => Number.isFinite(ts));
  if (timestamps.length >= 2) {
    const span = Math.max(...timestamps) - Math.min(...timestamps);
    if (span > 0 && span < bucketMs) return data;
  }

  const buckets = new Map<number, { date: string; amount: number; ts: number }>();
  for (const item of data) {
    const ts = new Date(item.date).getTime();
    if (!Number.isFinite(ts)) continue;
    const bucketKey = Math.floor(ts / bucketMs);
    const existing = buckets.get(bucketKey);
    // Keep the LATEST value within each bucket so the most recent state of
    // the world is what shows for that day/week.
    if (!existing || ts > existing.ts) {
      buckets.set(bucketKey, { date: item.date, amount: item.amount, ts });
    }
  }
  const result = Array.from(buckets.values())
    .sort((a, b) => a.ts - b.ts)
    .map(({ date, amount }) => ({ date, amount }));

  // SvgChart needs at least 2 points to draw a line. If bucketing collapsed a
  // multi-point input down to a single point (e.g. a fresh position with two
  // data samples 60s apart all landing in the same hour bucket), keep the
  // earliest raw sample alongside it so the chart renders a flat line at the
  // current value instead of falling back to "No data".
  if (result.length === 1 && data.length >= 2) {
    const sorted = [...data].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );
    if (sorted[0].date !== result[0].date) {
      return [sorted[0], result[0]];
    }
  }
  return result;
};

const adaptiveBucketMs = (data: Array<{ date: string; amount: number }>): number => {
  if (data.length < 2) return 0;
  const first = new Date(data[0].date).getTime();
  const last = new Date(data[data.length - 1].date).getTime();
  const span = Math.max(0, last - first);
  // Aim for ~50 buckets across the available history.
  const target = Math.floor(span / 50);
  // Floor at 1 hour so a wallet with 2 days of activity still gets a
  // smooth shape instead of one bucket every few minutes.
  return Math.max(60 * 60 * 1000, target);
};

// Helper function to filter data based on selected filter.
// Always anchors the x-axis at the start of the selected window so the
// chart spans the full period even when all real data is recent (e.g. a
// "3 Months" view should start at Nov, not at the deposit date in May).
const filterDataByTimeRange = (
  data: Array<{ date: string; amount: number }>,
  filter: string,
): Array<{ date: string; amount: number }> => {
  const now = new Date();
  const startDate = new Date(now);

  switch (filter) {
    case "1 Week":
      startDate.setDate(now.getDate() - 7);
      break;
    case "1 Month":
      startDate.setMonth(now.getMonth() - 1);
      break;
    case "3 Months":
      startDate.setMonth(now.getMonth() - 3);
      break;
    case "All Time":
      return bucketByInterval(data, adaptiveBucketMs(data));
    default:
      return data;
  }

  startDate.setHours(0, 0, 0, 0);
  const inWindow = data.filter((item) => new Date(item.date) >= startDate);
  const bucketed = bucketByInterval(inWindow, BUCKET_MS_BY_FILTER[filter] ?? 0);

  // Always anchor at the window start so the x-axis spans the full period.
  // If the oldest real point is more than one bucket-width after the window
  // start (meaning the user deposited recently), prepend a zero so the chart
  // shows "flat at 0 → then activity". This is why a "3 Months" view shows
  // Nov on the left even when all deposits happened yesterday.
  const startMs = startDate.getTime();
  const bucketMs = BUCKET_MS_BY_FILTER[filter] ?? 24 * 60 * 60 * 1000;
  const anchor = { date: startDate.toISOString(), amount: 0 };

  if (bucketed.length === 0) {
    // No data in window — flat zero line spanning the full period
    return [anchor, { date: now.toISOString(), amount: 0 }];
  }

  const oldestMs = new Date(bucketed[0].date).getTime();
  if (oldestMs > startMs + bucketMs) {
    // Real data doesn't start at the window edge — anchor at zero first
    return [anchor, ...bucketed];
  }

  return bucketed;
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

/**
 * Memoized time-series chart. Selects its raw series from `customData` or a
 * built-in default keyed by `type`, applies timeframe filtering + bucketing,
 * and renders both an inline view and an expandable modal. Shows an empty
 * state ("No data" / "No supply position yet") when the filtered series is empty.
 */
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
                      {type === "farm" ? (heading || "Farm") : type === "overall-deposit" ? "Overall Deposit" : type === "net-apy" ? "Net Earnings" : type === "my-supply" ? "My Supply" : type === "net-volume" ? "Net Volume" : type === "net-profit-loss" ? "Net Profit & Loss" : "Chart"}
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
                "Net Earnings"
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
