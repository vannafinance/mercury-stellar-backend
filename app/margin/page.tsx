"use client";

import { Carousel } from "@/components/ui/carousel";
import {
  CAROUSEL_ITEMS,
  MARGIN_ACCOUNT_INFO_ITEMS,
  MARGIN_ACCOUNT_MORE_DETAILS_ITEMS,
  MARGIN_ORACLE_LTS_ITEMS,
  ACCOUNT_STATS_ITEMS,
} from "@/lib/constants/margin";
import { motion, AnimatePresence } from "framer-motion";
import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import Image from "next/image";
import { InfoCard } from "@/components/margin/info-card";
import { LeverageCollateral } from "@/components/margin/leverage-collateral";
import { Positionstable } from "@/components/margin/positions-table";
import { AccountStats } from "@/components/margin/account-stats";
import {
  useMarginAccountInfoStore,
  refreshBorrowedBalances,
  checkUserMarginAccount,
} from "@/store/margin-account-info-store";
import { useUserStore } from "@/store/user";
import { formatValue } from "@/lib/utils/format-value";
import { useTheme } from "@/contexts/theme-context";
import { useShallow } from "zustand/shallow";
import { useSmartPolling } from "@/lib/hooks/useSmartPolling";

const Margin = () => {
  const { isDark } = useTheme();

  // State to trigger tab switch to Repay Loan
  const [switchToRepayTab, setSwitchToRepayTab] = useState(false);
  const [prefilledRepayAsset, setPrefilledRepayAsset] = useState<string | undefined>(undefined);
  const [marginError, setMarginError] = useState<string | null>(null);
  const [isLoadingMargin, setIsLoadingMargin] = useState(false);

  // Ref for scrolling to LeverageCollateral component
  const leverageCollateralRef = useRef<HTMLDivElement>(null);

  const scrollToLeverageSection = useCallback(() => {
    if (leverageCollateralRef.current) {
      leverageCollateralRef.current.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  }, []);

  // Scroll to LeverageCollateral when repay is clicked
  useEffect(() => {
    if (switchToRepayTab) {
      setTimeout(() => {
        scrollToLeverageSection();
      }, 100);
    }
  }, [switchToRepayTab]);

  // Wallet connection state — single shallow-compared read
  const { isWalletConnected, userAddress } = useUserStore(
    useShallow((state) => ({
      isWalletConnected: state.isConnected,
      userAddress: state.address,
    })),
  );

  // Margin account data — single shallow-compared read.
  const {
    hasMarginAccount,
    avgHealthFactor,
    totalCollateralValue,
    totalBorrowedValue,
    totalValue,
    collateralLeftBeforeLiquidation,
    netAvailableCollateral,
    timeToLiquidation,
    storeBorrowRate,
    storeIsLoading,
  } = useMarginAccountInfoStore(
    useShallow((state) => ({
      hasMarginAccount: state.hasMarginAccount,
      avgHealthFactor: state.avgHealthFactor,
      totalCollateralValue: state.totalCollateralValue,
      totalBorrowedValue: state.totalBorrowedValue,
      totalValue: state.totalValue,
      collateralLeftBeforeLiquidation: state.collateralLeftBeforeLiquidation,
      netAvailableCollateral: state.netAvailableCollateral,
      timeToLiquidation: state.timeToLiquidation,
      storeBorrowRate: state.borrowRate,
      storeIsLoading: state.isLoadingBorrowedBalances,
    })),
  );

  // Keep local loading state in sync with the store's loading state
  useEffect(() => {
    setIsLoadingMargin(storeIsLoading);
  }, [storeIsLoading]);

  // Reload margin data using Stellar backend functions.
  // The store's checkUserMarginAccount / refreshBorrowedBalances are rate-limited
  // internally, so polling here is safe and won't storm the RPC.
  const reloadMarginState = useCallback(async () => {
    if (!userAddress) return;

    setMarginError(null);

    try {
      await checkUserMarginAccount(userAddress);
      const accountAddress =
        useMarginAccountInfoStore.getState().marginAccountAddress;
      if (accountAddress) {
        await refreshBorrowedBalances(accountAddress);
      }
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : "Failed to load margin data";
      setMarginError(msg);
    }
  }, [userAddress]);

  // Poll every 15s while connected. Smart-polling pauses when the tab is
  // hidden or the user has been idle for 2+ minutes, and fires an immediate
  // refresh when the tab becomes visible again.
  useSmartPolling(
    reloadMarginState,
    [isWalletConnected, userAddress],
    { enabled: Boolean(isWalletConnected && userAddress), interval: 15_000 },
  );

  const accountStats = useMemo(() => {
    const hasAnyMarginData =
      hasMarginAccount || totalCollateralValue > 0 || totalBorrowedValue > 0;

    if (!hasAnyMarginData) {
      return null;
    }

    return {
      netHealthFactor: avgHealthFactor,
      collateralLeftBeforeLiquidation,
      netAvailableCollateral,
      netAmountBorrowed: totalBorrowedValue,
      // Realised P&L is 0 until proper deposit-history accounting is wired up;
      // showing totalValue here misled users into reading their own equity as
      // "profit". Once we track per-user cost basis we can compute
      //   P&L = current_collateral_value - cumulative_deposits + cumulative_withdrawals
      netProfitAndLoss: 0,
    };
  }, [
    avgHealthFactor,
    collateralLeftBeforeLiquidation,
    netAvailableCollateral,
    totalBorrowedValue,
    totalValue,
    hasMarginAccount,
    totalCollateralValue,
  ]);

  // Format data for InfoCard component (numeric values for Stellar backend's InfoCard)
  const marginAccountInfo = useMemo(() => {
    const hasAnyMarginData =
      hasMarginAccount || totalCollateralValue > 0 || totalBorrowedValue > 0;

    // Actual max debt = collateral / liquidation threshold (1.1)
    const actualDebtLimit = totalCollateralValue > 0
      ? parseFloat((totalCollateralValue / 1.1).toFixed(2))
      : 0;

    if (!hasAnyMarginData) {
      return {
        totalBorrowedValue: 0,
        totalCollateralValue: 0,
        totalValue: 0,
        avgHealthFactor: 0,
        timeToLiquidation: 0,
        borrowRate: 0,
        liquidationPremium: 0,
        liquidationFee: 0,
        debtLimit: 0,
        minDebt: 0,
        maxDebt: 0,
      };
    }

    return {
      totalBorrowedValue,
      totalCollateralValue,
      totalValue,
      avgHealthFactor,
      timeToLiquidation,
      borrowRate: storeBorrowRate,
      liquidationPremium: 0,
      liquidationFee: 0,
      debtLimit: actualDebtLimit,
      minDebt: 0,
      maxDebt: actualDebtLimit,
    };
  }, [
    avgHealthFactor,
    hasMarginAccount,
    storeBorrowRate,
    timeToLiquidation,
    totalBorrowedValue,
    totalCollateralValue,
    totalValue,
  ]);

  const oracleAndLtsData = useMemo(
    () => ({
      oracleContract: "Band Oracle",
      liquidationThreshold: "1.10x",
      riskEngine: "Enabled",
    }),
    [],
  );

  // Pre-merge InfoCard data so we pass a stable object reference.
  const infoCardData = useMemo(
    () => ({ ...marginAccountInfo, ...oracleAndLtsData }),
    [marginAccountInfo, oracleAndLtsData],
  );

  // Expandable sections — stable array (constants are already stable).
  const infoCardExpandableSections = useMemo(
    () => [
      {
        title: "MORE DETAILS",
        headingBold: true,
        items: MARGIN_ACCOUNT_MORE_DETAILS_ITEMS,
        defaultExpanded: true,
        delay: 0.1,
      },
      {
        title: "ORACLES AND LTS",
        headingBold: true,
        items: MARGIN_ORACLE_LTS_ITEMS,
        defaultExpanded: false,
        delay: 0.2,
      },
    ],
    [],
  );

  // Stable handlers for memoized children.
  const handleTabSwitched = useCallback(() => setSwitchToRepayTab(false), []);
  const handleRepayClick = useCallback((asset?: string) => {
    setPrefilledRepayAsset(asset);
    setSwitchToRepayTab(true);
  }, []);

  // Format account stats value
  const formatAccountStatValue = (itemId: string, value: number) => {
    if (itemId === "netHealthFactor") {
      if (value === Infinity || !isFinite(value) || value >= 999) {
        return "∞";
      }
      return formatValue(value, {
        type: "health-factor",
        showZeroAsDash: false,
      });
    }

    return `$${formatValue(value, {
      type: "number",
      useLargeFormat: true,
      showZeroAsDash: false,
    })}`;
  };

  // Prepare account stats values for AccountStats component
  const accountStatsValues = useMemo(() => {
    const values = ACCOUNT_STATS_ITEMS.reduce(
      (acc, item) => {
        if (isLoadingMargin && !accountStats) {
          acc[item.id] = "⟳";
          return acc;
        }

        if (!accountStats) {
          acc[item.id] = formatAccountStatValue(item.id, 0);
          return acc;
        }

        const value = accountStats[item.id as keyof typeof accountStats] ?? 0;

        acc[item.id] = formatAccountStatValue(item.id, value);

        return acc;
      },
      {} as Record<string, string>,
    );

    console.log("[Account Stats Values] Generated:", values);
    return values;
  }, [accountStats, isLoadingMargin]);

  return (
    <main className="w-full h-[calc(100vh-56px)] lg:h-[calc(100vh-72px)] overflow-y-auto scrollbar-hide px-4 sm:px-10 lg:px-30 pb-8 lg:pb-0">
      {/* Error banner for margin data loading issues */}
      <AnimatePresence>
        {marginError && (
          <motion.div
            className="w-full pt-5"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <div
              className={`${
                marginError.includes("wait") ||
                marginError.includes("Rate limit")
                  ? "bg-yellow-100 border-yellow-400 text-yellow-800"
                  : "bg-red-100 border-red-400 text-red-700"
              } border px-4 py-3 rounded relative flex items-center gap-3`}
              role="alert"
            >
              {/* Icon */}
              {marginError.includes("wait") ||
              marginError.includes("Rate limit") ? (
                <svg
                  className="w-6 h-6 shrink-0"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z"
                    clipRule="evenodd"
                  />
                </svg>
              ) : (
                <svg
                  className="w-6 h-6 shrink-0"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                    clipRule="evenodd"
                  />
                </svg>
              )}

              {/* Message */}
              <div className="flex-1">
                <span className="block sm:inline">{marginError}</span>
              </div>

              {/* Close button */}
              <button
                onClick={() => setMarginError(null)}
                className="shrink-0 ml-auto"
              >
                <svg
                  className="w-5 h-5"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Carousel section - displays promotional items */}
      <motion.section
        className="w-full h-fit pt-4 sm:pt-6 pb-3 sm:pb-4"
        initial={{ opacity: 0, y: 50 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: 0.8,
          ease: "easeOut",
          delay: 0.2,
        }}
      >
        <Carousel items={[...CAROUSEL_ITEMS]} autoplayInterval={5000} />
      </motion.section>

      {isWalletConnected && (
        <motion.section
          className="w-full h-auto pb-2 sm:pb-0"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        >
          <AccountStats
            items={ACCOUNT_STATS_ITEMS}
            values={accountStatsValues}
            gridCols="grid-cols-5"
          />
        </motion.section>
      )}

      {/* Main leverage section */}
      <section className="w-full pt-6 pb-4 sm:pb-6 lg:pb-10 flex flex-col gap-3">
        {/* Section heading */}
        <motion.header
          ref={leverageCollateralRef}
          className="w-full flex items-center gap-3"
          initial={{ opacity: 0, x: -20 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        >
          <h1 className={`text-[20px] font-bold ${isDark ? "text-white" : ""}`}>
            Leverage your Collateral
          </h1>
          {/* Loading Spinner Icon */}
          {isLoadingMargin && (
            <motion.div
              className="flex items-center gap-2"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
            >
              <svg
                className="animate-spin h-6 w-6 text-[#703AE6]"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                ></circle>
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                ></path>
              </svg>
              <span
                className={`text-sm ${isDark ? "text-gray-400" : "text-gray-600"}`}
              >
                Loading...
              </span>
            </motion.div>
          )}
        </motion.header>

        {/* Responsive layout — stacked on mobile/tablet, side-by-side on desktop */}
        <div
          className="flex flex-col lg:grid lg:items-start gap-5 sm:gap-6 margin-layout-cols min-w-0 w-full"
        >
          <div className="w-full min-w-0">
            <LeverageCollateral
              switchToRepayTab={switchToRepayTab}
              onTabSwitched={handleTabSwitched}
              prefilledRepayAsset={prefilledRepayAsset}
            />
          </div>

          {/* Right: Margin account info card */}
          <motion.aside
            className="flex flex-col gap-3 h-fit w-full min-w-0 lg:sticky lg:top-4 lg:self-start"
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, ease: "easeOut" }}
          >
            <motion.header
              className="flex gap-2.5 items-start"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, ease: "easeOut" }}
            >
              <motion.div
                className="border flex flex-col justify-center items-center p-1.5 rounded-[11px] w-11 h-11"
                initial={{ scale: 0, rotate: -180 }}
                whileInView={{ scale: 1, rotate: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, type: "spring", stiffness: 200 }}
              >
                <Image
                  alt="vanna"
                  src="/logos/vanna-icon.png"
                  width={22}
                  height={20}
                />
              </motion.div>
              <div className="flex flex-col flex-1">
                <div className="flex items-center gap-2">
                  <h2
                    className={`text-lg font-bold ${isDark ? "text-white" : ""}`}
                  >
                    Margin Account Info
                  </h2>
                  {isLoadingMargin && (
                    <svg
                      className="animate-spin h-5 w-5 text-[#703AE6]"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                  )}
                </div>
                <p className="w-full text-sm font-medium text-gray-400">
                  {isLoadingMargin
                    ? "Fetching latest data..."
                    : "Stay updated details and status."}
                </p>
              </div>
            </motion.header>

            <InfoCard
              data={infoCardData}
              items={MARGIN_ACCOUNT_INFO_ITEMS}
              showExpandable={true}
              expandableSections={infoCardExpandableSections}
            />
          </motion.aside>
        </div>

        {/* Positions table section */}
        {isWalletConnected && (
          <motion.section
            className="w-full h-fit pt-3"
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          >
            <Positionstable
              onRepayClick={handleRepayClick}
              onOpenPositionClick={scrollToLeverageSection}
            />
          </motion.section>
        )}
      </section>
    </main>
  );
};

export default Margin;
