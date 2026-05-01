"use client";

import { AccountStatsGhost } from "@/components/earn/account-stats-ghost";
import { Form } from "@/components/earn/form";
import { Details } from "@/components/earn/details-tab";
import { YourPositions } from "@/components/earn/your-positions";
import { AnimatedTabs } from "@/components/ui/animated-tabs";
import Image from "next/image";
import { useState, use, useMemo, useEffect, memo } from "react";
import { ActivityTab } from "@/components/earn/acitivity-tab";
import { AnalyticsTab } from "@/components/earn/analytics-tab";
import { MarginManagersTab } from "@/components/earn/margin-managers-tab";
import { CollateralLimitsTab } from "@/components/earn/collateral-limits-tab";
import { useEarnVaultStore } from "@/store/earn-vault-store";
import { iconPaths } from "@/lib/constants";
import { useRouter } from "next/navigation";
import { useTheme } from "@/contexts/theme-context";
import { setSelectedPool, useSelectedPoolStore } from "@/store/selected-pool-store";
import { AssetType } from "@/lib/stellar-utils";
import { usePoolData } from "@/hooks/use-earn";
import { useTokenPrices } from "@/contexts/price-context";

const fmt = (n: number, decimals = 4) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M`
  : n >= 1_000 ? `${(n / 1_000).toFixed(2)}K`
  : n.toFixed(decimals);

const EarnHeaderStats = memo(function EarnHeaderStats({ assetTitle }: { assetTitle: string }) {
  const { pools } = usePoolData();
  const { getPrice } = useTokenPrices();

  const items = useMemo(() => {
    const asset = toInternalAsset(assetTitle);
    const displayAsset = toDisplayAsset(assetTitle);
    const pool = pools[asset as keyof typeof pools];
    const price = getPrice(asset);

    const totalSupply = parseFloat(pool?.totalSupply || '0');
    const availableLiquidity = parseFloat(pool?.availableLiquidity || '0');
    const utilizationRate = parseFloat(pool?.utilizationRate || '0');
    const supplyAPY = parseFloat(pool?.supplyAPY || '0');

    return [
      { id: "1", name: "Total Supply", amount: `$${fmt(totalSupply * price, 2)}`, amountInToken: `${fmt(totalSupply)} ${displayAsset}` },
      { id: "2", name: "Available Liquidity", amount: `$${fmt(availableLiquidity * price, 2)}`, amountInToken: `${fmt(availableLiquidity)} ${displayAsset}` },
      { id: "3", name: "Utilization Rate", amount: `${utilizationRate.toFixed(2)}%` },
      { id: "4", name: "Supply APY", amount: `${supplyAPY.toFixed(2)}%` },
    ];
  }, [pools, assetTitle, getPrice]);

  return <AccountStatsGhost items={items} />;
});

const tabs = [
  { id: "your-positions", label: "Your Positions", shortLabel: "Positions" },
  { id: "details", label: "Details" },
  { id: "activity", label: "Activity" },
  { id: "collateral-limits", label: "Collateral and Limits", shortLabel: "Collateral" },
  { id: "analytics", label: "Analytics" },
  { id: "margin-managers", label: "Margin Managers", shortLabel: "Managers" },
];

const toInternalAsset = (value: string): AssetType => {
  if (value === "AqUSDC" || value === "AquiresUSDC" || value === "AQUARIUS_USDC") return "AQUARIUS_USDC";
  if (value === "SoUSDC" || value === "SoroswapUSDC" || value === "SOROSWAP_USDC") return "SOROSWAP_USDC";
  if (value === "BLUSDC" || value === "USDC") return "USDC";
  return value.toUpperCase() as AssetType;
};

const toDisplayAsset = (value: string) => {
  if (value === "AQUARIUS_USDC" || value === "AquiresUSDC") return "AqUSDC";
  if (value === "SOROSWAP_USDC" || value === "SoroswapUSDC") return "SoUSDC";
  if (value === "USDC") return "BLUSDC";
  return value;
};

export default function EarnPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { isDark } = useTheme();
  const router = useRouter();
  const selectedVault = useEarnVaultStore((state) => state.selectedVault);
  const [activeTab, setActiveTab] = useState<string>("details");

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
  };

  const handleBackToPools = () => {
    router.push("/earn");
  };

  useEffect(() => {
    const assetType = toInternalAsset(id);
    if (assetType === 'XLM' || assetType === 'USDC' || assetType === 'AQUARIUS_USDC' || assetType === 'SOROSWAP_USDC') {
      const current = useSelectedPoolStore.getState();
      if (current.selectedAsset === assetType) return;
      setSelectedPool(assetType as AssetType, {
        id: toDisplayAsset(id),
        chain: assetType,
        title: toDisplayAsset(id),
        tag: "Active"
      });
    }
  }, [id]);

  // Get vault data - either from store or use id as fallback
  const vaultData = useMemo(() => {
    if (selectedVault && selectedVault.id === id) {
      return selectedVault;
    }
    const internalAsset = toInternalAsset(id);
    const displayAsset = toDisplayAsset(id);
    return {
      id: displayAsset,
      chain: internalAsset,
      title: displayAsset,
      tag: "Active",
    };
  }, [selectedVault, id]);

  const iconPath = useMemo(() => {
    const exact = iconPaths[vaultData.title];
    const uppercase = iconPaths[vaultData.title.toUpperCase()];
    return exact || uppercase || "/icons/stellar.svg";
  }, [vaultData.title]);

  return (
    <main className="flex flex-col gap-5">
      <header className="pt-4 sm:pt-5 px-4 sm:px-10 lg:px-30 w-full h-fit">
        <div className="w-full h-fit flex flex-col gap-3">
          <nav aria-label="Breadcrumb">
            <button
              type="button"
              onClick={handleBackToPools}
              className={`w-fit h-fit flex gap-[10px] items-center cursor-pointer text-[15px] font-medium hover:text-[#703AE6] transition-colors ${
                isDark ? "text-white" : "text-[#5A5555]"
              }`}
            >
              <svg width="8" height="14" viewBox="0 0 9 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M8 1L1 8L8 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Back to pools
            </button>
          </nav>
          <div className="w-full h-fit flex gap-3 items-center">
            <Image
              src={iconPath}
              alt={`${vaultData.title}-icon`}
              width={34}
              height={34}
              className="w-7 h-7 sm:w-[34px] sm:h-[34px]"
            />
            <div className="w-fit h-fit flex gap-2 items-center flex-wrap">
              <h1 className={`w-fit h-fit text-[20px] sm:text-[25px] font-bold ${isDark ? "text-white" : "text-[#181822]"}`}>
                {vaultData.title}
              </h1>
              <div className="w-fit h-fit flex gap-1.5 items-center">
                <span className="text-[11px] sm:text-[13px] font-semibold text-center w-fit h-fit rounded-[4px] py-[2px] px-[6px] bg-[#703AE6] text-white">
                  {vaultData.tag}
                </span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <section className="px-4 sm:px-10 lg:px-30" aria-label="Vault Statistics">
        <EarnHeaderStats assetTitle={vaultData.title} />
      </section>

      <section className="px-4 sm:px-10 lg:px-30 pt-1 pb-24 xl:pb-16 w-full h-fit" aria-label="Vault Details and Actions">
        <div className="flex flex-col xl:flex-row gap-5 xl:gap-4 w-full h-fit">
          <article className="flex-1 min-w-0 h-full flex flex-col gap-3">
            <nav className="w-full overflow-x-auto no-scrollbar" aria-label="Vault Information Tabs">
              <AnimatedTabs
                tabs={tabs}
                activeTab={activeTab}
                onTabChange={handleTabChange}
                type="border"
                shortLabelBelow="2xl"
                containerClassName={`w-full rounded-xl border p-1 ${isDark ? "bg-[#111111] border-[#333333]" : "bg-white border-[#E5E7EB]"}`}
                tabClassName="!flex-1 !h-10 !px-2 !text-[12px] whitespace-nowrap"
              />
            </nav>
            {activeTab === "your-positions" && <YourPositions />}
            {activeTab === "details" && <Details />}
            {activeTab === "activity" && <ActivityTab />}
            {activeTab === "analytics" && <AnalyticsTab />}
            {activeTab === "margin-managers" && <MarginManagersTab />}
            {activeTab === "collateral-limits" && <CollateralLimitsTab />}
          </article>
          <aside className="w-full xl:w-[420px] shrink-0 flex flex-col gap-3 xl:sticky xl:top-4 xl:self-start" aria-label="Transaction Form">
            <Form />

            {/* How it works */}
            <div className={`w-full rounded-2xl border p-4 flex flex-col gap-3 ${
              isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#EEEEEE]"
            }`}>
              <p className={`text-[13px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
                How it works
              </p>
              <div className="flex flex-col gap-3">
                {[
                  { step: "1", title: "Supply assets", desc: `Deposit ${vaultData.title} into the vault to provide liquidity` },
                  { step: "2", title: "Receive vault shares", desc: `Get b${vaultData.title} tokens representing your share of the pool` },
                  { step: "3", title: "Earn yield", desc: "Borrowers pay interest which accrues to your position automatically" },
                  { step: "4", title: "Withdraw anytime", desc: "Redeem your vault shares for the underlying asset plus earned yield" },
                ].map((item) => (
                  <div key={item.step} className="flex gap-3 items-start">
                    <div className="w-6 h-6 rounded-full bg-[#703AE6]/10 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-[11px] font-bold text-[#703AE6]">{item.step}</span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className={`text-[13px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>{item.title}</span>
                      <span className={`text-[12px] font-medium leading-relaxed ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}>{item.desc}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
