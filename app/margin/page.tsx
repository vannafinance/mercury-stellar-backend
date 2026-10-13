"use client";

import { Suspense } from "react";
import { MarginPageContent } from "@/components/margin/margin-page-content";

// useSearchParams() (the ?repay=<asset> hand-off) opts this page out of static
// prerendering unless it's isolated behind its own Suspense boundary — everything
// else on the page is client-only anyway (wallet-gated), so the fallback below
// never really shows in practice.
const Margin = () => (
  <Suspense fallback={null}>
    <MarginPageContent basePath="/margin" />
  </Suspense>
);

export default Margin;
