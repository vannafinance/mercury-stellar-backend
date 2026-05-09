"use client";

import { useMemo } from "react";
import { PageHeader, PageHeaderMeta } from "@/components/analytics/PageHeader";
import RiskExplorer from "@/components/analytics/risk-explorer/RiskExplorer";
import { generateWallets } from "@/components/analytics/risk-explorer/constants";

// Stellar testnet — passed as a deterministic seed to `generateWallets`.
// Vanna's Soroban deployment uses the SDF testnet passphrase
// "Test SDF Network ; September 2015"; we hash that to a stable integer
// so the synthetic wallet population stays reproducible across reloads.
const STELLAR_TESTNET_SEED = 9_481;

export default function RiskExplorerPage() {
  const wallets = useMemo(() => generateWallets(STELLAR_TESTNET_SEED), []);
  const timeStr = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="p-6 w-full max-w-[1600px] mx-auto space-y-8">
      <PageHeader
        title="Risk explorer"
        subtitle="Baseline bad debt, stress heatmap, presets, and manual shocks against the Vanna Stellar deployment"
        meta={<PageHeaderMeta timeLabel={timeStr} />}
      />

      <RiskExplorer wallets={wallets} chainName="Stellar (Soroban testnet)" />
    </div>
  );
}
