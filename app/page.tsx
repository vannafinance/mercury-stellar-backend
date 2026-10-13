"use client";

import { Suspense } from "react";
import { useAppModeStore } from "@/store/app-mode-store";
import { LiteHome } from "@/components/lite-mode/lite-home";
import { MarginPageContent } from "@/components/margin/margin-page-content";

// Home = the Margin screen in Pro mode (same V3 content as /margin, with `/` as
// its base path for the ?repay=<asset> hand-off) and the Lite home in Lite mode.
// Margin-account discovery runs app-wide in MarginAccountHydrator.
export default function Home() {
  const appMode = useAppModeStore((s) => s.mode);

  if (appMode === "lite") {
    return (
      <main className="w-full px-4 sm:px-10 lg:px-30 pb-8 pt-6">
        <LiteHome />
      </main>
    );
  }

  return (
    <Suspense fallback={null}>
      <MarginPageContent basePath="/" />
    </Suspense>
  );
}
