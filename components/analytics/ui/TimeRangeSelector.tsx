"use client";

import { cn } from "@/lib/analytics/utils";

interface TimeRangeSelectorProps {
  options: string[];
  selected: string;
  onChange: (value: string) => void;
  className?: string;
}

export default function TimeRangeSelector({
  options,
  selected,
  onChange,
  className,
}: TimeRangeSelectorProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-rfull bg-vgray-50 p-0.5",
        className
      )}
    >
      {options.map((opt) => {
        const isActive = opt === selected;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            className={cn(
              "rounded-rfull px-3 py-1.5 text-xs font-semibold transition-all",
              isActive
                ? "bg-white text-violet-500 shadow-sm"
                : "text-vgray-400 hover:text-vgray-700"
            )}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}
