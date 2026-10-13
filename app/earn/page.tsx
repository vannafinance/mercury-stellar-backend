"use client";

/**
 * Earn landing (V3 design): promo banner, the wallet's Overall Deposit / Net Earnings charts,
 * and Vaults | Positions. `/earn?tab=positions` opens the Positions tab (deep link from Portfolio's
 * Lender "Current Positions" row).
 */
import { use } from "react";
import { EarnList } from "@/components/earn/v3/earn-list";

export default function Earn({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = use(searchParams);
  return (
    <main className="v3">
      <div className="page">
        <EarnList initialTab={tab === "positions" ? "positions" : "vaults"} />
      </div>
    </main>
  );
}
