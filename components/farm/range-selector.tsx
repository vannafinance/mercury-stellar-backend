"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useTheme } from "@/contexts/theme-context";
import { ZoomInIcon, ZoomOutIcon, InfoIcon } from "@/components/icons";

interface RangeSelectorProps {
  /**
   * Name of the first token (e.g., "USDC", "USDT", "ETH")
   */
  token1Name?: string;
  /**
   * Name of the second token (e.g., "ETH", "BNB", "USDT")
   */
  token2Name?: string;
  /**
   * Chart data for token1 in array format: [{x: number, y: number}]
   * x represents the position on X-axis (e.g., 0.0000, 0.0001, etc.)
   * y represents the height/value for that position
   */
  token1ChartData?: Array<{ x: number; y: number }>;
  /**
   * Chart data for token2 in array format: [{x: number, y: number}]
   */
  token2ChartData?: Array<{ x: number; y: number }>;
  /**
   * Chart data in array format: [{x: number, y: number}] (legacy support)
   */
  chartData?: Array<{ x: number; y: number }>;
  /**
   * Minimum value for token1 range (controlled by parent)
   */
  token1MinValue?: number;
  /**
   * Maximum value for token1 range (controlled by parent)
   */
  token1MaxValue?: number;
  /**
   * Minimum value for token2 range (controlled by parent)
   */
  token2MinValue?: number;
  /**
   * Maximum value for token2 range (controlled by parent)
   */
  token2MaxValue?: number;
  /**
   * Callback when token1 range changes
   */
  onToken1RangeChange?: (min: number, max: number) => void;
  /**
   * Callback when token2 range changes
   */
  onToken2RangeChange?: (min: number, max: number) => void;
  /**
   * Minimum value of the range (controlled by parent) - legacy support
   */
  minValue?: number;
  /**
   * Maximum value of the range (controlled by parent) - legacy support
   */
  maxValue?: number;
  /**
   * Callback when range changes (legacy support)
   */
  onRangeChange?: (min: number, max: number) => void;
  /**
   * Height of the chart
   */
  height?: number;
  /**
   * Width of the chart
   */
  width?: string;
  /**
   * X-axis labels
   */
  xAxisLabels?: string[];
  /**
   * Show controls at the bottom
   */
  showControls?: boolean;
  /**
   * Current price for accurate calculations (defaults to center of range)
   */
  currentPrice?: number;
  /**
   * Base APR percentage (defaults to 14.14)
   */
  baseAPR?: number;
  /**
   * Minimum gap percentage between handles (defaults to 0.01%)
   */
  minGapPercentage?: number;
  /**
   * Range percentage for stable strategy (defaults to 10%)
   */
  stableRangePercentage?: number;
  /**
   * Range percentage for single-sided strategies (defaults to 30%)
   */
  singleSidedRangePercentage?: number;
  /**
   * Margin percentage for wide strategy (defaults to 5%)
   */
  wideMarginPercentage?: number;
  /**
   * Loading state
   */
  isLoading?: boolean;
  /**
   * Keyboard step size as percentage of range (defaults to 1%)
   */
  keyboardStepPercentage?: number;
  // Legacy props for backward compatibility
  /**
   * @deprecated Use token1ChartData and token1Name instead
   */
  usdcChartData?: Array<{ x: number; y: number }>;
  /**
   * @deprecated Use token2ChartData and token2Name instead
   */
  ethChartData?: Array<{ x: number; y: number }>;
  /**
   * @deprecated Use token1MinValue instead
   */
  usdcMinValue?: number;
  /**
   * @deprecated Use token1MaxValue instead
   */
  usdcMaxValue?: number;
  /**
   * @deprecated Use token2MinValue instead
   */
  ethMinValue?: number;
  /**
   * @deprecated Use token2MaxValue instead
   */
  ethMaxValue?: number;
  /**
   * @deprecated Use onToken1RangeChange instead
   */
  onUsdcRangeChange?: (min: number, max: number) => void;
  /**
   * @deprecated Use onToken2RangeChange instead
   */
  onEthRangeChange?: (min: number, max: number) => void;
}

