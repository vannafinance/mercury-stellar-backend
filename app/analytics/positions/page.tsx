"use client";

import { useMemo } from "react";
import { PageHeader, PageHeaderMeta } from "@/components/analytics/PageHeader";
import PositionsMonitor from "@/components/analytics/positions/PositionsMonitor";
import { generateWallets } from "@/components/analytics/risk-explorer/constants";

const BASE_CHAIN_ID = 8453;

export default function PositionsPage() {
  const wallets = useMemo(() => generateWallets(BASE_CHAIN_ID), []);
  const timeStr = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="p-6 w-full max-w-[1600px] mx-auto space-y-8">
      <PageHeader
        title="Positions"
        subtitle="Health factor distribution, borrow rates, leverage, HF heatmap, and expandable positions by bucket"
        meta={<PageHeaderMeta timeLabel={timeStr} />}
      />

      <PositionsMonitor
        wallets={wallets}
        chainName="Base"
        activeChainId={BASE_CHAIN_ID}
      />
    </div>
  );
}
