import { type RiskStatus } from "@/lib/analytics/data/mock";
import { cn, statusBg } from "@/lib/analytics/utils";

interface StatusDotProps {
  status: RiskStatus;
  pulse?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeMap = {
  sm: "h-2 w-2",
  md: "h-2.5 w-2.5",
  lg: "h-3 w-3",
} as const;

export default function StatusDot({
  status,
  pulse = false,
  size = "md",
  className,
}: StatusDotProps) {
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 rounded-full",
        statusBg(status),
        sizeMap[size],
        pulse && "animate-pulse-slow",
        className
      )}
      aria-label={status}
    >
      {pulse && (
        <span
          className={cn(
            "absolute inset-0 rounded-full opacity-40",
            statusBg(status),
            "animate-ping"
          )}
        />
      )}
    </span>
  );
}
