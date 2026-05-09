"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader, PageHeaderMeta } from "@/components/analytics/PageHeader";
import RiskExplorer from "@/components/analytics/risk-explorer/RiskExplorer";
import { mapSnapshotsToWallets, TOKEN_PRICES } from "@/components/analytics/risk-explorer/constants";
import { useAnalyticsOnchainStore } from "@/lib/analytics/onchain/store";
import { useUserStore } from "@/store/user";
import { readOracleSnapshot } from "@/lib/analytics/stellar/rpcReader";
import { ACTIVE_ASSETS, type StellarAsset } from "@/lib/analytics/stellar/canon";

export default function RiskExplorerPage() {
  const userAddress = useUserStore((s) => s.address);
  const snapshot = useAnalyticsOnchainStore((s) => s.result);
  const load = useAnalyticsOnchainStore((s) => s.load);
  const [livePrices, setLivePrices] = useState<Record<StellarAsset, number>>(TOKEN_PRICES);

  useEffect(() => {
    void load(userAddress);
  }, [load, userAddress]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const pull = async () => {
      try {
        const oracle = await readOracleSnapshot();
        if (cancelled) return;
        const next: Record<StellarAsset, number> = { ...TOKEN_PRICES };
        for (const p of oracle.prices) next[p.symbol] = p.priceUsd;
        setLivePrices(next);
      } catch {
        // keep fallback prices
      } finally {
        if (!cancelled) {
          timer = setTimeout(pull, 30_000);
        }
      }
    };

    void pull();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

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
          No on-chain margin positions loaded. Connect your wallet and open a SmartAccount with collateral/debt — stress tools only use real contract-derived
          snapshots (no synthetic fill).
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
