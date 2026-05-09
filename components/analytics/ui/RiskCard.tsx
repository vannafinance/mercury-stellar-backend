"use client";

import { type Chain, type RiskStatus } from "@/lib/analytics/data/mock";
import { cn, statusColor } from "@/lib/analytics/utils";
import ChainBadge from "@/components/analytics/ui/ChainBadge";
import MiniSparkline from "@/components/analytics/charts/MiniSparkline";

interface RiskCardProps {
  title: string;
  value: string;
  subtitle?: string;
  change?: number;
  status?: RiskStatus;
  sparkline?: number[];
  chain?: Chain;
  className?: string;
}

export default function RiskCard({
  title,
  value,
  subtitle,
  change,
  status,
  sparkline,
  chain,
  className,
}: RiskCardProps) {
  const borderColor = status ? statusColor(status) : undefined;

  return (
    <div
      className={cn(
        "relative flex flex-col gap-1 rounded-r4 bg-surface p-4 shadow-vanna",
        "border-l-[3px]",
        className
      )}
      style={{
        borderLeftColor: borderColor ?? "transparent",
      }}
    >
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-vgray-400">
          {title}
        </span>
        {chain && <ChainBadge chain={chain} size="sm" />}
      </div>

      {/* Value row */}
      <div className="flex items-end gap-3">
        <span className="font-mono text-2xl font-bold leading-none text-vgray-900">
          {value}
        </span>

        {sparkline && sparkline.length > 1 && (
          <MiniSparkline
            data={sparkline}
            color={borderColor ?? "#703AE6"}
            width={72}
            height={24}
          />
        )}
      </div>

      {/* Footer row */}
      {(subtitle || change !== undefined) && (
        <div className="mt-0.5 flex items-center gap-2 text-xs">
          {change !== undefined && (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 font-semibold",
                change >= 0 ? "text-electric-600" : "text-rose-500"
              )}
            >
              {/* Arrow */}
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                className={cn(
                  "shrink-0",
                  change < 0 && "rotate-180"
                )}
              >
                <path
                  d="M5 2L8 6H2L5 2Z"
                  fill="currentColor"
                />
              </svg>
              {Math.abs(change).toFixed(1)}%
            </span>
          )}
          {subtitle && (
            <span className="text-vgray-400">{subtitle}</span>
          )}
        </div>
      )}
    </div>
  );
}
