"use client";

import { Toaster } from "react-hot-toast";
import { useTheme } from "@/contexts/theme-context";

/**
 * App-wide toast host. Mount once in the root layout — consumers call
 * `toast.success(...)` / `toast.error(...)` from `react-hot-toast` anywhere.
 *
 * Styled to match the Stellar UI (dark/light aware, bottom-left, compact).
 */
export function AppToaster() {
  const { isDark } = useTheme();

  return (
    <Toaster
      position="bottom-left"
      gutter={8}
      toastOptions={{
        duration: 4000,
        style: {
          fontSize: "13px",
          fontWeight: 500,
          padding: "10px 14px",
          borderRadius: "12px",
          background: isDark ? "#1A1A1A" : "#ffffff",
          color: isDark ? "#ffffff" : "#111111",
          border: `1px solid ${isDark ? "#2A2A2A" : "#E8E8E8"}`,
          boxShadow: isDark
            ? "0 8px 24px rgba(0,0,0,0.45)"
            : "0 8px 24px rgba(0,0,0,0.08)",
        },
        success: {
          iconTheme: { primary: "#10B981", secondary: isDark ? "#1A1A1A" : "#ffffff" },
        },
        error: {
          iconTheme: { primary: "#FC5457", secondary: isDark ? "#1A1A1A" : "#ffffff" },
        },
      }}
    />
  );
}
