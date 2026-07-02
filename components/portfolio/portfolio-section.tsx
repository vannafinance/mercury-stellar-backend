"use client";

import { useState, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useAccountSnapshot } from "@/hooks/use-account-snapshot";
import { useTheme } from "@/contexts/theme-context";
import { Button } from "../ui/button";
import { AccountStats } from "../margin/account-stats";
import { AnimatedTabs } from "../ui/animated-tabs";
import { PORTFOLIO_STATS_ITEMS } from "@/lib/constants/portfolio";
import { LenderTab } from "./lender-tab";
import { TraderTab } from "./trader-tab";

const PORTFOLIO_TABS = [
  { id: "lender", label: "Lender" },
  { id: "trader", label: "Trader" },
];

export const PortfolioSection = () => {
  const userAddress = useUserStore((user) => user.address);
  const tokenBalances = useUserStore((user) => user.tokenBalances);
  const { isDark } = useTheme();
  const [activeTab, setActiveTab] = useState("lender");

  // Real account-level figures. Prefer the /api/account snapshot (warmed by the
  // connect-time prefetch, so the cards fill even on a first Portfolio visit),
  // falling back to the live store — the same source the margin header reads, so
  // Portfolio and Margin never disagree.
  const { snapshot } = useAccountSnapshot(userAddress);
  const store = useMarginAccountInfoStore(
    useShallow((s) => ({
      totalCollateralValue: s.totalCollateralValue,
      netAvailableCollateral: s.netAvailableCollateral,
      totalBorrowedValue: s.totalBorrowedValue,
    })),
  );
  const marginAccountBalance = snapshot?.totalCollateralValue ?? store.totalCollateralValue ?? 0;
  const netAvailableCollateral = snapshot?.netAvailableCollateral ?? store.netAvailableCollateral ?? 0;
  const totalBorrowed = snapshot?.totalBorrowedValue ?? store.totalBorrowedValue ?? 0;

  // Wallet (spendable) USD = Σ wallet token balance × live oracle price.
  const prices = useTokenPrices(["XLM", "USDC", "BLUSDC", "AQUSDC", "SOUSDC"]);
  const walletUsd = useMemo(() => {
    const priceKey = (sym: string): string =>
      sym === "BLEND_USDC" ? "BLUSDC"
      : sym === "AQUARIUS_USDC" ? "AQUSDC"
      : sym === "SOROSWAP_USDC" ? "SOUSDC"
      : sym;
    return Object.entries(tokenBalances).reduce((sum, [sym, amt]) => {
      const price = prices[priceKey(sym)] ?? 0;
      return sum + (parseFloat(String(amt)) || 0) * price;
    }, 0);
  }, [tokenBalances, prices]);

  const fmtUsd = (n: number) =>
    `$${(n < 0 ? 0 : n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const statsValues = {
    walletBalance: userAddress ? fmtUsd(walletUsd) : "-",
    marginAccountBalance: userAddress ? fmtUsd(marginAccountBalance) : "-",
    netAvailableCollateral: userAddress ? fmtUsd(netAvailableCollateral) : "-",
    totalBorrowed: userAddress ? fmtUsd(totalBorrowed) : "-",
  };

  return (
    <div className="w-full h-fit flex flex-col gap-[16px]">
      {/* Stats grid */}
      <AccountStats
        gridCols="grid-cols-4"
        items={PORTFOLIO_STATS_ITEMS}
        values={statsValues}
      />

      {/* Earnings / volume analytics — time-series deferred to the Mercury
          read-model (Sprint 2). No fabricated financials in the meantime. */}
      <div
        className={`w-full rounded-[16px] border px-5 py-6 flex flex-col items-center justify-center gap-1 text-center ${
          isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]"
        }`}
      >
        <span className={`text-[14px] font-semibold ${isDark ? "text-white" : "text-[#1A1A1A]"}`}>
          Earnings &amp; volume analytics
        </span>
        <span className="text-[12px] font-medium text-[#777777]">Coming soon</span>
      </div>

      {/* Tabs */}
      <div className="w-full h-fit flex flex-col">
        <AnimatedTabs
          type="underline"
          tabs={PORTFOLIO_TABS}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          containerClassName="w-fit"
          tabClassName="h-[40px] sm:h-[44px] text-[13px] sm:text-[14px] w-[100px] sm:w-[120px]"
        />

        {!userAddress ? (
          <div
            className={`w-full h-[260px] rounded-b-[20px] flex items-center justify-center ${
              isDark ? "bg-[#222222]" : "bg-[#F7F7F7]"
            }`}
          >
            <div className="w-[70px]">
              <Button text="Login" size="small" type="solid" disabled={false} />
            </div>
          </div>
        ) : (
          <div className="w-full h-fit pt-4 sm:pt-[16px]">
            {activeTab === "lender" && <LenderTab />}
            {activeTab === "trader" && <TraderTab />}
          </div>
        )}
      </div>
    </div>
  );
};
