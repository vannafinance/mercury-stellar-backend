"use client";

import { RadialBarChart, RadialBar, PolarAngleAxis } from "recharts";
import { cn } from "@/lib/analytics/utils";

interface GaugeThresholds {
  healthy: number;
  warning: number;
  danger: number;
}

interface GaugeChartProps {
  value: number;
  label?: string;
  thresholds?: GaugeThresholds;
  size?: number;
  suffix?: string;
  className?: string;
}

const defaultThresholds: GaugeThresholds = {
  healthy: 70,
  warning: 40,
  danger: 20,
};

function getGaugeColor(value: number, thresholds: GaugeThresholds): string {
  if (value >= thresholds.healthy) return "#32EEE2";
  if (value >= thresholds.warning) return "#F59E0B";
  if (value >= thresholds.danger) return "#FF007A";
  return "#FC5457";
}

export default function GaugeChart({
  value,
  label,
  thresholds = defaultThresholds,
  size = 160,
  suffix = "%",
  className,
}: GaugeChartProps) {
  const clampedValue = Math.max(0, Math.min(100, value));
  const color = getGaugeColor(clampedValue, thresholds);

  const data = [
    {
      name: label ?? "value",
      value: clampedValue,
      fill: color,
    },
  ];

  return (
    <div className={cn("relative inline-flex flex-col items-center", className)}>
      <RadialBarChart
        width={size}
        height={size * 0.6}
        cx={size / 2}
        cy={size * 0.55}
        innerRadius={size * 0.32}
        outerRadius={size * 0.45}
        barSize={size * 0.08}
        data={data}
        startAngle={180}
        endAngle={0}
      >
        <PolarAngleAxis
          type="number"
          domain={[0, 100]}
          angleAxisId={0}
          tick={false}
        />
        <RadialBar
          background={{ fill: "#F4F4F4" }}
          dataKey="value"
          cornerRadius={size * 0.04}
          angleAxisId={0}
        />
      </RadialBarChart>

      {/* Center label */}
      <div
        className="absolute flex flex-col items-center"
        style={{
          top: size * 0.32,
          left: "50%",
          transform: "translateX(-50%)",
        }}
      >
        <span
          className="font-mono font-bold leading-none text-vgray-900"
          style={{ fontSize: size * 0.15, color }}
        >
          {value.toFixed(0)}
          <span className="text-vgray-400" style={{ fontSize: size * 0.09 }}>
            {suffix}
          </span>
        </span>
      </div>

      {label && (
        <span className="-mt-1 text-[11px] font-medium uppercase tracking-wider text-vgray-400">
          {label}
        </span>
      )}
    </div>
  );
}
