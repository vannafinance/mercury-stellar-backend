"use client";

/**
 * One Earn pool (V3 design): stats, Positions / Details / Activity / Collateral / Analytics and the
 * Supply / Withdraw form. `?tab=your-positions` opens the Positions tab (deep link from Portfolio's
 * Lender "Current Positions" row) and `?action=supply|withdraw` preselects the form's mode.
 */
import { use } from "react";
import { EarnPool } from "@/components/earn/v3/earn-pool";

export default function EarnPoolPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; action?: string }>;
}) {
  const { id } = use(params);
  const { tab, action } = use(searchParams);
  return (
    <main className="v3">
      <div className="page">
        <EarnPool
          key={id}
          id={id}
          initialTab={tab === "your-positions" || tab === "positions" ? "positions" : "details"}
          initialMode={action === "withdraw" ? "withdraw" : "supply"}
        />
      </div>
    </main>
  );
}
