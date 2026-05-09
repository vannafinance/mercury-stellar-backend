import { cn } from "@/lib/analytics/utils";

interface MetricCardProps {
  title: string;
  value: string;
  subtitle?: string;
  change?: number;
  className?: string;
}

export default function MetricCard({
  title,
  value,
  subtitle,
  change,
  className,
}: MetricCardProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-r4 bg-surface p-4 shadow-vanna",
        className
      )}
    >
      <span className="text-xs font-medium uppercase tracking-wider text-vgray-400">
        {title}
      </span>

      <span className="font-mono text-2xl font-bold leading-none text-vgray-900">
        {value}
      </span>

      {(subtitle || change !== undefined) && (
        <div className="mt-0.5 flex items-center gap-2 text-xs">
          {change !== undefined && (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 font-semibold",
                change >= 0 ? "text-electric-600" : "text-rose-500"
              )}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                className={cn("shrink-0", change < 0 && "rotate-180")}
              >
                <path d="M5 2L8 6H2L5 2Z" fill="currentColor" />
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
