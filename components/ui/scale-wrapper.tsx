"use client";

import { useViewportScale } from "@/lib/hooks/useViewportScale";

export function ScaleWrapper({ children }: { children: React.ReactNode }) {
  const zoom = useViewportScale(1440);

  return (
    <div style={{ zoom }}>
      {children}
    </div>
  );
}
