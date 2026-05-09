"use client";

import { useEffect, useMemo } from "react";
import { PageHeader, PageHeaderMeta } from "@/components/analytics/PageHeader";
import PositionsMonitor from "@/components/analytics/positions/PositionsMonitor";
import { mapSnapshotsToWallets } from "@/components/analytics/risk-explorer/constants";
import { useAnalyticsOnchainStore } from "@/lib/analytics/onchain/store";
import { useUserStore } from "@/store/user";

export default function PositionsPage() {
  const userAddress = useUserStore((s) => s.address);
  const snapshot = useAnalyticsOnchainStore((s) => s.result);
  const load = useAnalyticsOnchainStore((s) => s.load);

  useEffect(() => {
    void load(userAddress);
  }, [load, userAddress]);

  const wallets = useMemo(
    () => (snapshot ? mapSnapshotsToWallets(snapshot.accounts) : []),
    [snapshot],
  );

  const timeStr = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="p-6 w-full max-w-[1600px] mx-auto space-y-8">
      <PageHeader
        title="Positions"
        subtitle="Health factor distribution, borrow rates, leverage, HF heatmap, and expandable positions by bucket"
        meta={<PageHeaderMeta timeLabel={timeStr} mock={false} />}
      />

      <PositionsMonitor wallets={wallets} chainName="Stellar (Soroban testnet)" />
    </div>
  );
}
