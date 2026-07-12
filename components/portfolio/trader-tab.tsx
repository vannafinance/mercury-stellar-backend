"use client";

import { useState } from "react";

import { Positionstable } from "@/components/margin/positions-table";
import { FarmSection } from "./farm-section";
import { SpotSection } from "./spot-section";
import { useTheme } from "@/contexts/theme-context";
import { useShallow } from "zustand/shallow";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useAccountSnapshot } from "@/hooks/use-account-snapshot";
import { deriveMarginHealth } from "@/lib/margin-health";

const fmtUsd = (n: number): string =>
  `$${(n < 0 ? 0 : n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtHF = (hf: number): string => (!Number.isFinite(hf) || hf >= 999 ? "∞" : hf.toFixed(2));

const TRADE_TABS = ["Margin", "Spot", "Perps", "Farm"] as const;
type TradeTab = (typeof TRADE_TABS)[number];

type MarginStat = { id: string; label: string; value: string; special?: string };

const InfoIcon = ({ isDark }: { isDark: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" className="flex-shrink-0">
    <path
      d="M6 3.33333H7.33333V4.66667H6V3.33333ZM6 6H7.33333V10H6V6ZM6.66667 0C2.98667 0 0 2.98667 0 6.66667C0 10.3467 2.98667 13.3333 6.66667 13.3333C10.3467 13.3333 13.3333 10.3467 13.3333 6.66667C13.3333 2.98667 10.3467 0 6.66667 0ZM6.66667 12C3.72667 12 1.33333 9.60667 1.33333 6.66667C1.33333 3.72667 3.72667 1.33333 6.66667 1.33333C9.60667 1.33333 12 3.72667 12 6.66667C12 9.60667 9.60667 12 6.66667 12Z"
      fill={isDark ? "#A0A0A0" : "#777777"}
    />
  </svg>
);

const MarginStatsGrid = ({ isDark }: { isDark: boolean }) => {
  const d = isDark;
  const border = d ? "border-[#2D2D2D]" : "border-[#E8E8E8]";
  const labelClass = `text-[13px] font-medium leading-tight ${d ? "text-[#A0A0A0]" : "text-[#777777]"}`;
  const valueClass = `text-[20px] font-bold leading-tight ${d ? "text-white" : "text-[#111]"}`;
  const [showHFTooltip, setShowHFTooltip] = useState(false);

  // Real margin-account figures — same snapshot/store the margin page + Portfolio
  // header read. Interest-accrued has no clean on-chain source yet → "—".
  const userAddress = useUserStore((s) => s.address);
  const { snapshot } = useAccountSnapshot(userAddress);
  const store = useMarginAccountInfoStore(
    useShallow((s) => ({
      gross: s.grossCollateralValue,
      collat: s.totalCollateralValue,
      borrowed: s.totalBorrowedValue,
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

  const stats = [
    { id: "totalMarginBalance", label: "Total Margin Balance", value: fmtUsd(collat) },
    { id: "totalCollateralDeposited", label: "Total Collateral Deposited", value: fmtUsd(gross) },
    { id: "totalLoanTaken", label: "Total Loan Taken", value: fmtUsd(borrowed) },
    { id: "crossAccountLeverage", label: "Cross Account Leverage", value: `${leverage.toFixed(2)}x/10x`, special: "leverage" },
    { id: "healthFactor", label: "Health Factor", value: fmtHF(health.avgHealthFactor), special: "gauge" },
    { id: "crossMarginRatio", label: "Cross Margin Ratio", value: `${ltv.toFixed(1)}%` },
    { id: "collateralLeftBeforeLiquidation", label: "Collateral Left Before Liquidation", value: fmtUsd(health.collateralLeftBeforeLiquidation) },
    { id: "netBorrowedInterestAccrued", label: "Net Borrowed Interest Accrued", value: "—" },
  ];
  const row1 = stats.slice(0, 4);
  const row2 = stats.slice(4, 8);

  const renderGauge = (stat: MarginStat) => (
    <div className="flex flex-col gap-2">
      <div className={`flex items-center gap-1 ${labelClass}`}>
        {stat.label}
        <div
          className="relative flex items-center"
          onMouseEnter={() => setShowHFTooltip(true)}
          onMouseLeave={() => setShowHFTooltip(false)}
        >
          <InfoIcon isDark={d} />
          {showHFTooltip && (
            <div
              className={`absolute bottom-[18px] left-1/2 -translate-x-1/2 w-[220px] px-3 py-2 rounded-[8px] text-[12px] leading-[1.5] font-medium shadow-md border z-50 pointer-events-none ${
                d ? "bg-[#2a2a2a] border-[#3a3a3a] text-[#ccc]" : "bg-white border-[#E8E8E8] text-[#374151]"
              }`}
            >
              Measures collateral safety. Values above&nbsp;1.5 are healthy; below&nbsp;1.1 risks liquidation.
            </div>
          )}
        </div>
      </div>
      <span className={valueClass}>{stat.value}</span>
    </div>
  );

  const renderCell = (stat: MarginStat) => {
    if (stat.special === "gauge") return renderGauge(stat);
    if (stat.special === "leverage") {
      const [current, max] = stat.value.split("/");
      return (
        <div className="flex flex-col gap-2">
          <span className={labelClass}>{stat.label}</span>
          <div className="flex items-baseline gap-1">
            <span className={valueClass}>{current}</span>
            <span className={`text-[14px] font-medium ${d ? "text-[#A0A0A0]" : "text-[#777777]"}`}>/ {max}</span>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-2">
        <span className={labelClass}>{stat.label}</span>
        <span className={valueClass}>{stat.value}</span>
      </div>
    );
  };

  return (
    <div className={`w-full rounded-[16px] overflow-hidden border ${border} ${d ? "bg-[#222222]" : "bg-[#f7f7f7]"}`}>
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
  const [activeSubTab, setActiveSubTab] = useState<TradeTab>("Margin");

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
          <Positionstable />
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