export const RangeSelector = ({
  token1Name,
  token2Name,
  token1ChartData,
  token2ChartData,
  chartData, // legacy support
  token1MinValue,
  token1MaxValue,
  token2MinValue,
  token2MaxValue,
  onToken1RangeChange,
  onToken2RangeChange,
  minValue, // legacy support
  maxValue, // legacy support
  onRangeChange, // legacy support
  height = 200,
  width = "100%",
  xAxisLabels,
  showControls = true,
  currentPrice,
  baseAPR = 14.14,
  minGapPercentage = 0.0001,
  stableRangePercentage = 0.1,
  singleSidedRangePercentage = 0.3,
  wideMarginPercentage = 0.05,
  isLoading = false,
  keyboardStepPercentage = 0.01,
  // Legacy props for backward compatibility
  usdcChartData,
  ethChartData,
  usdcMinValue,
  usdcMaxValue,
  ethMinValue,
  ethMaxValue,
  onUsdcRangeChange,
  onEthRangeChange,
}: RangeSelectorProps) => {
  const { isDark } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const minHandleRef = useRef<SVGGElement>(null);
  const maxHandleRef = useRef<SVGGElement>(null);
  const [isDragging, setIsDragging] = useState<"min" | "max" | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(height);
  const [focusedHandle, setFocusedHandle] = useState<"min" | "max" | null>(null);
  
  // Callback ref to measure container width immediately when mounted
  const containerCallbackRef = useCallback((node: HTMLDivElement | null) => {
    if (node) {
      containerRef.current = node;
      // Measure immediately
      const measuredWidth = node.clientWidth;
      const measuredHeight = node.clientHeight || height;
      if (measuredWidth > 0) {
        setContainerWidth(measuredWidth);
        setContainerHeight(measuredHeight);
      }
    }
  }, [height]);
  const [selectedRangeOption, setSelectedRangeOption] = useState<string>("full-range");
  const [selectedStrategy, setSelectedStrategy] = useState<string>("stable");
  
  // Extract token names with fallback to legacy or defaults
  const t1Name = token1Name || (usdcChartData ? "USDC" : "Token 1");
  const t2Name = token2Name || (ethChartData ? "ETH" : "Token 2");
  
  // Use new props with fallback to legacy props
  const t1ChartData = token1ChartData || usdcChartData;
  const t2ChartData = token2ChartData || ethChartData;
  const t1MinValue = token1MinValue ?? usdcMinValue;
  const t1MaxValue = token1MaxValue ?? usdcMaxValue;
  const t2MinValue = token2MinValue ?? ethMinValue;
  const t2MaxValue = token2MaxValue ?? ethMaxValue;
  const onT1RangeChange = onToken1RangeChange || onUsdcRangeChange;
  const onT2RangeChange = onToken2RangeChange || onEthRangeChange;
  
  // Token selection state
  const [selectedToken, setSelectedToken] = useState<string>(t1Name);
  
  // Internal state for each token's range (if not provided by parent)
  const [internalToken1Min, setInternalToken1Min] = useState<number>(t1MinValue ?? 0.0001);
  const [internalToken1Max, setInternalToken1Max] = useState<number>(t1MaxValue ?? 0.0004);
  const [internalToken2Min, setInternalToken2Min] = useState<number>(t2MinValue ?? 0.0001);
  const [internalToken2Max, setInternalToken2Max] = useState<number>(t2MaxValue ?? 0.0004);
  
  // Get current token's data and values
  const currentChartData = useMemo(() => {
    if (selectedToken === t1Name && t1ChartData) return t1ChartData;
    if (selectedToken === t2Name && t2ChartData) return t2ChartData;
    return chartData || []; // fallback to legacy chartData
  }, [selectedToken, t1Name, t2Name, t1ChartData, t2ChartData, chartData]);
  
  const currentMinValue = useMemo(() => {
    if (selectedToken === t1Name) {
      return t1MinValue !== undefined ? t1MinValue : internalToken1Min;
    } else {
      return t2MinValue !== undefined ? t2MinValue : internalToken2Min;
    }
  }, [selectedToken, t1Name, t2Name, t1MinValue, t2MinValue, internalToken1Min, internalToken2Min]);
  
  const currentMaxValue = useMemo(() => {
    if (selectedToken === t1Name) {
      return t1MaxValue !== undefined ? t1MaxValue : internalToken1Max;
    } else {
      return t2MaxValue !== undefined ? t2MaxValue : internalToken2Max;
    }
  }, [selectedToken, t1Name, t2Name, t1MaxValue, t2MaxValue, internalToken1Max, internalToken2Max]);
  
  // Handle range change for current token
  const handleCurrentRangeChange = useCallback((min: number, max: number) => {
    if (selectedToken === t1Name) {
      if (onT1RangeChange) {
        onT1RangeChange(min, max);
      } else {
        setInternalToken1Min(min);
        setInternalToken1Max(max);
      }
    } else {
      if (onT2RangeChange) {
        onT2RangeChange(min, max);
      } else {
        setInternalToken2Min(min);
        setInternalToken2Max(max);
      }
    }
    // Legacy support
    if (onRangeChange) {
      onRangeChange(min, max);
    }
  }, [selectedToken, t1Name, t2Name, onT1RangeChange, onT2RangeChange, onRangeChange]);
  
  // Sync internal state when props change
  useEffect(() => {
    if (t1MinValue !== undefined) setInternalToken1Min(t1MinValue);
    if (t1MaxValue !== undefined) setInternalToken1Max(t1MaxValue);
    if (t2MinValue !== undefined) setInternalToken2Min(t2MinValue);
    if (t2MaxValue !== undefined) setInternalToken2Max(t2MaxValue);
  }, [t1MinValue, t1MaxValue, t2MinValue, t2MaxValue]);

  // Error handling: Validate chart data
  const hasValidData = useMemo(() => {
    return currentChartData && currentChartData.length > 0 && 
           currentChartData.every(d => typeof d.x === 'number' && typeof d.y === 'number' && !isNaN(d.x) && !isNaN(d.y));
  }, [currentChartData]);

  // Calculate min and max from chart data with error handling
  const dataMin = useMemo(() => {
    if (!hasValidData) return 0;
    const min = Math.min(...currentChartData.map((d) => d.x));
    return isNaN(min) ? 0 : min;
  }, [currentChartData, hasValidData]);
  
  const dataMax = useMemo(() => {
    if (!hasValidData) return 0.0005;
    const max = Math.max(...currentChartData.map((d) => d.x));
    return isNaN(max) ? 0.0005 : max;
  }, [currentChartData, hasValidData]);
  
  const dataYMax = useMemo(() => {
    if (!hasValidData) return 100;
    const max = Math.max(...currentChartData.map((d) => d.y));
    return isNaN(max) ? 100 : max;
  }, [currentChartData, hasValidData]);

  // Convert value to pixel position
  const valueToPixel = useCallback(
    (value: number) => {
      if (containerWidth === 0) return 0;
      const padding = 40; // Left padding for Y-axis
      const chartWidth = containerWidth - padding - 40; // Right padding
      return padding + ((value - dataMin) / (dataMax - dataMin)) * chartWidth;
    },
    [containerWidth, dataMin, dataMax]
  );

  // Convert pixel position to value
  const pixelToValue = useCallback(
    (pixel: number) => {
      if (containerWidth === 0) return dataMin;
      const padding = 40;
      const chartWidth = containerWidth - padding - 40;
      // Allow dragging slightly beyond edges for better UX, but clamp to reasonable bounds
      const normalizedPixel = Math.max(-10, Math.min(chartWidth + 10, pixel - padding));
      // Map to value range, allowing full range movement
      const ratio = Math.max(0, Math.min(1, normalizedPixel / chartWidth));
      return dataMin + ratio * (dataMax - dataMin);
    },
    [containerWidth, dataMin, dataMax]
  );

  // Get pixel positions for handles
  const minPixel = valueToPixel(currentMinValue);
  const maxPixel = valueToPixel(currentMaxValue);

  // Calculate percentage indicators for handles
  const effectiveCurrentPrice = useMemo(() => {
    return currentPrice ?? (dataMin + dataMax) / 2;
  }, [currentPrice, dataMin, dataMax]);
  
  // Get pixel position for break-even line (current price where percentage is 0)
  const breakEvenPixel = valueToPixel(effectiveCurrentPrice);
  
  const minPercentage = useMemo(() => {
    if (effectiveCurrentPrice === 0) return "0";
    const diff = currentMinValue - effectiveCurrentPrice;
    const percentage = (diff / effectiveCurrentPrice) * 100;
    return percentage.toFixed(0);
  }, [currentMinValue, effectiveCurrentPrice]);

  const maxPercentage = useMemo(() => {
    if (effectiveCurrentPrice === 0) return "0";
    const diff = currentMaxValue - effectiveCurrentPrice;
    const percentage = (diff / effectiveCurrentPrice) * 100;
    return percentage.toFixed(0);
  }, [currentMaxValue, effectiveCurrentPrice]);

  // Update container dimensions using ResizeObserver
  useEffect(() => {
    if (!containerRef.current) return;

    const updateDimensions = () => {
      if (containerRef.current) {
        const newWidth = containerRef.current.clientWidth;
        const newHeight = containerRef.current.clientHeight || height;
        if (newWidth > 0) {
          setContainerWidth(newWidth);
          setContainerHeight(newHeight);
        }
      }
    };

    // Initial measurement with a small delay to ensure DOM is ready
    const timeoutId = setTimeout(updateDimensions, 0);

    // Use ResizeObserver to track container size changes
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === containerRef.current) {
          const newWidth = entry.contentRect.width;
          const newHeight = entry.contentRect.height || height;
          if (newWidth > 0) {
            setContainerWidth(newWidth);
            setContainerHeight(newHeight);
          }
        }
      }
    });

    resizeObserver.observe(containerRef.current);

    // Also listen to window resize as fallback
    window.addEventListener("resize", updateDimensions);

    return () => {
      clearTimeout(timeoutId);
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateDimensions);
    };
  }, [height, width]);

  // Handle pointer down on handle (supports both mouse and touch)
  const handlePointerDown = (type: "min" | "max") => (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    setIsDragging(type);
    setFocusedHandle(type);
    // Clear selections when user starts manually dragging
    setSelectedRangeOption("");
    setSelectedStrategy("");
  };

  // Handle pointer move (supports both mouse and touch)
  useEffect(() => {
    const handleMove = (e: MouseEvent | TouchEvent) => {
      if (!isDragging || !containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const x = clientX - rect.left;

      if (isDragging === "min") {
        const newMin = pixelToValue(x);
        // Use configurable minimum gap to prevent handles from overlapping
        const minGap = (dataMax - dataMin) * minGapPercentage;
        const clampedMin = Math.max(dataMin, Math.min(newMin, currentMaxValue - minGap));
        handleCurrentRangeChange(clampedMin, currentMaxValue);
      } else if (isDragging === "max") {
        const newMax = pixelToValue(x);
        // Use configurable minimum gap to prevent handles from overlapping
        const minGap = (dataMax - dataMin) * minGapPercentage;
        const clampedMax = Math.min(dataMax, Math.max(newMax, currentMinValue + minGap));
        handleCurrentRangeChange(currentMinValue, clampedMax);
      }
    };

    const handleEnd = () => {
      setIsDragging(null);
    };

    if (isDragging) {
      // Add both mouse and touch event listeners
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleEnd);
      window.addEventListener("touchmove", handleMove);
      window.addEventListener("touchend", handleEnd);
    }

    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleEnd);
      window.removeEventListener("touchmove", handleMove);
      window.removeEventListener("touchend", handleEnd);
    };
  }, [isDragging, currentMinValue, currentMaxValue, dataMin, dataMax, pixelToValue, handleCurrentRangeChange, minGapPercentage]);

  // Keyboard navigation support
  const handleKeyDown = useCallback((type: "min" | "max") => (e: React.KeyboardEvent) => {
    const step = (dataMax - dataMin) * keyboardStepPercentage;
    const minGap = (dataMax - dataMin) * minGapPercentage;

    switch (e.key) {
      case "ArrowLeft":
      case "ArrowDown":
        e.preventDefault();
        if (type === "min") {
          const newMin = Math.max(dataMin, currentMinValue - step);
          handleCurrentRangeChange(newMin, currentMaxValue);
        } else {
          const newMax = Math.max(currentMinValue + minGap, currentMaxValue - step);
          handleCurrentRangeChange(currentMinValue, newMax);
        }
        break;
      case "ArrowRight":
      case "ArrowUp":
        e.preventDefault();
        if (type === "min") {
          const newMin = Math.min(currentMaxValue - minGap, currentMinValue + step);
          handleCurrentRangeChange(newMin, currentMaxValue);
        } else {
          const newMax = Math.min(dataMax, currentMaxValue + step);
          handleCurrentRangeChange(currentMinValue, newMax);
        }
        break;
      case "Home":
        e.preventDefault();
        if (type === "min") {
          handleCurrentRangeChange(dataMin, currentMaxValue);
        } else {
          handleCurrentRangeChange(currentMinValue, dataMax);
        }
        break;
      case "End":
        e.preventDefault();
        if (type === "min") {
          handleCurrentRangeChange(currentMaxValue - minGap, currentMaxValue);
        } else {
          handleCurrentRangeChange(currentMinValue, currentMinValue + minGap);
        }
        break;
    }
  }, [dataMin, dataMax, currentMinValue, currentMaxValue, keyboardStepPercentage, minGapPercentage, handleCurrentRangeChange]);

  // Generate SVG path for the chart
  const chartPath = useMemo(() => {
    if (currentChartData.length === 0 || containerWidth === 0) return "";

    const padding = 40;
    const chartWidth = containerWidth - padding - 40;
    const chartHeight = containerHeight - 60; // Space for X-axis and labels

    const points = currentChartData.map((d, idx) => {
      const x = padding + ((d.x - dataMin) / (dataMax - dataMin)) * chartWidth;
      const y = chartHeight - (d.y / dataYMax) * chartHeight;
      return `${idx === 0 ? "M" : "L"} ${x} ${y}`;
    });

    // Close the path to form an area
    const lastPoint = currentChartData[currentChartData.length - 1];
    const lastX = padding + ((lastPoint.x - dataMin) / (dataMax - dataMin)) * chartWidth;
    return `${points.join(" ")} L ${lastX} ${chartHeight} L ${padding} ${chartHeight} Z`;
  }, [currentChartData, containerWidth, containerHeight, dataMin, dataMax, dataYMax]);

  // Generate X-axis labels
  const xAxisLabelPositions = useMemo(() => {
    if (!xAxisLabels || xAxisLabels.length === 0) {
      // Generate default labels
      const labels: string[] = [];
      const steps = 6;
      for (let i = 0; i <= steps; i++) {
        const value = dataMin + ((dataMax - dataMin) / steps) * i;
        labels.push(value.toFixed(2));
      }
      return labels.map((label, idx) => ({
        label,
        x: idx === 0 ? 40 : idx === labels.length - 1 ? containerWidth - 40 : 40 + ((containerWidth - 80) / steps) * idx,
      }));
    }
    return xAxisLabels.map((label, idx) => ({
      label,
      x: idx === 0 ? 40 : idx === xAxisLabels.length - 1 ? containerWidth - 40 : 40 + ((containerWidth - 80) / (xAxisLabels.length - 1)) * idx,
    }));
  }, [xAxisLabels, containerWidth, dataMin, dataMax]);

  // Control handlers
  const handleFullRange = () => {
    setSelectedRangeOption("full-range");
    setSelectedStrategy(""); // Clear strategy when range option is selected
    handleCurrentRangeChange(dataMin, dataMax);
  };

  const handleHalfRange = () => {
    setSelectedRangeOption("x/2");
    setSelectedStrategy(""); // Clear strategy when range option is selected
    const range = currentMaxValue - currentMinValue;
    const center = (currentMinValue + currentMaxValue) / 2;
    handleCurrentRangeChange(center - range / 4, center + range / 4);
  };

  const handleX12Range = () => {
    setSelectedRangeOption("x/1.2");
    setSelectedStrategy(""); // Clear strategy when range option is selected
    const range = currentMaxValue - currentMinValue;
    const center = (currentMinValue + currentMaxValue) / 2;
    const newRange = range / 1.2;
    const newMin = Math.max(dataMin, center - newRange / 2);
    const newMax = Math.min(dataMax, center + newRange / 2);
    handleCurrentRangeChange(newMin, newMax);
  };

  const handleX101Range = () => {
    setSelectedRangeOption("x/1.01");
    setSelectedStrategy(""); // Clear strategy when range option is selected
    const range = currentMaxValue - currentMinValue;
    const center = (currentMinValue + currentMaxValue) / 2;
    const newRange = range / 1.01;
    const newMin = Math.max(dataMin, center - newRange / 2);
    const newMax = Math.min(dataMax, center + newRange / 2);
    handleCurrentRangeChange(newMin, newMax);
  };

  const handleZoomIn = () => {
    const range = currentMaxValue - currentMinValue;
    const center = (currentMinValue + currentMaxValue) / 2;
    const newRange = range / 1.01;
    const newMin = Math.max(dataMin, center - newRange / 2);
    const newMax = Math.min(dataMax, center + newRange / 2);
    handleCurrentRangeChange(newMin, newMax);
  };

  const handleZoomOut = () => {
    const range = currentMaxValue - currentMinValue;
    const center = (currentMinValue + currentMaxValue) / 2;
    const newRange = range * 1.01;
    const newMin = Math.max(dataMin, center - newRange / 2);
    const newMax = Math.min(dataMax, center + newRange / 2);
    handleCurrentRangeChange(newMin, newMax);
  };

  // Strategy handlers (using configurable values)
  const handleStable = () => {
    setSelectedStrategy("stable");
    setSelectedRangeOption(""); // Clear range option when strategy is selected
    // Stable strategy: centered around current price
    const range = (dataMax - dataMin) * stableRangePercentage;
    handleCurrentRangeChange(Math.max(dataMin, effectiveCurrentPrice - range / 2), Math.min(dataMax, effectiveCurrentPrice + range / 2));
  };

  const handleSingleSidedLeft = () => {
    setSelectedStrategy("single-sided-left");
    setSelectedRangeOption(""); // Clear range option when strategy is selected
    // Single sided left: range from min to current max
    const currentMax = currentMaxValue;
    const range = currentMax - dataMin;
    const newRange = range * singleSidedRangePercentage;
    handleCurrentRangeChange(dataMin, Math.min(dataMax, dataMin + newRange));
  };

  const handleWide = () => {
    setSelectedStrategy("wide");
    setSelectedRangeOption(""); // Clear range option when strategy is selected
    // Wide strategy: use most of the range
    const range = dataMax - dataMin;
    const margin = range * wideMarginPercentage;
    handleCurrentRangeChange(dataMin + margin, dataMax - margin);
  };

  const handleSingleSidedRight = () => {
    setSelectedStrategy("single-sided-right");
    setSelectedRangeOption(""); // Clear range option when strategy is selected
    // Single sided right: range from current min to max
    const currentMin = currentMinValue;
    const range = dataMax - currentMin;
    const newRange = range * singleSidedRangePercentage;
    handleCurrentRangeChange(Math.max(dataMin, dataMax - newRange), dataMax);
  };

  // Calculations for metrics
  const calculateTokenRatio = useMemo(() => {
    // Calculate based on current price position in range
    const currentPrice = (currentMinValue + currentMaxValue) / 2; // Assuming current price is at center
    const range = currentMaxValue - currentMinValue;
    if (range === 0) return "50% : 50%";
    const positionInRange = (currentPrice - currentMinValue) / range;
    const leftRatio = Math.round((1 - positionInRange) * 100);
    const rightRatio = Math.round(positionInRange * 100);
    return `${rightRatio}% : ${leftRatio}%`;
  }, [currentMinValue, currentMaxValue]);

  const calculateCapitalEfficiency = useMemo(() => {
    // Capital efficiency based on range width
    const fullRange = dataMax - dataMin;
    const selectedRange = currentMaxValue - currentMinValue;
    if (selectedRange === 0) return "0.00";
    const efficiency = fullRange / selectedRange;
    return efficiency.toFixed(2);
  }, [currentMinValue, currentMaxValue, dataMin, dataMax]);

  const calculateAPR = useMemo(() => {
    const capitalEfficiency = parseFloat(calculateCapitalEfficiency);
    const totalAPR = baseAPR * capitalEfficiency;
    return {
      base: baseAPR,
      efficiency: capitalEfficiency,
      total: totalAPR.toFixed(2),
    };
  }, [calculateCapitalEfficiency, baseAPR]);

  // Range options data
  const rangeOptions = [
    {
      id: "full-range",
      label: "Full Range",
      handler: handleFullRange,
    },
    {
      id: "x/2",
      label: "x/2",
      handler: handleHalfRange,
    },
  ];

  // Strategy options data
  const strategyOptions = [
    {
      id: "stable",
      label: "Stable",
      handler: handleStable,
    },
    {
      id: "wide",
      label: "Wide",
      handler: handleWide,
    },
  ];

  // Metrics data
  const metricsData = useMemo(() => [
    {
      id: "token-ratio",
      label: "Token Ratio",
      value: calculateTokenRatio,
    },
    {
      id: "capital-efficiency",
      label: "Capital Efficiency",
      value: `${calculateCapitalEfficiency}x`,
    },
    {
      id: "apr",
      label: "APR (when in-range, excl. IL)",
      value: `${calculateAPR.base}% * ${calculateAPR.efficiency} = ${calculateAPR.total}%`,
    },
  ], [calculateTokenRatio, calculateCapitalEfficiency, calculateAPR]);

  // Loading skeleton
  if (isLoading) {
    return (
      <div className="w-full flex flex-col gap-[16px]" role="status" aria-label="Loading chart">
        <div className={`w-full rounded-[20px] p-3 sm:p-[20px] flex flex-col gap-[16px] animate-pulse ${isDark ? "bg-[#111111]" : "bg-[#FFFFFF]"}`}>
          <div className="w-full h-fit flex items-center gap-[8px]">
            <div className={`h-[32px] w-[80px] rounded-[8px] ${isDark ? "bg-[#1A1A1A]" : "bg-gray-200"}`} />
            <div className={`h-[32px] w-[80px] rounded-[8px] ${isDark ? "bg-[#1A1A1A]" : "bg-gray-200"}`} />
          </div>
          <div className="w-full" style={{ height: `${height}px` }}>
            <div className={`w-full h-full rounded-[8px] ${isDark ? "bg-[#1A1A1A]" : "bg-gray-200"}`} />
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (!hasValidData) {
    return (
      <div className="w-full flex flex-col gap-[16px]" role="alert">
        <div className={`w-full rounded-[20px] p-3 sm:p-[20px] flex flex-col gap-[16px] items-center justify-center ${isDark ? "bg-[#111111]" : "bg-[#FFFFFF]"}`} style={{ height: `${height}px` }}>
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="24" cy="24" r="22" stroke={isDark ? "#595959" : "#BFBFBF"} strokeWidth="2" />
            <path d="M24 14V26M24 34H24.02" stroke={isDark ? "#595959" : "#BFBFBF"} strokeWidth="3" strokeLinecap="round" />
          </svg>
          <p className={`text-[14px] font-medium ${isDark ? "text-[#919191]" : "text-[#5C5B5B]"}`}>
            No valid chart data available
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col gap-[16px]">
      {/* Chart section with background */}
      <div className={`w-full rounded-[20px] p-3 sm:p-[20px] flex flex-col gap-[16px] ${isDark ? "bg-[#111111]" : "bg-[#FFFFFF]"}`}>
        {/* Token selection buttons */}
        <div className="w-full h-fit flex flex-wrap items-center gap-[8px]">
        {(t1ChartData || t2ChartData) && (
          <>
            {t1ChartData && (
              <button
                type="button"
                onClick={() => setSelectedToken(t1Name)}
                className={`px-[12px] py-[6px] rounded-[8px] text-[12px] font-medium transition-colors ${
                  selectedToken === t1Name
                    ? "bg-[#703AE6] text-white"
                    : isDark
                    ? "bg-[#1A1A1A] text-white border-[1px] border-[#595959]"
                    : "bg-white text-black border-[1px] border-[#BFBFBF]"
                }`}
              >
                {t1Name}
              </button>
            )}
            {t2ChartData && (
              <button
                type="button"
                onClick={() => setSelectedToken(t2Name)}
                className={`px-[12px] py-[6px] rounded-[8px] text-[12px] font-medium transition-colors ${
                  selectedToken === t2Name
                    ? "bg-[#703AE6] text-white"
                    : isDark
                    ? "bg-[#1A1A1A] text-white border-[1px] border-[#595959]"
                    : "bg-white text-black border-[1px] border-[#BFBFBF]"
                }`}
              >
                {t2Name}
              </button>
            )}
          </>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={handleStable}
          className={`px-[12px] py-[6px] rounded-[8px] text-[12px] font-medium ${
            isDark ? "bg-[#1A1A1A] text-white border-[1px]" : "bg-white text-black border-[1px]"
          }`}
        >
          Clear All
        </button>
        <button
          type="button"
          onClick={handleZoomIn}
          className={`p-[6px] rounded-[8px] ${
            isDark ? "bg-[#1A1A1A] border-[1px]" : "bg-white border-[1px]"
          }`}
        >
          <ZoomInIcon stroke={isDark ? "white" : "currentColor"} />
        </button>
        <button
          type="button"
          onClick={handleZoomOut}
          className={`p-[6px] rounded-[8px] ${
            isDark ? "bg-[#1A1A1A] border-[1px]" : "bg-white border-[1px]"
          }`}
        >
          <ZoomOutIcon stroke={isDark ? "white" : "currentColor"} />
        </button>
      </div>

      {/* Chart container */}
      <div
        ref={containerCallbackRef}
        className="w-full relative"
        style={{ height: `${height}px`, width }}
        role="group"
        aria-label={`Price range selector for ${selectedToken}`}
      >
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          className="absolute inset-0"
          style={{ overflow: "visible" }}
          role="img"
          aria-label={`Price distribution chart showing range from ${dataMin.toFixed(2)} to ${dataMax.toFixed(2)}`}
        >
          {/* Chart area background */}
          <defs>
            <linearGradient id="chartGradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="rgba(112, 58, 230, 0.3)" />
              <stop offset="100%" stopColor="rgba(112, 58, 230, 0.05)" />
            </linearGradient>
          </defs>

          {/* Chart path (histogram area) */}
          {chartPath && (
            <path
              d={chartPath}
              fill="url(#chartGradient)"
              stroke="#703AE6"
              strokeWidth="1"
            />
          )}

          {/* Shaded area between handles */}
          {minPixel > 0 && maxPixel < containerWidth && (
            <rect
              x={minPixel}
              y="0"
              width={maxPixel - minPixel}
              height={containerHeight - 60}
              fill="rgba(112, 58, 230, 0.1)"
            />
          )}

          {/* Break-even line (white vertical line at 0%) */}
          <line
            x1={breakEvenPixel}
            y1="0"
            x2={breakEvenPixel}
            y2={containerHeight - 60}
            stroke="#FFFFFF"
            strokeWidth="2"
            opacity="0.9"
            className="pointer-events-none"
          />

          {/* Min handle */}
          <g
            ref={minHandleRef}
            style={{ cursor: "grab" }}
            onMouseDown={handlePointerDown("min")}
            onTouchStart={handlePointerDown("min")}
            tabIndex={0}
            role="slider"
            aria-label={`Minimum price: ${currentMinValue.toFixed(2)}`}
            aria-valuemin={dataMin}
            aria-valuemax={dataMax}
            aria-valuenow={currentMinValue}
            aria-valuetext={`${currentMinValue.toFixed(2)} (${minPercentage}%)`}
            onKeyDown={handleKeyDown("min")}
            onFocus={() => setFocusedHandle("min")}
            onBlur={() => setFocusedHandle(null)}
            className={focusedHandle === "min" ? "outline-none" : ""}
          >
            <line
              x1={minPixel}
              y1="0"
              x2={minPixel}
              y2={containerHeight - 60}
              stroke="#703AE6"
              strokeWidth="2"
            />
            <rect
              x={minPixel - 12}
              y="0"
              width="24"
              height="20"
              fill="#703AE6"
              rx="4"
            />
            {/* Focus indicator */}
            {focusedHandle === "min" && (
              <rect
                x={minPixel - 14}
                y="-2"
                width="28"
                height="24"
                fill="none"
                stroke="#703AE6"
                strokeWidth="2"
                rx="6"
                className="pointer-events-none"
              />
            )}
            {/* Pause icon */}
            <g transform={`translate(${minPixel - 6}, 6)`}>
              <rect x="0" y="2" width="2" height="6" fill="white" />
              <rect x="4" y="2" width="2" height="6" fill="white" />
            </g>
            {/* Percentage indicator */}
            <g className="pointer-events-none">
              <rect
                x={minPixel - 20}
                y="22"
                width="40"
                height="16"
                fill={isDark ? "#1A1A1A" : "#FFFFFF"}
                rx="4"
                stroke="#703AE6"
                strokeWidth="1"
              />
              <text
                x={minPixel}
                y="33"
                textAnchor="middle"
                fill={isDark ? "#FFFFFF" : "#111111"}
                fontSize="11"
                fontWeight="500"
                className="select-none"
              >
                {parseFloat(minPercentage) < 0 ? "" : "+"}{minPercentage}%
              </text>
            </g>
          </g>

          {/* Max handle */}
          <g
            ref={maxHandleRef}
            style={{ cursor: "grab" }}
            onMouseDown={handlePointerDown("max")}
            onTouchStart={handlePointerDown("max")}
            tabIndex={0}
            role="slider"
            aria-label={`Maximum price: ${currentMaxValue.toFixed(2)}`}
            aria-valuemin={dataMin}
            aria-valuemax={dataMax}
            aria-valuenow={currentMaxValue}
            aria-valuetext={`${currentMaxValue.toFixed(2)} (${maxPercentage}%)`}
            onKeyDown={handleKeyDown("max")}
            onFocus={() => setFocusedHandle("max")}
            onBlur={() => setFocusedHandle(null)}
            className={focusedHandle === "max" ? "outline-none" : ""}
          >
            <line
              x1={maxPixel}
              y1="0"
              x2={maxPixel}
              y2={containerHeight - 60}
              stroke="#703AE6"
              strokeWidth="2"
            />
            <rect
              x={maxPixel - 12}
              y="0"
              width="24"
              height="20"
              fill="#703AE6"
              rx="4"
            />
            {/* Focus indicator */}
            {focusedHandle === "max" && (
              <rect
                x={maxPixel - 14}
                y="-2"
                width="28"
                height="24"
                fill="none"
                stroke="#703AE6"
                strokeWidth="2"
                rx="6"
                className="pointer-events-none"
              />
            )}
            {/* Pause icon */}
            <g transform={`translate(${maxPixel - 6}, 6)`}>
              <rect x="0" y="2" width="2" height="6" fill="white" />
              <rect x="4" y="2" width="2" height="6" fill="white" />
            </g>
            {/* Percentage indicator */}
            <g className="pointer-events-none">
              <rect
                x={maxPixel - 20}
                y="22"
                width="40"
                height="16"
                fill={isDark ? "#1A1A1A" : "#FFFFFF"}
                rx="4"
                stroke="#703AE6"
                strokeWidth="1"
              />
              <text
                x={maxPixel}
                y="33"
                textAnchor="middle"
                fill={isDark ? "#FFFFFF" : "#111111"}
                fontSize="11"
                fontWeight="500"
                className="select-none"
              >
                {parseFloat(maxPercentage) < 0 ? "" : "+"}{maxPercentage}%
              </text>
            </g>
          </g>

          {/* X-axis line */}
          <line
            x1="40"
            y1={containerHeight - 60}
            x2={containerWidth - 40}
            y2={containerHeight - 60}
            stroke={isDark ? "#595959" : "#BFBFBF"}
            strokeWidth="1"
          />

          {/* X-axis labels */}
          {xAxisLabelPositions.map((item, idx) => (
            <text
              key={idx}
              x={item.x}
              y={containerHeight - 40}
              textAnchor="middle"
              fill={isDark ? "#FFFFFF" : "#111111"}
              fontSize="12"
              className="select-none"
            >
              {item.label}
            </text>
          ))}
        </svg>
      </div>
      </div>

      {/* Range and Strategy Selection Options */}
      {showControls && (
        <div className="w-full h-fit flex flex-col gap-[12px]">
          {/* Options Grid - 4 items per row */}
          <div className="w-full h-fit grid grid-cols-2 sm:grid-cols-4 gap-[6px] sm:gap-[8px]">
            {/* Range Options */}
            {rangeOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={option.handler}
                className={`w-full h-[32px] flex items-center justify-center px-2 sm:px-[12px] rounded-[8px] text-[11px] sm:text-[12px] font-medium transition-colors ${
                  selectedRangeOption === option.id
                    ? "bg-[#703AE6] text-white"
                    : isDark
                    ? "bg-[#1A1A1A] text-white border-[1px] border-[#595959]"
                    : "bg-white text-black border-[1px] border-[#BFBFBF]"
                }`}
              >
                {option.label}
              </button>
            ))}

            {/* Strategy Options */}
            {strategyOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={option.handler}
                className={`w-full h-[32px] flex items-center justify-center px-2 sm:px-[12px] rounded-[8px] text-[11px] sm:text-[12px] font-medium transition-colors ${
                  selectedStrategy === option.id
                    ? "bg-[#703AE6] text-white"
                    : isDark
                    ? "bg-[#1A1A1A] text-white border-[1px] border-[#595959]"
                    : "bg-white text-black border-[1px] border-[#BFBFBF]"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          {/* Metrics Display */}
          <div className={`w-full rounded-xl overflow-hidden ${isDark ? "bg-[#111111]" : "bg-white"}`}>
            {metricsData.map((metric) => (
              <div key={metric.id} className="w-full flex items-center justify-between px-3 sm:px-4 py-2.5">
                <div className="flex items-center gap-1 shrink-0">
                  <span className={`text-[12px] font-medium ${
                    isDark ? "text-[#919191]" : "text-[#5C5B5B]"
                  }`}>
                    {metric.label}
                  </span>
                  <InfoIcon stroke={isDark ? "#FFFFFF" : "#5C5B5B"} />
                </div>
                <span className={`text-[13px] sm:text-[14px] font-semibold text-right ${
                  isDark ? "text-white" : "text-[#181822]"
                }`}>
                  {metric.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
