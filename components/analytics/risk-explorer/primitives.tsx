"use client";

import { cn } from "@/lib/analytics/utils";

export function useColors() {
  return {
    text1: "text-vgray-800",
    text2: "text-vgray-600",
    text3: "text-vgray-500",
    inputBg: "bg-vgray-50 border border-vgray-200",
    innerBorder: "border-vgray-100",
    innerBg: "bg-vgray-50",
    hoverRow: "hover:bg-surface-hover",
  };
}

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-r4 border border-vgray-100 bg-surface p-6 shadow-vanna",
        className
      )}
    >
      {children}
    </div>
  );
}
