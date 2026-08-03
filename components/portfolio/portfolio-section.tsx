"use client";

import { useState, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useUserPositions, useEarnTransactions } from "@/hooks/use-earn";
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

  // Wallet (spendable) USD = XLM + Circle USDC only. Ignore leftover protocol-
  // flavored keys that may still exist in persisted zustand from testnet.
  const prices = useTokenPrices(["XLM", "USDC"]);
  const walletUsd = useMemo(() => {
    return (["XLM", "USDC"] as const).reduce((sum, sym) => {
      const price = prices[sym] ?? 0;
      return sum + (parseFloat(String(tokenBalances[sym] ?? "0")) || 0) * price;
    }, 0);
  }, [tokenBalances, prices]);

  // Net Earnings = Σ (current deposited value − net principal) × oracle price
  // across supplied pools. Net principal is Σ supply − Σ withdraw from real
  // Mercury-indexed history (withdraw amounts are the contract's own
  // `asset_amount`, the real underlying transferred — not the vToken share
  // count, so this is an exact reconstruction, not an approximation). Same
  // pattern as the Margin Positions table's "interest accrued" and the Earn
  // page's "Net Earnings" calc. USDC-pegged variants price to USDC.
  const { positions } = useUserPositions();
  const { transactions: earnTx, isLoading: earnTxLoading } = useEarnTransactions();
  const netEarnings = useMemo(() => {
    const priceFor: Record<string, string> = {
      XLM: "XLM", USDC: "USDC",
    };
    if (earnTxLoading) return 0;
    const netPrincipalByAsset: Record<string, number> = {};
    for (const tx of earnTx) {
      const amt = parseFloat(tx.amount) || 0;
      if (!(amt > 0)) continue;
      const assetKey = tx.asset === "AQUARIUS_USDC" || tx.asset === "SOROSWAP_USDC" || tx.asset === "BLUSDC"
        ? "USDC"
        : tx.asset;
      netPrincipalByAsset[assetKey] = (netPrincipalByAsset[assetKey] ?? 0) +
        (tx.type === "supply" ? amt : -amt);
    }
    return (["XLM", "USDC"] as const).reduce((sum, asset) => {
      // A missing history entry means "we don't know this asset's principal",
      // NOT "principal is 0" — defaulting to 0 misreports the ENTIRE deposit
      // as earned yield whenever Mercury hasn't (yet) indexed this asset's
      // supply event. Same guard as the Earn page's identical calculation.
      if (!Object.prototype.hasOwnProperty.call(netPrincipalByAsset, asset)) return sum;
      const deposited = parseFloat(positions[asset]?.deposited ?? "0") || 0;
      const principal = Math.max(0, netPrincipalByAsset[asset]);
      const diff = deposited - principal;
      if (diff <= 0) return sum;
      const price = prices[priceFor[asset]] ?? (priceFor[asset] === "USDC" ? 1 : 0);
      return sum + diff * price;
    }, 0);
  }, [positions, prices, earnTx, earnTxLoading]);

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

      {/* Net Earnings — real accrued lending interest. The over-time chart is
          deferred to the Sprint-2 Mercury read-model, but the figure is live. */}
      <div
        className={`w-full rounded-[16px] border px-5 py-5 flex items-center justify-between ${
          isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]"
        }`}
      >
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] font-medium text-[#777777]">Net Earnings</span>
          <span className={`text-[22px] font-bold ${isDark ? "text-white" : "text-[#1A1A1A]"}`}>
            {userAddress ? fmtUsd(netEarnings) : "-"}
          </span>
          <span className="text-[11px] font-medium text-[#777777]">Accrued lending interest</span>
        </div>
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
