"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Positionstable } from "@/components/margin/positions-table";
import { FarmSection } from "./farm-section";
import { SpotSection } from "./spot-section";
import { useTheme } from "@/contexts/theme-context";
import { useShallow } from "zustand/shallow";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useAccountSnapshot } from "@/hooks/use-account-snapshot";
import { deriveMarginHealth } from "@/lib/margin-health";
import { useMarginHistory } from "@/hooks/use-margin";
import { useTokenPrices } from "@/hooks/use-token-prices";
import {
  buildNetBorrowCashByToken,
  calculateAccruedBorrowInterest,
  canonicalMarginPositionToken,
} from "@/lib/margin-position-attribution";
import { InfoTooltip } from "@/components/ui/info-tooltip";

const fmtUsd = (n: number): string =>
  `$${(n < 0 ? 0 : n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtHF = (hf: number): string => (!Number.isFinite(hf) || hf >= 999 ? "∞" : hf.toFixed(2));

const TRADE_TABS = ["Margin", "Spot", "Farm"] as const;
type TradeTab = (typeof TRADE_TABS)[number];

type MarginStat = { id: string; label: string; value: string; special?: string; tooltip: string };

const MarginStatsGrid = ({ isDark }: { isDark: boolean }) => {
  const d = isDark;
  const border = d ? "border-[#2D2D2D]" : "border-[#E8E8E8]";
  const labelClass = `text-[13px] font-medium leading-tight ${d ? "text-[#A0A0A0]" : "text-[#777777]"}`;
  const valueClass = `text-[20px] font-bold leading-tight ${d ? "text-white" : "text-[#111]"}`;

  // Real margin-account figures — same snapshot/store the margin page + Portfolio
  // header read. Borrowed interest combines live on-chain debt with the same
  // Mercury/RPC event history used by the Positions tooltips.
  const userAddress = useUserStore((s) => s.address);
  const { snapshot } = useAccountSnapshot(userAddress);
  const store = useMarginAccountInfoStore(
    useShallow((s) => ({
      gross: s.grossCollateralValue,
      collat: s.totalCollateralValue,
      borrowed: s.totalBorrowedValue,
      borrowedBalances: s.borrowedBalances,
    })),
  );
  const gross = snapshot?.grossCollateralValue ?? store.gross ?? 0;
  const collat = snapshot?.totalCollateralValue ?? store.collat ?? 0;
  const borrowed = snapshot?.totalBorrowedValue ?? store.borrowed ?? 0;
  const health = deriveMarginHealth({
    grossCollateralValue: gross,
    effectiveDebtValue: borrowed > 0.01 ? borrowed : 0,
    totalBorrowedValue: borrowed,
  });
  const leverage = collat > 0 ? Math.min(10, 1 + borrowed / collat) : 1;
  const ltv = gross > 0 ? (borrowed / gross) * 100 : 0;
  const { history, isLoading: historyLoading } = useMarginHistory();
  const interestPrices = useTokenPrices(["XLM", "USDC", "BLUSDC", "AQUSDC", "SOUSDC"]);
  const netBorrowedInterest = useMemo(() => {
    if (historyLoading) return 0;
    const netBorrowCash = buildNetBorrowCashByToken(history);
    const dedupedDebt = new Map<string, number>();
    for (const [rawAsset, balance] of Object.entries(store.borrowedBalances)) {
      const asset = canonicalMarginPositionToken(rawAsset);
      const amount = parseFloat(balance.amount || "0");
      if (amount > (dedupedDebt.get(asset) ?? 0)) dedupedDebt.set(asset, amount);
    }
    let totalUsd = 0;
    for (const [asset, currentDebt] of dedupedDebt) {
      const interest = calculateAccruedBorrowInterest(currentDebt, netBorrowCash.get(asset));
      if (interest === null) continue;
      totalUsd += interest * (interestPrices[asset] ?? 1);
    }
    return totalUsd;
  }, [history, historyLoading, interestPrices, store.borrowedBalances]);

  const stats = [
    { id: "totalMarginBalance", label: "Total Margin Balance", value: fmtUsd(collat), tooltip: "Current value held in your margin account." },
    { id: "totalCollateralDeposited", label: "Total Collateral Deposited", value: fmtUsd(gross), tooltip: "Collateral backing your margin positions." },
    { id: "totalLoanTaken", label: "Total Loan Taken", value: fmtUsd(borrowed), tooltip: "Outstanding debt, including interest." },
    { id: "crossAccountLeverage", label: "Cross Account Leverage", value: `${leverage.toFixed(2)}x/10x`, special: "leverage", tooltip: "Total exposure relative to margin balance." },
    { id: "healthFactor", label: "Health Factor", value: fmtHF(health.avgHealthFactor), special: "gauge", tooltip: "Liquidation safety. Higher is safer." },
    { id: "crossMarginRatio", label: "Cross Margin Ratio", value: `${ltv.toFixed(1)}%`, tooltip: "Borrowed value relative to collateral." },
    { id: "collateralLeftBeforeLiquidation", label: "Collateral Left Before Liquidation", value: fmtUsd(health.collateralLeftBeforeLiquidation), tooltip: "Safety buffer before liquidation." },
    { id: "netBorrowedInterestAccrued", label: "Net Borrowed Interest Accrued", value: fmtUsd(netBorrowedInterest), tooltip: "Interest accrued across borrowed assets." },
  ];
  const row1 = stats.slice(0, 4);
  const row2 = stats.slice(4, 8);

  const renderLabel = (stat: MarginStat) => (
    <div className={`flex items-center gap-1 ${labelClass}`}>
      <span>{stat.label}</span>
      <InfoTooltip content={stat.tooltip} label={`${stat.label} information`} placement="bottom" />
    </div>
  );

  const renderGauge = (stat: MarginStat) => (
    <div className="flex flex-col gap-2">
      {renderLabel(stat)}
      <span className={valueClass}>{stat.value}</span>
    </div>
  );

  const renderCell = (stat: MarginStat) => {
    if (stat.special === "gauge") return renderGauge(stat);
    if (stat.special === "leverage") {
      const [current, max] = stat.value.split("/");
      return (
        <div className="flex flex-col gap-2">
          {renderLabel(stat)}
          <div className="flex items-baseline gap-1">
            <span className={valueClass}>{current}</span>
            <span className={`text-[14px] font-medium ${d ? "text-[#A0A0A0]" : "text-[#777777]"}`}>/ {max}</span>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-2">
        {renderLabel(stat)}
        <span className={valueClass}>{stat.value}</span>
      </div>
    );
  };

  return (
    <div className={`w-full rounded-[16px] overflow-visible border ${border} ${d ? "bg-[#222222]" : "bg-[#f7f7f7]"}`}>
      <div className="grid grid-cols-2 lg:grid-cols-4">
        {row1.map((stat) => (
          <div key={stat.id} className="flex flex-col gap-2 px-5 py-4">
            {renderCell(stat)}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4">
        {row2.map((stat) => (
          <div key={stat.id} className="flex flex-col px-5 py-4">
            {renderCell(stat)}
          </div>
        ))}
      </div>
    </div>
  );
};

export const TraderTab = () => {
  const { isDark } = useTheme();
  const router = useRouter();
  const [activeSubTab, setActiveSubTab] = useState<TradeTab>("Margin");

  // Repay/Open-Position live on the Margin page's Leverage panel, not here —
  // hand off via a query param the Margin page reads on mount to switch to
  // its Repay tab pre-filled with this asset (see app/margin/page.tsx).
  const handleRepayClick = (asset?: string) => {
    router.push(asset ? `/margin?repay=${encodeURIComponent(asset)}` : "/margin");
  };

  const subTabBase = `flex-1 sm:flex-none sm:w-[101px] rounded-[8px] px-[8px] sm:px-[12px] py-[10px] text-[11px] sm:text-[12px] font-semibold cursor-pointer transition text-center`;
  const subTabActive = "bg-[#f1ebfd] text-[#703ae6]";
  const subTabInactive = isDark ? "text-white hover:bg-[#333]" : "text-[#111] hover:bg-[#f7f7f7]";

  return (
    <div className="w-full h-fit flex flex-col gap-[16px]">
      {/* Trade sub-tabs */}
      <div
        className={`flex items-center rounded-[8px] border-[1px] p-1 gap-1 w-full sm:w-fit overflow-x-auto ${
          isDark ? "bg-[#1a1a1a] border-[#333]" : "bg-white border-[#E8E8E8]"
        }`}
      >
        {TRADE_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveSubTab(tab)}
            className={`${subTabBase} ${activeSubTab === tab ? subTabActive : subTabInactive}`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Margin content */}
      {activeSubTab === "Margin" ? (
        <div className="w-full flex flex-col gap-[16px]">
          <MarginStatsGrid isDark={isDark} />

          {/* Positions Table — real on-chain margin positions */}
          <Positionstable onRepayClick={handleRepayClick} onOpenPositionClick={() => router.push("/margin")} />
        </div>
      ) : activeSubTab === "Farm" ? (
        <FarmSection />
      ) : activeSubTab === "Spot" ? (
        <SpotSection />
      ) : (
        <div
          className={`w-full h-[300px] rounded-[16px] border-[1px] flex items-center justify-center ${
            isDark ? "bg-[#222222] border-[#333]" : "bg-[#f7f7f7] border-[#E8E8E8]"
          }`}
        >
          <p className={`text-[14px] font-medium ${isDark ? "text-[#919191]" : "text-[#777777]"}`}>
            {activeSubTab} coming soon
          </p>
        </div>
      )}
    </div>
  );
};
