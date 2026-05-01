"use client";

import { useMemo, useState } from "react";
import { motion, AnimatePresence, type Variants } from "framer-motion";
import { useTheme } from "@/contexts/theme-context";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { OneClickStrategy } from "./one-click-strategy";
import { OnboardingTutorial } from "./onboarding-tutorial";
import { PositionsList } from "./positions-list";
import { PositionDetail } from "./position-detail";
import { MOCK_LITE_POSITIONS, buildRealPositions } from "./lite-position-types";
import { aggregateByPool } from "./lite-position-math";

const containerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1, delayChildren: 0.05 },
  },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" } },
};

type LiteTab = "deposit" | "position";

export const LiteHome = () => {
  const { isDark } = useTheme();
  const [activeTab, setActiveTab] = useState<LiteTab>("deposit");
  const [selectedPositionId, setSelectedPositionId] = useState<string | null>(null);

  const hasMarginAccount = useMarginAccountInfoStore((s) => s.hasMarginAccount);
  const totalCollateralValue = useMarginAccountInfoStore((s) => s.totalCollateralValue);
  const totalBorrowedValue = useMarginAccountInfoStore((s) => s.totalBorrowedValue);
  const borrowedBalances = useMarginAccountInfoStore((s) => s.borrowedBalances);
  const avgHealthFactor = useMarginAccountInfoStore((s) => s.avgHealthFactor);

  /* Build positions: prefer real on-chain data when the user has an active
     margin account with borrowed balances; fall back to Stellar-themed mocks. */
  const positions = useMemo(() => {
    if (hasMarginAccount && Object.keys(borrowedBalances).length > 0) {
      const hf = avgHealthFactor > 0
        ? avgHealthFactor
        : totalBorrowedValue > 0 ? totalCollateralValue / totalBorrowedValue : 999;
      const real = buildRealPositions(borrowedBalances, totalCollateralValue, hf);
      if (real.length > 0) return aggregateByPool(real);
    }
    return aggregateByPool(MOCK_LITE_POSITIONS);
  }, [hasMarginAccount, borrowedBalances, totalCollateralValue, totalBorrowedValue, avgHealthFactor]);

  const hasPosition = positions.length > 0;

  const selectedPosition = useMemo(
    () => positions.find((p) => p.id === selectedPositionId) ?? null,
    [positions, selectedPositionId]
  );

  const mutedText = isDark ? "text-[#595959]" : "text-[#A9A9A9]";
  const headingText = isDark ? "text-white" : "text-[#111111]";
  const subtleBg = isDark ? "bg-[#1A1A1A] border-[#2C2C2C]" : "bg-white border-[#E5E7EB]";

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="w-full flex flex-col gap-4 sm:gap-5"
    >
      <OnboardingTutorial />

      {/* Hero Section */}
      <motion.div variants={itemVariants} className="w-full flex flex-col gap-1.5">
        <h1
          className={`text-[18px] sm:text-[22px] lg:text-[26px] font-bold leading-tight ${headingText}`}
        >
          Leveraged Yield
        </h1>
        <p
          className={`text-[12px] sm:text-[13px] leading-[20px] max-w-[560px] ${
            isDark ? "text-[#919191]" : "text-[#76737B]"
          }`}
        >
          Deposit collateral, borrow up to 7x undercollateralized credit, and deploy to top lending pools in one click.
        </p>
      </motion.div>

      {/* Tab Switcher */}
      <motion.div variants={itemVariants} className="w-full flex items-center">
        <div
          className={`relative grid grid-cols-2 items-center h-[44px] w-full sm:w-[360px] rounded-[12px] p-[4px] select-none ${
            isDark ? "bg-[#1A1A1A] border border-[#2C2C2C]" : "bg-[#F4F4F4] border border-[#E5E7EB]"
          }`}
          role="tablist"
        >
          <motion.div
            className="absolute top-[4px] bottom-[4px] rounded-[9px] bg-gradient"
            animate={{
              left: activeTab === "deposit" ? "4px" : "50%",
              right: activeTab === "deposit" ? "50%" : "4px",
            }}
            transition={{ type: "spring", stiffness: 500, damping: 35 }}
          />
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "deposit"}
            onClick={() => setActiveTab("deposit")}
            className={`relative z-10 h-full flex items-center justify-center text-[13px] font-semibold leading-[20px] transition-colors rounded-[9px] whitespace-nowrap ${
              activeTab === "deposit" ? "text-white" : mutedText
            }`}
          >
            Deposit & Deploy
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "position"}
            onClick={() => setActiveTab("position")}
            className={`relative z-10 h-full flex items-center justify-center gap-2 text-[13px] font-semibold leading-[20px] transition-colors rounded-[9px] whitespace-nowrap ${
              activeTab === "position" ? "text-white" : mutedText
            }`}
          >
            Position
            {hasPosition && (
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  activeTab === "position" ? "bg-white" : "bg-[#703AE6]"
                }`}
              />
            )}
          </button>
        </div>
      </motion.div>

      {/* Tab Content */}
      <AnimatePresence mode="wait">
        {activeTab === "deposit" ? (
          <motion.div
            key="deposit"
            variants={itemVariants}
            initial="hidden"
            animate="visible"
            exit={{ opacity: 0, y: 8, transition: { duration: 0.2 } }}
          >
            <OneClickStrategy />
          </motion.div>
        ) : (
          <motion.div
            key="position"
            variants={itemVariants}
            initial="hidden"
            animate="visible"
            exit={{ opacity: 0, y: 8, transition: { duration: 0.2 } }}
          >
            {hasPosition ? (
              selectedPosition ? (
                <PositionDetail
                  position={selectedPosition}
                  onBack={() => setSelectedPositionId(null)}
                  onExitSuccess={() => setSelectedPositionId(null)}
                />
              ) : (
                <PositionsList
                  positions={positions}
                  onSelect={(id) => setSelectedPositionId(id)}
                />
              )
            ) : (
              <div
                className={`w-full rounded-[16px] border ${subtleBg} p-8 sm:p-10 flex flex-col items-center justify-center gap-4 text-center`}
              >
                <div
                  className={`w-14 h-14 rounded-full flex items-center justify-center ${
                    isDark ? "bg-[#2C2C2C]" : "bg-[#F4F4F4]"
                  }`}
                >
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M3 12h4l3-9 4 18 3-9h4"
                      stroke={isDark ? "#703AE6" : "#703AE6"}
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
                <div className="flex flex-col gap-1.5 max-w-[380px]">
                  <h3 className={`text-[15px] sm:text-[16px] font-semibold ${headingText}`}>
                    No open position
                  </h3>
                  <p className={`text-[12px] sm:text-[13px] leading-[20px] ${mutedText}`}>
                    Deposit collateral and deploy a strategy to see your position and exit controls here.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab("deposit")}
                  className="bg-gradient text-white text-[13px] font-semibold px-5 py-2.5 rounded-[10px] hover:opacity-90 transition-opacity"
                >
                  Start Earning
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};
