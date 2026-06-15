"use client";

import { useMemo } from "react";
import { PageHeader, PageHeaderMeta } from "@/components/analytics/PageHeader";
import RiskExplorer from "@/components/analytics/risk-explorer/RiskExplorer";
import { mapSnapshotsToWallets, TOKEN_PRICES } from "@/components/analytics/risk-explorer/constants";
import { useAnalyticsSnapshot, useOracleSnapshot } from "@/hooks/use-analytics";
import { useUserStore } from "@/store/user";
import { ACTIVE_ASSETS, type StellarAsset } from "@/lib/analytics/stellar/canon";

export default function RiskExplorerPage() {
  const userAddress = useUserStore((s) => s.address);
  const { result: snapshot } = useAnalyticsSnapshot(userAddress);
  const { data: oracle } = useOracleSnapshot();

  const livePrices = useMemo<Record<StellarAsset, number>>(() => {
    const next: Record<StellarAsset, number> = { ...TOKEN_PRICES };
    if (oracle) for (const p of oracle.prices) next[p.symbol] = p.priceUsd;
    return next;
  }, [oracle]);

  const wallets = useMemo(
    () => (snapshot ? mapSnapshotsToWallets(snapshot.accounts) : []),
    [snapshot],
  );
  const hasLiveWallets = wallets.length > 0;
  const timeStr = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="p-6 w-full max-w-[1600px] mx-auto space-y-8">
      <PageHeader
        title="Risk explorer"
        subtitle="Baseline bad debt, stress heatmap, presets, and manual shocks against the Vanna Stellar deployment"
        meta={<PageHeaderMeta timeLabel={timeStr} mock={false} />}
      />

      {!hasLiveWallets && (
        <p className="rounded-r4 border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-900">
          No on-chain margin positions loaded yet. Stress tools render as soon as any margin account on the protocol has collateral/debt — they only use
          real contract-derived snapshots (no synthetic fill).
        </p>
      )}

      <RiskExplorer
        wallets={wallets}
        chainName="Stellar (Soroban testnet)"
        tokenPrices={ACTIVE_ASSETS.reduce((acc, s) => {
          acc[s] = livePrices[s] ?? TOKEN_PRICES[s];
          return acc;
        }, {} as Record<StellarAsset, number>)}
      />
    </div>
  );
}
