import { type Chain } from "@/lib/analytics/data/mock";
import { cn } from "@/lib/analytics/utils";

interface ChainBadgeProps {
  chain: Chain;
  size?: "sm" | "md";
  className?: string;
}

const chainConfig = {
  base: {
    label: "Base",
    bg: "bg-[#0052FF]/10",
    text: "text-[#0052FF]",
    ring: "ring-[#0052FF]/20",
  },
  stellar: {
    label: "Stellar",
    bg: "bg-violet-50",
    text: "text-violet-500",
    ring: "ring-violet-500/20",
  },
} as const;

const sizeStyles = {
  sm: "px-1.5 py-0.5 text-[10px] leading-tight",
  md: "px-2 py-0.5 text-xs leading-tight",
} as const;

export default function ChainBadge({
  chain,
  size = "sm",
  className,
}: ChainBadgeProps) {
  const cfg = chainConfig[chain];

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-rfull font-semibold ring-1",
        cfg.bg,
        cfg.text,
        cfg.ring,
        sizeStyles[size],
        className
      )}
    >
      {cfg.label}
    </span>
  );
}
