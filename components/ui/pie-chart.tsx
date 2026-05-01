"use client";

import { useMemo } from "react";
import { useTheme } from "@/contexts/theme-context";

interface PieChartProps {
  /**
   * Percentage value (0-100)
   */
  percentage: number;
  /**
   * Color for the progress arc (default: purple)
   */
  progressColor?: string;
  /**
   * Color for the remaining arc (default: light grey)
   */
  remainingColor?: string;
  /**
   * Stroke width of the circle (default: 8)
   */
  strokeWidth?: number;
  /**
   * Additional className for the container
   */
  className?: string;
  /**
   * Custom styles for the container
   */
  style?: React.CSSProperties;
  /**
   * Show percentage text in center (default: true)
   */
  showPercentage?: boolean;
  /**
   * Custom text to display in center (overrides percentage if provided)
   */
  centerText?: string;
  /**
   * Text size for center text (default: "text-[20px]")
   */
  textSize?: string;
  /**
   * Text color for center text (default: "text-black")
   */
  textColor?: string;
}

export const PieChart = ({
  percentage,
  progressColor = "#703AE6",
  remainingColor = "#E2E2E2",
  strokeWidth = 8,
  className = "",
  style,
  showPercentage = true,
  centerText,
  textSize = "text-[20px]",
  textColor,
}: PieChartProps) => {
  const { isDark } = useTheme();
  
  // Default text color based on theme if not provided
  const finalTextColor = textColor || (isDark ? "text-white" : "text-black");
  
  // Clamp percentage between 0 and 100
  const clampedPercentage = Math.min(Math.max(percentage, 0), 100);

  // Calculate SVG dimensions and radius
  const size = 100; // Base size for calculations
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clampedPercentage / 100) * circumference;

  // Memoize the display text
  const displayText = useMemo(() => {
    if (centerText) return centerText;
    if (showPercentage) return `${clampedPercentage.toFixed(2)}%`;
    return "";
  }, [centerText, showPercentage, clampedPercentage]);

  return (
    <div
      className={`relative flex items-center justify-center ${className}`}
      style={style}
    >
      <svg
        className="transform -rotate-90"
        viewBox={`0 0 ${size} ${size}`}
        style={{ width: "100%", height: "100%" }}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Background circle (remaining) */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={remainingColor}
          strokeWidth={strokeWidth}
        />
        {/* Progress circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={progressColor}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{
            transition: "stroke-dashoffset 0.5s ease-in-out",
          }}
        />
      </svg>
      {/* Center text */}
      {displayText && (
        <div
          className={`absolute inset-0 flex items-center justify-center ${textSize} ${finalTextColor} font-semibold`}
        >
          {displayText}
        </div>
      )}
    </div>
  );
};

