"use client";

import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { LeverageAssetsTab } from "./leverage-assets-tab";
import { RepayLoanTab } from "./repay-loan-tab";
import { TransferCollateral } from "./transfer-collateral";
import { LiquidateTab } from "./liquidate-tab";
import { AnimatedTabs, TabItem } from "../ui/animated-tabs";
import { LEVERAGE_TABS } from "@/lib/constants/margin";
import { useTheme } from "@/contexts/theme-context";

interface LeverageCollateralProps {
  /** When toggled true, forces the panel onto the Repay tab (e.g. a row-level Repay click). */
  switchToRepayTab?: boolean;
  /** Called after an external repay-tab switch is honoured, so the parent can reset its trigger. */
  onTabSwitched?: () => void;
  /** Asset symbol to preselect in the Repay tab when the switch is triggered. */
  prefilledRepayAsset?: string;
}

/**
 * Tabbed container for the three margin actions — Leverage Assets (deposit +
 * borrow), Repay Loan, and Transfer Collateral. Owns only the active-tab state
 * and renders the matching child tab; the per-action logic lives in those
 * children. Supports being driven externally onto the Repay tab (with a
 * prefilled asset) via {@link LeverageCollateralProps.switchToRepayTab}.
 */
export const LeverageCollateral = ({
  switchToRepayTab,
  onTabSwitched,
  prefilledRepayAsset,
}: LeverageCollateralProps = {}) => {
  const { isDark } = useTheme();
  const [activeTab, setActiveTab] = useState<string>("leverage-assets");

  // Handle external repay click trigger - change tab when repay is clicked
  useEffect(() => {
    if (switchToRepayTab) {
      setActiveTab("repay-loan");
      if (onTabSwitched) {
        onTabSwitched();
      }
    }
  }, [switchToRepayTab, onTabSwitched]);

  // Handle tab change
  const handleTabChange = (tabId: string) => {
    setActiveTab(tabId);
  };

  // Use tabs from constants
  const tabs: TabItem[] = [...LEVERAGE_TABS] as TabItem[];

  // Render content based on active tab
  const renderContent = () => {
    switch (activeTab) {
      case "leverage-assets":
        return <LeverageAssetsTab />;
      case "repay-loan":
        return <RepayLoanTab prefilledAsset={prefilledRepayAsset} />;
      case "transfer-collateral":
        return <TransferCollateral />;
      case "liquidate":
        return <LiquidateTab />;
      default:
        return <LeverageAssetsTab />;
    }
  };

  return (
    <motion.section
      className={`flex flex-col justify-between rounded-2xl border py-3 sm:py-4 px-3 sm:px-5 w-full min-w-0 h-fit ${
        isDark ? "bg-[#222222] border-[#333333]" : "bg-[#F7F7F7] border-[#E5E7EB]"
      }`}
      initial={{ opacity: 0, scale: 0.95 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={{ once: true }}
      transition={{ duration: 0.4, ease: "easeOut" }}
    >
      <nav>
        <AnimatedTabs
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={handleTabChange}
          type="border"
          containerClassName={`w-full rounded-xl border p-1 ${isDark ? "bg-[#111111] border-[#333333]" : "bg-white border-[#E5E7EB]"}`}
          tabClassName="!h-9 sm:!h-11 !text-[11px] sm:!text-[13px] !flex-1 !px-2 sm:!px-5"
        />
      </nav>
      {/* Tab content */}
      <section className="mt-3 sm:mt-4 min-w-0 w-full">{renderContent()}</section>
    </motion.section>
  );
};
