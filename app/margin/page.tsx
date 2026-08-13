"use client";

import { Carousel } from "@/components/ui/carousel";
import {
  CAROUSEL_ITEMS,
  MARGIN_ACCOUNT_INFO_ITEMS,
  MARGIN_ORACLE_LTS_ITEMS,
  ACCOUNT_STATS_ITEMS,
} from "@/lib/constants/margin";
import { motion, AnimatePresence } from "framer-motion";
import { Suspense, useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";
import { InfoCard } from "@/components/margin/info-card";
import { LeverageCollateral } from "@/components/margin/leverage-collateral";
import { Positionstable } from "@/components/margin/positions-table";
import { AccountStats } from "@/components/margin/account-stats";
import { CONTRACT_ADDRESSES } from "@/lib/stellar-utils";
import {
  useMarginAccountInfoStore,
  isSnapshotFeedSuppressed,
} from "@/store/margin-account-info-store";
import { useUserStore } from "@/store/user";
import { formatValue } from "@/lib/utils/format-value";
import { useTheme } from "@/contexts/theme-context";
import { useShallow } from "zustand/shallow";
import { useAccountSnapshot } from "@/hooks/use-account-snapshot";
import { deriveMarginHealth } from "@/lib/margin-health";

// useSearchParams() opts this page out of static prerendering unless it's
// isolated behind its own Suspense boundary — everything else on the page
// is client-only anyway (wallet-gated), so the fallback below never really
// shows in practice.
const MarginContent = () => {
  const { isDark } = useTheme();
  const searchParams = useSearchParams();
  const router = useRouter();

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

  // Portfolio's per-asset Repay button hands off here via ?repay=<asset> (it
  // has no Repay UI of its own) — consume it once on arrival, then strip it
  // from the URL so a manual refresh doesn't re-trigger the tab switch.
  useEffect(() => {
    const repayAsset = searchParams.get("repay");
    if (repayAsset !== null) {
      setPrefilledRepayAsset(repayAsset || undefined);
      setSwitchToRepayTab(true);
      router.replace("/margin");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

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
    grossCollateralValue,
    totalBorrowedValue,
    netAvailableCollateral,
    timeToLiquidation,
    storeBorrowRate,
  } = useMarginAccountInfoStore(
    useShallow((state) => ({
      hasMarginAccount: state.hasMarginAccount,
      grossCollateralValue: state.grossCollateralValue,
      totalBorrowedValue: state.totalBorrowedValue,
      netAvailableCollateral: state.netAvailableCollateral,
      timeToLiquidation: state.timeToLiquidation,
      storeBorrowRate: state.borrowRate,
    })),
  );

  // D25: per-user stats come from the cached /api/account/[addr] snapshot —
  // instant first paint on a warm edge cache, and the ledger-tick revalidation
  // is absorbed by the route's 15s s-maxage (so spamming refresh ≈ 1 RPC / 15s,
  // not one full chain read per load). The snapshot is fed into the store so
  // every existing consumer stays unchanged. The imperative client read
  // (refreshBorrowedBalances) is now the mutation / cache-miss fallback only —
  // mutations still call it directly (and force-suppress this feed briefly so
  // a lagging cached snapshot can't clobber a fresh post-mutation result).
  const { snapshot, isLoading: snapshotLoading, error: snapshotError } =
    useAccountSnapshot(userAddress);

  // Show the loading state until the FIRST snapshot lands — never render the
  // empty store as if it were real zeros. RQ's isLoading is true only on the
  // initial fetch (false during background refetch), so this never flickers
  // back to a spinner once we have data.
  useEffect(() => {
    setIsLoadingMargin(snapshotLoading && !snapshot);
  }, [snapshotLoading, snapshot]);

  useEffect(() => {
    if (!snapshot || isSnapshotFeedSuppressed()) return;
    const store = useMarginAccountInfoStore.getState();
    if (snapshot.hasMarginAccount && snapshot.marginAccountAddress) {
      // Don't let a degraded snapshot (no collateral) overwrite collateral the
      // store already holds — the single-source-of-truth guarantee. If this read
      // shows zero collateral but we already had some, update only the debt side
      // and PRESERVE the collateral/health; a later good read reconciles.
      const snapGross = snapshot.grossCollateralValue ?? 0;
      const degraded = snapGross <= 0.01 && (store.grossCollateralValue ?? 0) > 0.01;
      store.set({
        hasMarginAccount: true,
        marginAccountAddress: snapshot.marginAccountAddress,
        borrowedBalances: snapshot.borrowedBalances ?? {},
        totalBorrowedValue: snapshot.totalBorrowedValue ?? 0,
        totalValue: snapshot.totalValue ?? 0,
        borrowRate: snapshot.borrowRate ?? 0,
        isLoadingBorrowedBalances: false,
        ...(degraded
          ? {}
          : {
              collateralBalances: snapshot.collateralBalances ?? {},
              totalCollateralValue: snapshot.totalCollateralValue ?? 0,
              grossCollateralValue: snapGross,
              avgHealthFactor: snapshot.avgHealthFactor ?? 0,
              collateralLeftBeforeLiquidation: snapshot.collateralLeftBeforeLiquidation ?? 0,
              netAvailableCollateral: snapshot.netAvailableCollateral ?? 0,
              debtLimit: snapshot.debtLimit ?? 0,
            }),
      });
    } else if (snapshot.hasMarginAccount === false) {
      store.set({ hasMarginAccount: false });
    }
  }, [snapshot]);

  useEffect(() => {
    setMarginError(snapshotError);
  }, [snapshotError]);

  // Source the displayed stats from the snapshot directly — it's available on
  // the first paint via the per-account cache, so values render immediately on
  // reload instead of waiting a frame for the store feed (which caused the 0
  // flash). Falls back to the store for the post-mutation refresh path. `??`
  // preserves a legitimate 0 (e.g. an empty account) rather than masking it.
  const effHasAccount = snapshot?.hasMarginAccount ?? hasMarginAccount;
  const effGrossCollateral = snapshot?.grossCollateralValue ?? grossCollateralValue;
  const effBorrowed = snapshot?.totalBorrowedValue ?? totalBorrowedValue;
  const effBorrowRate = snapshot?.borrowRate ?? storeBorrowRate;

  // The risk trio (HF, net-available, collateral-left) is RECOMPUTED from the
  // gross collateral + debt being displayed — never read from a separately
  // stored avgHealthFactor that can lag the debt. That stored-vs-derived skew is
  // what showed ∞ next to a real $16.12 borrow: the cached snapshot's HF came
  // from a pre-borrow read while the debt was fresh. Deriving here keeps all
  // four KPI cards (and the InfoCard) coherent with the borrow by construction.
  const derivedHealth = deriveMarginHealth({
    grossCollateralValue: effGrossCollateral,
    effectiveDebtValue: effBorrowed > 0.01 ? effBorrowed : 0,
    totalBorrowedValue: effBorrowed,
  });
  const effHealthFactor = derivedHealth.avgHealthFactor;
  const effNetAvailable = derivedHealth.netAvailableCollateral;
  const effCollateralLeft = derivedHealth.collateralLeftBeforeLiquidation;

  // Shimmer (never a 0 or spinner) until we have a snapshot to show. Once it
  // resolves — from the per-account cache on reload (instant) or the network on
  // first-ever load — real values render directly.
  const showStatsSkeleton = isWalletConnected && !snapshot;

  const accountStats = useMemo(() => {
    const hasAnyMarginData =
      effHasAccount || effGrossCollateral > 0 || effBorrowed > 0;

    if (!hasAnyMarginData) {
      return null;
    }

    return {
      netHealthFactor: effHealthFactor,
      collateralLeftBeforeLiquidation: effCollateralLeft,
      netAvailableCollateral: effNetAvailable,
      netAmountBorrowed: effBorrowed,
      // Realised P&L is 0 until proper deposit-history accounting is wired up;
      // showing totalValue here misled users into reading their own equity as
      // "profit". Once we track per-user cost basis we can compute
      //   P&L = current_collateral_value - cumulative_deposits + cumulative_withdrawals
      netProfitAndLoss: 0,
    };
  }, [
    effHealthFactor,
    effCollateralLeft,
    effNetAvailable,
    effBorrowed,
    effGrossCollateral,
    effHasAccount,
  ]);

  // Format data for InfoCard component (numeric values for Stellar backend's InfoCard)
  const marginAccountInfo = useMemo(() => {
    const hasAnyMarginData =
      effHasAccount || effGrossCollateral > 0 || effBorrowed > 0;

    // Actual max debt = gross collateral / liquidation threshold (1.1)
    const actualDebtLimit = effGrossCollateral > 0
      ? parseFloat((effGrossCollateral / 1.1).toFixed(2))
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
      totalBorrowedValue: effBorrowed,
      totalCollateralValue: effNetAvailable,
      totalValue: effBorrowed + effNetAvailable,
      avgHealthFactor: effHealthFactor,
      timeToLiquidation,
      borrowRate: effBorrowRate,
      liquidationPremium: 0,
      liquidationFee: 0,
      debtLimit: actualDebtLimit,
      minDebt: 0,
      maxDebt: actualDebtLimit,
    };
  }, [
    effHasAccount,
    effGrossCollateral,
    effBorrowed,
    effNetAvailable,
    effHealthFactor,
    effBorrowRate,
    timeToLiquidation,
  ]);

  // Real on-chain contract addresses — InfoCard auto-renders Stellar contract
  // strings as copyable badges with a Stellar Expert link.
  const oracleAndLtsData = useMemo(
    () => ({
      oracleContract: CONTRACT_ADDRESSES.ORACLE,
      liquidationThreshold: "1.10x",
      riskEngine: CONTRACT_ADDRESSES.RISK_ENGINE,
    }),
    [],
  );

  // Pre-merge InfoCard data so we pass a stable object reference.
  // totalCollateralValue is overridden here to always show user's net equity
  // (Net Available Collateral = gross assets − debt), not the raw chain value.
  const infoCardData = useMemo(
    () => ({
      ...marginAccountInfo,
      ...oracleAndLtsData,
      totalCollateralValue: netAvailableCollateral,
      totalValue: totalBorrowedValue + netAvailableCollateral,
    }),
    [marginAccountInfo, oracleAndLtsData, netAvailableCollateral, totalBorrowedValue],
  );

  // Expandable sections — stable array (constants are already stable).
  const infoCardExpandableSections = useMemo(
    () => [
      {
        title: "ORACLES AND LTS",
        headingBold: true,
        items: MARGIN_ORACLE_LTS_ITEMS,
        defaultExpanded: false,
        delay: 0.1,
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

    // Sub-cent (but non-zero) → "<$0.01" rather than a misleading "$0.00", so the
    // header agrees with the Repay tab when only dust debt/collateral remains.
    const isDust = Math.abs(value) > 0 && Math.abs(value) < 0.01;

    if (itemId === "netProfitAndLoss") {
      // Signed display: +$X for gains, -$X for losses, $0.00 at exactly zero.
      if (value > 0) return isDust ? "+<$0.01" : `+$${usdText}`;
      if (value < 0) return isDust ? "-<$0.01" : `-$${usdText}`;
      return `$${usdText}`;
    }

    if (isDust) return "<$0.01";
    return `$${usdText}`;
  };

  // Prepare account stats values for AccountStats component. The loading state
  // is handled by the shimmer (showStatsSkeleton) — when not loading we always
  // render real values (or 0 for a genuinely empty account), never a spinner.
  const accountStatsValues = useMemo(() => {
    return ACCOUNT_STATS_ITEMS.reduce(
      (acc, item) => {
        const value = accountStats
          ? (accountStats[item.id as keyof typeof accountStats] ?? 0)
          : 0;
        acc[item.id] = formatAccountStatValue(item.id, value);
        return acc;
      },
      {} as Record<string, string>,
    );
  }, [accountStats]);

  // Industry-standard P&L coloring: green when positive, red when negative,
  // neutral (default) at exactly zero.
  const accountStatsValueColors = useMemo(() => {
    const pnl = accountStats?.netProfitAndLoss ?? 0;
    if (pnl > 0) return { netProfitAndLoss: "text-emerald-500" };
    if (pnl < 0) return { netProfitAndLoss: "text-rose-500" };
    return undefined;
  }, [accountStats?.netProfitAndLoss]);

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

      {/* Liquidation danger banner — shown when own HF drops below 1.1 */}
      <AnimatePresence>
        {isWalletConnected && effHasAccount && effHealthFactor > 0 && effHealthFactor < 1.1 && (
          <motion.div
            className="w-full pt-5"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <div className="bg-rose-100 border border-rose-400 text-rose-800 px-4 py-3 rounded-xl flex items-start gap-3">
              <svg className="w-6 h-6 shrink-0 mt-0.5 text-rose-600" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <div className="flex-1">
                <p className="font-bold text-[14px]">
                  Liquidation Risk — Health Factor {effHealthFactor.toFixed(2)} (below 1.10)
                </p>
                <p className="text-[13px] mt-0.5">
                  Your account is undercollateralised and can be liquidated by anyone. Repay debt or add collateral immediately to restore your Health Factor above 1.1.
                </p>
              </div>
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
                className="border flex flex-col justify-center items-center p-1.5 rounded-[11px] w-11 h-11 shrink-0"
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
                <div className="flex items-center gap-2">
                  <h2
                    className={`text-lg font-bold ${isDark ? "text-white" : ""}`}
                  >
                    Margin Account Info
                  </h2>
                </div>
                <p className="w-full text-sm font-medium text-gray-400">
                  Stay updated details and status.
                </p>
              </div>
            </motion.header>

            <InfoCard
              data={infoCardData}
              items={MARGIN_ACCOUNT_INFO_ITEMS}
              showExpandable={true}
              expandableSections={infoCardExpandableSections}
              loading={showStatsSkeleton}
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

const Margin = () => (
  <Suspense fallback={null}>
    <MarginContent />
  </Suspense>
);

export default Margin;
