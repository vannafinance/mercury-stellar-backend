"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Notice } from "@/components/analytics/v3/ui";

/**
 * Scenario pages (/analytics/risk-explorer/*) run on a modelled sample portfolio, not on the live
 * accounts: say so above each one, with the way back to the live tools.
 */
export default function RiskExplorerLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const scenario = pathname !== "/analytics/risk-explorer";
  return (
    <>
      {scenario && (
        <Notice tone="warn">
          <strong>Modelled scenario.</strong> This page runs on a sample portfolio to show the mechanism - its accounts and figures are not the live Vanna accounts.{" "}
          <Link href="/analytics/risk-explorer">Back to Risk Explorer</Link> or use the <Link href="/analytics/what-if">What-if Calculator</Link> for the real accounts.
        </Notice>
      )}
      {children}
    </>
  );
}
