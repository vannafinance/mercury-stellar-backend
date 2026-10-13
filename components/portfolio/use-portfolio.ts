"use client";

/**
 * Everything the Portfolio page shows, read once from the Stellar app's existing hooks and
 * combined with `portfolio-math.ts`:
 *
 * - wallet tokens (user store, refreshed on mount by the page) × Reflector oracle prices;
 * - lending supply (`useUserPositions`), live supply APY (`usePoolData`) and the CONNECTED
 *   wallet's own supply / withdraw history (`useEarnTransactions`, Mercury + RPC, query-keyed by
 *   the wallet address — never another wallet's rows);
 * - the margin account as the RiskEngine values it (`useV3Account`, built from the margin store),
 *   its token balances (margin store) and its decoded history (`useMarginHistory`).
 */
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useEarnTransactions, usePoolData, useUserPositions } from "@/hooks/use-earn";
import { useMarginHistory } from "@/hooks/use-margin";
import { useAccountSnapshot } from "@/hooks/use-account-snapshot";
import { useV3Account } from "@/hooks/use-v3-account";
import { isStable, priceKey } from "@/lib/account-model";
import {
  LEND_ASSETS,
  interestAccruedUsd,
  lendingEarnedByAsset,
  lendingEarnedUsd,
  walletHoldings,
  walletUsd,
} from "./portfolio-math";

/** Every symbol the Portfolio prices (the venue USDC wrappers resolve to USDC in the oracle). */
const PRICED = ["XLM", "USDC", "BLUSDC", "AQUSDC", "SOUSDC"];

export function usePortfolio() {
  const address = useUserStore((s) => s.address);
  const tokenBalances = useUserStore((s) => s.tokenBalances);
  const prices = useTokenPrices(PRICED);
  const acct = useV3Account();
  const { positions, isLoading: lendLoading } = useUserPositions();
  const { pools } = usePoolData();
  const earn = useEarnTransactions();
  const margin = useMarginHistory();
  const { snapshot } = useAccountSnapshot(address);
  const store = useMarginAccountInfoStore(
    useShallow((s) => ({
      collateralBalances: s.collateralBalances,
      borrowedBalances: s.borrowedBalances,
      grossCollateralValue: s.grossCollateralValue,
      marginAccountAddress: s.marginAccountAddress,
    })),
  );

  /**
   * Oracle price per symbol: the symbol itself first (the oracle aliases BLUSDC / AQUSDC / SOUSDC),
   * then what it follows (`priceKey`), stables falling back to $1 as the rest of the app does.
   */
  const priceOf = useCallback(
    (sym: string) => {
      const u = sym.toUpperCase();
      const p = prices[u] || prices[priceKey(sym).toUpperCase()] || 0;
      return p > 0 ? p : isStable(sym) ? 1 : 0;
    },
    [prices],
  );

  return useMemo(() => {
    const now = acct.now;
    const wallet = walletHoldings(tokenBalances);
    const walletTotal = walletUsd(wallet, priceOf);

    // While a (new) wallet's positions are still loading, the earn store may still hold the
    // previous wallet's figures: show nothing rather than another wallet's supply.
    const deposited: Record<string, number> = {};
    if (!lendLoading)
      for (const { asset } of LEND_ASSETS) deposited[asset] = parseFloat(positions[asset]?.deposited ?? "0") || 0;
    const lending = LEND_ASSETS.reduce((t, a) => t + (deposited[a.asset] ?? 0) * priceOf(a.sym), 0);

    const earned = earn.isLoading ? {} : lendingEarnedByAsset(deposited, earn.transactions);
    const lendEarned = lendingEarnedUsd(earned, priceOf);
    // No on-chain cost basis exists for Stellar spot / farm positions yet: trading earnings are
    // the honest zero form, never an estimate.
    const trading = 0;
    const interest = margin.isLoading ? 0 : interestAccruedUsd(margin.history, store.borrowedBalances, priceOf);
    const marginEquity = now ? now.equity : 0;

    return {
      address,
      connected: Boolean(address),
      priceOf,
      acct,
      pools,
      positions,
      deposited,
      lendLoading,
      earn,
      earned,
      margin,
      store,
      wallet,
      totals: {
        net: walletTotal + lending + marginEquity,
        wallet: walletTotal,
        lending,
        marginEquity,
        lendEarned,
        trading,
        netEarnings: lendEarned + trading,
        interest,
        /** Collateral backing the margin positions (snapshot first, then the live store). */
        gross: snapshot?.grossCollateralValue ?? store.grossCollateralValue ?? 0,
      },
    };
  }, [address, acct, tokenBalances, priceOf, positions, lendLoading, pools, earn, margin, store, snapshot]);
}

export type Portfolio = ReturnType<typeof usePortfolio>;
