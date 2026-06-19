"use client";

import { Carousel } from "@/components/ui/carousel";
import {
  CAROUSEL_ITEMS,
  MARGIN_ACCOUNT_INFO_ITEMS,
  MARGIN_ORACLE_LTS_ITEMS,
} from "@/lib/constants/margin";
import { motion } from "framer-motion";
import { useState, useRef, useEffect, useMemo } from "react";
import Image from "next/image";
import { InfoCard } from "@/components/margin/info-card";
import { LeverageCollateral } from "@/components/margin/leverage-collateral";
import { Positionstable } from "@/components/margin/positions-table";
import { AccountStats } from "@/components/margin/account-stats";
import { useMarginAccountInfoStore, checkUserMarginAccount, refreshBorrowedBalances } from "@/store/margin-account-info-store";
import { useAccountSnapshot } from "@/hooks/use-account-snapshot";
import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";
import { useUserStore } from "@/store/user";
import { useLedgerTick } from "@/contexts/ledger-subscriber";
import { formatValue } from "@/lib/utils/format-value";
import { ACCOUNT_STATS_ITEMS } from "@/lib/constants/margin";
import { useTheme } from "@/contexts/theme-context";
import { useAppModeStore } from "@/store/app-mode-store";
import { LiteHome } from "@/components/lite-mode/lite-home";

