import type { Metadata } from "next";
import "@/components/analytics/v3/analytics.css";
import { AnalyticsShell } from "@/components/analytics/v3/shell";
import AnalyticsThemeProvider from "@/components/analytics/ThemeProvider";
import { LiteModeGuard } from "@/components/lite-mode-guard";

export const metadata: Metadata = {
  title: "Risk Analytics",
  description: "Live risk analytics for Vanna on Stellar: margin accounts, health, collateral, lending pools and prices, read from Soroban.",
};

/**
 * `v3` carries the site's design tokens (light + `html.dark`); the analytics shell (sidebar, status bar,
 * tooltips) sits inside it. The theme provider keeps the older Recharts-based tools (Risk Explorer,
 * scenarios, advanced positions) in step with the site theme.
 */
export default function AnalyticsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <LiteModeGuard>
      <AnalyticsThemeProvider>
        <div className="v3">
          <AnalyticsShell>{children}</AnalyticsShell>
        </div>
      </AnalyticsThemeProvider>
    </LiteModeGuard>
  );
}
