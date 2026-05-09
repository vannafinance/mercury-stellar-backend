import type { Metadata } from "next";
import Sidebar from "@/components/analytics/Sidebar";
import AnalyticsThemeProvider from "@/components/analytics/ThemeProvider";
import { LiteModeGuard } from "@/components/lite-mode-guard";

export const metadata: Metadata = {
  title: "Vanna Risk Monitor",
  description: "Real-time DeFi risk monitoring dashboard by Vanna Finance",
};

export default function AnalyticsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <LiteModeGuard>
      <AnalyticsThemeProvider>
        <div className="flex h-[calc(100vh-64px)] overflow-hidden bg-base-platinum">
          <Sidebar />
          <main className="flex-1 overflow-y-auto bg-base-platinum scrollbar-thin">
            {children}
          </main>
        </div>
      </AnalyticsThemeProvider>
    </LiteModeGuard>
  );
}