export default function Home() {
  const { isDark } = useTheme();
  const appMode = useAppModeStore((s) => s.mode);

  // State to trigger tab switch to Repay Loan
  const [switchToRepayTab, setSwitchToRepayTab] = useState(false);
  const [prefilledRepayAsset, setPrefilledRepayAsset] = useState<string | undefined>(undefined);

  // Ref for scrolling to LeverageCollateral component
  const leverageCollateralRef = useRef<HTMLDivElement>(null);

  // Common function to scroll to leverage section
  const scrollToLeverageSection = () => {
    if (leverageCollateralRef.current) {
      leverageCollateralRef.current.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  };

  // Scroll to LeverageCollateral when repay is clicked
  useEffect(() => {
    if (switchToRepayTab) {
      // Small delay to ensure tab switch happens first
      setTimeout(() => {
        scrollToLeverageSection();
      }, 100);
    }
  }, [switchToRepayTab]);

  const userAddress = useUserStore((state) => state.address);
  const isConnected = useUserStore((state) => state.isConnected);

  // Get margin account info from global store using selector to prevent unnecessary re-renders
  const totalBorrowedValue = useMarginAccountInfoStore(
    (state) => state.totalBorrowedValue
  );
  const totalCollateralValue = useMarginAccountInfoStore(
    (state) => state.totalCollateralValue
  );
  const avgHealthFactor = useMarginAccountInfoStore(
    (state) => state.avgHealthFactor
  );
  const collateralLeftBeforeLiquidation = useMarginAccountInfoStore(
    (state) => state.collateralLeftBeforeLiquidation
  );
  const netAvailableCollateral = useMarginAccountInfoStore(
    (state) => state.netAvailableCollateral
  );
  const timeToLiquidation = useMarginAccountInfoStore(
    (state) => state.timeToLiquidation
  );
  const borrowRate = useMarginAccountInfoStore((state) => state.borrowRate);
  const liquidationPremium = useMarginAccountInfoStore(
    (state) => state.liquidationPremium
  );
  const liquidationFee = useMarginAccountInfoStore(
    (state) => state.liquidationFee
  );
  const debtLimit = useMarginAccountInfoStore((state) => state.debtLimit);
  const minDebt = useMarginAccountInfoStore((state) => state.minDebt);
  const maxDebt = useMarginAccountInfoStore((state) => state.maxDebt);
  const hasMarginAccount = useMarginAccountInfoStore(
    (state) => state.hasMarginAccount
  );
  const marginAccountAddress = useMarginAccountInfoStore(
    (state) => state.marginAccountAddress
  );
  const isLoadingBorrowedBalances = useMarginAccountInfoStore(
    (state) => state.isLoadingBorrowedBalances
  );

  // Per-account snapshot (cached) — gives the stats instantly on reload and a
  // clean loading signal, same as the margin page. Values are sourced from it
  // (falling back to the store) so the first paint shows real numbers, not 0.
  const { snapshot } = useAccountSnapshot(userAddress);
  const effHasAccount = snapshot?.hasMarginAccount ?? hasMarginAccount;
  const effHealthFactor = snapshot?.avgHealthFactor ?? avgHealthFactor;
  const effNetAvailable = snapshot?.netAvailableCollateral ?? netAvailableCollateral;
  const effCollateralLeft =
    snapshot?.collateralLeftBeforeLiquidation ?? collateralLeftBeforeLiquidation;
  const effBorrowed = snapshot?.totalBorrowedValue ?? totalBorrowedValue;
  const effBorrowRate = snapshot?.borrowRate ?? borrowRate;

  // Check for margin account when user address changes or wallet connects
  useEffect(() => {
    if (userAddress && isConnected) {
      // Check for existing margin account whenever wallet connects
      checkUserMarginAccount(userAddress).catch(console.error);
    }
    // Note: We don't clear margin account on disconnect to preserve localStorage data
  }, [userAddress, isConnected]);

  const { tick } = useLedgerTick();

  // Initial load when margin account becomes available.
  useEffect(() => {
    if (isConnected && hasMarginAccount && marginAccountAddress && marginAccountAddress.length > 10) {
      refreshBorrowedBalances(marginAccountAddress);
    }
  }, [isConnected, hasMarginAccount, marginAccountAddress]);

  // Ledger-tick driven refresh — replaces the prior 30s setInterval. Refreshes
  // the margin store (balances/positions) on each ledger close. It deliberately
  // does NOT invalidate the ['margin'] query cache: the only RQ query under that
  // prefix is ['margin','history'] (Mercury-backed, full-pagination, heavy), and
  // D21 fixed that to refresh on mount / window-focus / borrow-repay mutation —
  // never on the ~5s tick. A broad tick invalidate here re-triggered the history
  // refetch every close (a refetch loop), undoing that.
  useEffect(() => {
    if (isConnected && hasMarginAccount && marginAccountAddress && marginAccountAddress.length > 10) {
      refreshBorrowedBalances(marginAccountAddress);
    }
  }, [tick, isConnected, hasMarginAccount, marginAccountAddress]);


  // ── Live account stats derived from store (contract-aligned formulas) ──────
  const accountStats = useMemo(() => {
    return {
      netHealthFactor: effHealthFactor,
      collateralLeftBeforeLiquidation: effCollateralLeft,
      netAvailableCollateral: effNetAvailable,
      netAmountBorrowed: effBorrowed,
      // Realised P&L is 0 until proper deposit-history accounting is wired up;
      // mapping totalValue here misled users into reading their own equity as
      // "profit". Once we track per-user cost basis we can compute
      //   P&L = current_collateral_value - cumulative_deposits + cumulative_withdrawals
      netProfitAndLoss: 0,
    };
  }, [
    effHealthFactor,
    effCollateralLeft,
    effNetAvailable,
    effBorrowed,
  ]);

  // InfoCard row keyed `totalCollateralValue` shows Net Available Collateral
  // (gross assets − debt), matching ACCOUNT_STATS_ITEMS — not raw chain collateral.
  const infoCardData = useMemo(
    () => ({
      totalBorrowedValue: effBorrowed,
      totalCollateralValue: effNetAvailable,
      totalValue: effBorrowed + effNetAvailable,
      avgHealthFactor: effHealthFactor,
      timeToLiquidation,
      borrowRate: effBorrowRate,
      liquidationPremium,
      liquidationFee,
      debtLimit,
      minDebt,
      maxDebt,
      oracleContract: CONTRACT_ADDRESSES.ORACLE,
      liquidationThreshold: "1.10x",
      riskEngine: CONTRACT_ADDRESSES.RISK_ENGINE,
    }),
    [
      effHealthFactor,
      effBorrowRate,
      debtLimit,
      liquidationFee,
      liquidationPremium,
      maxDebt,
      minDebt,
      effNetAvailable,
      timeToLiquidation,
      effBorrowed,
    ],
  );

  // Format account stats value with explicit units, following industry
  // conventions: Health Factor is a bare unitless ratio (Aave/Compound style,
  // never with ×), USD totals with $ prefix, P&L with signed $ prefix (+/-).
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

    const usdText = formatValue(Math.abs(value), {
      type: "number",
      useLargeFormat: true,
      showZeroAsDash: false,
    });

    if (itemId === "netProfitAndLoss") {
      if (value > 0) return `+$${usdText}`;
      if (value < 0) return `-$${usdText}`;
      return `$${usdText}`;
    }

    return `$${usdText}`;
  };

  // Prepare account stats values for AccountStats component.
  // While the on-chain refresh is in flight AND we don't yet have any real
  // data (collateral + debt both 0), render a spinner instead of "$0.00" so
  // a freshly-connected wallet doesn't briefly look empty during the ~12s
  // RPC round-trip. Once data lands we keep showing the last-known values
  // through subsequent polling refreshes (no flicker every 30s).
  // Shimmer (Aave style) until the snapshot resolves; then render real values
  // directly. Never a raw 0 or a spinner glyph.
  const showStatsSkeleton = Boolean(userAddress) && !snapshot;
  const accountStatsValues = ACCOUNT_STATS_ITEMS.reduce((acc, item) => {
    const value = accountStats[item.id as keyof typeof accountStats] ?? 0;
    acc[item.id] = formatAccountStatValue(item.id, value);
    return acc;
  }, {} as Record<string, string>);

  // Industry-standard P&L coloring: green when positive, red when negative,
  // neutral (default) at exactly zero.
  const accountStatsValueColors = (() => {
    const pnl = accountStats.netProfitAndLoss ?? 0;
    if (pnl > 0) return { netProfitAndLoss: "text-emerald-500" };
    if (pnl < 0) return { netProfitAndLoss: "text-rose-500" };
    return undefined;
  })();

  if (appMode === "lite") {
    return (
      <main className="w-full px-4 sm:px-10 lg:px-30 pb-8 pt-6">
        <LiteHome />
      </main>
    );
  }

  return (
    <main className="w-full px-4 sm:px-10 lg:px-30 pb-8 lg:pb-0">
      {/* Carousel section - displays promotional items */}
      <motion.section
        className="w-full h-fit pt-3 sm:pt-4 pb-3 sm:pb-4"
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

      {userAddress && (
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
            valueColors={accountStatsValueColors}
            gridCols="grid-cols-4"
            loading={showStatsSkeleton}
          />
        </motion.section>
      )}

      {/* Main leverage section */}
      <section className="w-full pt-6 pb-4 sm:pb-6 lg:pb-10 flex flex-col gap-3">
        {/* Section heading */}
        <motion.header
          className="w-full flex items-center gap-3"
          initial={{ opacity: 0, x: -20 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        >
          <h1 className={`text-[20px] font-bold ${isDark ? "text-white" : ""}`}>
            Leverage your Collateral
          </h1>
        </motion.header>

        {/* Two-column layout */}
        <div className="flex flex-col lg:grid lg:items-start gap-6 min-w-0 w-full" style={{ gridTemplateColumns: "3fr 2fr" }} ref={leverageCollateralRef}>
          {/* Left: Leverage collateral form */}
          <div className="w-full">
            <LeverageCollateral
              switchToRepayTab={switchToRepayTab}
              onTabSwitched={() => setSwitchToRepayTab(false)}
              prefilledRepayAsset={prefilledRepayAsset}
            />
          </div>

          {/* Right: Margin account info card - sticky */}
          <motion.aside
            className="flex flex-col gap-3 h-fit w-full min-w-0 lg:sticky lg:top-4 lg:self-start"
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, ease: "easeOut" }}
          >
            {/* Info card header */}
            <motion.header
              className="flex gap-[10px] items-start"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, ease: "easeOut" }}
            >
              {/* Vanna logo icon */}
              <motion.div
                className="border-[1px] flex flex-col justify-center items-center p-1.5 rounded-[11px] w-11 h-11"
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
              <div className="flex flex-col flex-1 min-w-0">
                <h2 className={`text-[18px] font-bold ${isDark ? "text-white" : ""}`}>
                  Margin Account Info
                </h2>
                <p className="w-full text-[13px] font-medium text-[#A3A3A3]">
                  Stay updated details and status.
                </p>
              </div>
            </motion.header>

            {/* Info card with expandable sections */}
            <InfoCard
              data={infoCardData}
              items={[...MARGIN_ACCOUNT_INFO_ITEMS]}
              loading={showStatsSkeleton}
              showExpandable={true}
              expandableSections={[
                {
                  title: "ORACLES AND LTS",
                  headingBold: true,
                  items: [...MARGIN_ORACLE_LTS_ITEMS],
                  defaultExpanded: false,
                  delay: 0.1,
                },
              ]}
            />

          </motion.aside>
        </div>

        {/* Positions table section - only show if user has margin account */}
        {userAddress && hasMarginAccount && (
          <motion.section
            className="w-full h-fit"
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          >
            <Positionstable
              onRepayClick={(asset) => {
                setPrefilledRepayAsset(asset);
                setSwitchToRepayTab(true);
              }}
              onOpenPositionClick={scrollToLeverageSection}
            />
          </motion.section>
        )}
      </section>
    </main>
  );
}
