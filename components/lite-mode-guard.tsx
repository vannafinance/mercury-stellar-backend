"use client";

import { useLiteModeGuard } from "@/lib/hooks/useLiteModeGuard";

export function LiteModeGuard({ children }: { children: React.ReactNode }) {
  const blocked = useLiteModeGuard();
  if (blocked) return null;
  return <>{children}</>;
}
