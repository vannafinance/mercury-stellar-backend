import { type AlertPriority } from "@/lib/analytics/data/mock";
import { cn } from "@/lib/analytics/utils";

interface AlertBadgeProps {
  priority: AlertPriority;
  className?: string;
}

const priorityConfig: Record<
  AlertPriority,
  { bg: string; text: string; ring: string }
> = {
  P0: {
    bg: "bg-imperial-50",
    text: "text-imperial-600",
    ring: "ring-imperial-500/30",
  },
  P1: {
    bg: "bg-rose-50",
    text: "text-rose-600",
    ring: "ring-rose-500/30",
  },
  P2: {
    bg: "bg-amber-400/10",
    text: "text-amber-600",
    ring: "ring-amber-500/30",
  },
  P3: {
    bg: "bg-vgray-50",
    text: "text-vgray-600",
    ring: "ring-vgray-400/30",
  },
};

export default function AlertBadge({ priority, className }: AlertBadgeProps) {
  const cfg = priorityConfig[priority];

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-rfull px-2 py-0.5 text-[11px] font-bold leading-tight tracking-wide ring-1",
        cfg.bg,
        cfg.text,
        cfg.ring,
        className
      )}
    >
      {priority}
    </span>
  );
}
