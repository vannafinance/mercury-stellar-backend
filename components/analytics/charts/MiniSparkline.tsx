"use client";

import { cn } from "@/lib/analytics/utils";

interface MiniSparklineProps {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
  strokeWidth?: number;
  filled?: boolean;
  className?: string;
}

export default function MiniSparkline({
  data,
  color = "#703AE6",
  width = 80,
  height = 28,
  strokeWidth = 1.5,
  filled = false,
  className,
}: MiniSparklineProps) {
  if (!data.length || data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const padding = 1;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;

  const points = data.map((v, i) => {
    const x = padding + (i / (data.length - 1)) * innerW;
    const y = padding + innerH - ((v - min) / range) * innerH;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const polyline = points.join(" ");

  const fillPoints = filled
    ? `${padding.toFixed(2)},${(padding + innerH).toFixed(2)} ${polyline} ${(padding + innerW).toFixed(2)},${(padding + innerH).toFixed(2)}`
    : undefined;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("shrink-0", className)}
      aria-hidden="true"
    >
      {filled && fillPoints && (
        <polygon
          points={fillPoints}
          fill={color}
          fillOpacity={0.1}
        />
      )}
      <polyline
        points={polyline}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* End dot */}
      <circle
        cx={parseFloat(points[points.length - 1].split(",")[0])}
        cy={parseFloat(points[points.length - 1].split(",")[1])}
        r={2}
        fill={color}
      />
    </svg>
  );
}
