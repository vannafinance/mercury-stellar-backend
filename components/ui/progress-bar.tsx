"use client";

import { useMemo } from "react";
import { useTheme } from "@/contexts/theme-context";

interface ProgressBarProps {
  /**
   * Percentage value (0-100)
   */
  percentage: number;
  /**
   * Color for the progress fill (default: purple)
   */
  progressColor?: string;
  /**
   * Color for the background/remaining portion (default: white/light grey)
   */
  backgroundColor?: string;
  /**
   * Height of the progress bar (default: controlled by parent)
   */
  height?: string | number;
  /**
   * Additional className for the container
   */
  className?: string;
  /**
   * Custom styles for the container
   */
  style?: React.CSSProperties;
  /**
   * Show percentage text (default: false)
   */
  showPercentage?: boolean;
  /**
   * Position of percentage text: "left" | "right" | "center" | "none" (default: "none")
   */
  percentagePosition?: "left" | "right" | "center" | "none";
  /**
   * Custom text to display (overrides percentage if provided)
   */
  label?: string;
  /**
   * Value text to display on the right side (e.g., "363.00 of 20.00K")
   */
  value?: string;
  /**
   * Text size for label/percentage (default: "text-[14px]")
   */
  textSize?: string;
  /**
   * Text color for label/percentage (default: "text-[#0C0C0C]")
   */
  textColor?: string;
  /**
   * Border radius (default: "rounded-[4px]")
   */
  borderRadius?: string;
  /**
   * Show animation on mount (default: true)
   */
  animated?: boolean;
}

export const ProgressBar = ({
  percentage,
  progressColor = "#703AE6",
  backgroundColor = "#FFFFFF",
  height,
  className = "",
  style,
  showPercentage = false,
  percentagePosition = "none",
  label,
  value,
  textSize = "text-[14px]",
  textColor,
  borderRadius = "rounded-[4px]",
  animated = true,
}: ProgressBarProps) => {
  const { isDark } = useTheme();
  
  // Default text color based on theme if not provided
  const finalTextColor = textColor || (isDark ? "text-white" : "text-[#0C0C0C]");
  
  // Clamp percentage between 0 and 100
  const clampedPercentage = Math.min(Math.max(percentage, 0), 100);

  // Memoize the display text
  const displayText = useMemo(() => {
    if (label) return label;
    if (showPercentage) return `${clampedPercentage.toFixed(2)}%`;
    return "";
  }, [label, showPercentage, clampedPercentage]);

  // Determine if we should show text
  const shouldShowText = displayText && percentagePosition !== "none";
  
  // Show percentage and value below bar
  const showPercentageAndValue = showPercentage && value;

  // Get text alignment classes
  const getTextAlignment = () => {
    switch (percentagePosition) {
      case "left":
        return "justify-start";
      case "right":
        return "justify-end";
      case "center":
        return "justify-center";
      default:
        return "";
    }
  };

  const containerStyle: React.CSSProperties = {
    ...style,
    ...(height && { height: typeof height === "number" ? `${height}px` : height }),
  };

  return (
    <div
      className={`w-full flex flex-col gap-[4px] ${className}`}
      style={containerStyle}
    >
      {/* Text above bar (if position is not "none") */}
      {shouldShowText && (
        <div className={`flex ${getTextAlignment()} ${textSize} ${finalTextColor} font-medium`}>
          {displayText}
        </div>
      )}
      
      {/* Progress bar container */}
      <div
        className={`w-full relative overflow-hidden ${borderRadius}`}
        style={{
          backgroundColor,
          height: height ? (typeof height === "number" ? `${height}px` : height) : "8px",
        }}
      >
        {/* Progress fill */}
        <div
          className={`h-full ${borderRadius}`}
          style={{
            width: `${clampedPercentage}%`,
            backgroundColor: progressColor,
            transition: animated ? "width 0.5s ease-in-out" : "none",
          }}
        />
      </div>
      
      {/* Percentage and value below bar */}
      {showPercentageAndValue && (
        <div className={`flex justify-between items-center ${textSize} ${finalTextColor} font-medium`}>
          <span>{`${clampedPercentage.toFixed(2)}%`}</span>
          <span>{value}</span>
        </div>
      )}
    </div>
  );
};

