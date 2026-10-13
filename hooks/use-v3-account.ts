'use client';

/**
 * The connected wallet's Vanna margin account for the V3 pages: the RiskEngine-exact model
 * (lib/account-model.ts) built from the margin-account store the rest of the app already keeps
 * fresh, so every page shows the same health factor, account leverage, room before liquidation and
 * liquidation prices.
 */
import { useMemo } from 'react';
import { useUserStore } from '@/store/user';
import { useMarginAccountInfoStore } from '@/store/margin-account-info-store';
import { useTokenPrices } from '@/contexts/price-context';
import { accountNumbers, liqMultiplier, liqRoom, priceKey, type AccountNumbers, type LiqRoom, type ModelState } from '@/lib/account-model';

export interface V3Account {
  connected: boolean;
  hasMargin: boolean;
  loading: boolean;
  /** Margin account contract address (C…), null when none. */
  marginAddress: string | null;
  state: ModelState | null;
  now: AccountNumbers | null;
  room: LiqRoom | null;
  /** Oracle/market price of a symbol, USD; 0 when unknown. */
  priceOf: (symbol: string) => number;
  /**
   * Price of `symbol` at which the whole account reaches health factor 1.10, every other price
   * held; `side` limits it to the adverse direction of a position. null = None / no debt.
   */
  liqPriceOf: (symbol: string, side?: 'long' | 'short') => number | null;
}

const rows = (r: Record<string, { amount: string; usdValue: string }>) =>
  Object.entries(r)
    .map(([symbol, b]) => ({ symbol, usd: Number(b.usdValue) || 0, amount: Number(b.amount) || 0 }))
    .filter((x) => x.amount > 0 || x.usd > 0);

export function useV3Account(): V3Account {
  const address = useUserStore((s) => s.address);
  const hasMargin = useMarginAccountInfoStore((s) => s.hasMarginAccount);
  const marginAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);
  const collateralBalances = useMarginAccountInfoStore((s) => s.collateralBalances);
  const borrowedBalances = useMarginAccountInfoStore((s) => s.borrowedBalances);
  const loading = useMarginAccountInfoStore((s) => s.isLoadingBorrowedBalances);
  const { prices } = useTokenPrices();

  const state: ModelState | null = useMemo(() => {
    if (!hasMargin) return null;
    return {
      collateral: rows(collateralBalances).map(({ symbol, usd }) => ({ symbol, usd })),
      debts: rows(borrowedBalances).map(({ symbol, usd }) => ({ symbol, usd })),
      phoenixCollateral: 0,
      perps: [],
    };
  }, [hasMargin, collateralBalances, borrowedBalances]);
  const now = useMemo(() => (state ? accountNumbers(state) : null), [state]);
  const room = useMemo(() => (state ? liqRoom(state) : null), [state]);

  const priceOf = (symbol: string) => {
    const key = priceKey(symbol);
    const table = prices as unknown as Record<string, number | undefined>;
    const p = table[key.toUpperCase()] ?? table[symbol.toUpperCase()];
    if (p && p > 0) return p;
    // Fall back to the account's own valuation (usd / amount) when the price feed lacks the symbol.
    const b = collateralBalances[symbol] ?? borrowedBalances[symbol];
    const amt = Number(b?.amount);
    return amt > 0 ? Number(b.usdValue) / amt : 0;
  };
  const liqPriceOf = (symbol: string, side?: 'long' | 'short') => {
    if (!state) return null;
    const m = liqMultiplier(state, priceKey(symbol), side);
    const p = priceOf(symbol);
    return m !== null && p > 0 ? p * m : null;
  };

  return { connected: Boolean(address), hasMargin, loading, marginAddress, state, now, room, priceOf, liqPriceOf };
}
