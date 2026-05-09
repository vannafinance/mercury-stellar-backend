"use client";

import { useMemo } from "react";
import { PageHeader, PageHeaderMeta } from "@/components/analytics/PageHeader";
import RiskExplorer from "@/components/analytics/risk-explorer/RiskExplorer";
import { generateWallets } from "@/components/analytics/risk-explorer/constants";

/** Base mainnet — mock wallet distribution is keyed by chain id */
const BASE_CHAIN_ID = 8453;

export default function RiskExplorerPage() {
  const wallets = useMemo(() => generateWallets(BASE_CHAIN_ID), []);
  const timeStr = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="p-6 w-full max-w-[1600px] mx-auto space-y-8">
      <PageHeader
        title="Risk explorer"
        subtitle="Baseline bad debt, stress heatmap, presets, and manual shocks — mock positions"
        meta={<PageHeaderMeta timeLabel={timeStr} />}
      />

      <RiskExplorer wallets={wallets} chainName="Base" />
    </div>
  );
}
