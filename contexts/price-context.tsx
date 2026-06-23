"use client";

// App-wide token-price context. Tracks the live XLM/USD price (the protocol's
// price anchor) and derives the rest of the price map from it, refreshing on
// every ledger close.

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { buildPrices, TokenPrices } from "@/lib/prices";
import { fetchTokenPrice, getCachedTokenPrice } from "@/lib/oracle-price";
import { useLedgerTick } from "@/contexts/ledger-subscriber";

/** Shape exposed by {@link PriceProvider} via {@link useTokenPrices}. */
interface PriceContextValue {
  prices: TokenPrices;
  xlmUsd: number;
  isLoading: boolean;
  lastUpdated: number | null;
  refresh: () => Promise<void>;
  getPrice: (asset: string) => number;
}

const PriceContext = createContext<PriceContextValue | undefined>(undefined);

/**
 * Provides token prices to the tree. Seeds XLM/USD synchronously from the oracle
 * cache for an instant first paint, fetches a fresh price on mount, then
 * re-fetches on each ledger tick (skipping the initial tick to avoid a duplicate
 * mount fetch). Fetch failures keep the last known price; the next tick retries.
 * Mount below {@link LedgerSubscriberProvider}.
 */
export const PriceProvider = ({ children }: { children: React.ReactNode }) => {
  const [xlmUsd, setXlmUsd] = useState<number>(() => getCachedTokenPrice("XLM"));
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const mountedRef = useRef(true);
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const refresh = useMemo(
    () => async () => {
      try {
        const price = await fetchTokenPrice("XLM");
        if (!mountedRef.current) return;
        setXlmUsd(price);
        setLastUpdated(Date.now());
      } catch {
        // keep last known value; next tick will retry
      } finally {
        if (mountedRef.current) setIsLoading(false);
      }
    },
    []
  );

  // Initial price load on mount.
  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  // Refresh price on each ledger close. Skips the initial mount so the
  // effect above handles the first fetch without a duplicate call.
  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    refresh();
  }, [tick, refresh]);

  const value = useMemo<PriceContextValue>(() => {
    const prices = buildPrices(xlmUsd);
    return {
      prices,
      xlmUsd,
      isLoading,
      lastUpdated,
      refresh,
      getPrice: (asset: string) => {
        const key = (asset ?? "").toUpperCase();
        if (key === "XLM") return xlmUsd;
        return (prices as unknown as Record<string, number>)[key] ?? 1;
      },
    };
  }, [xlmUsd, isLoading, lastUpdated, refresh]);

  return <PriceContext.Provider value={value}>{children}</PriceContext.Provider>;
};

/**
 * Reads the full price context (`prices`, `xlmUsd`, `isLoading`, `lastUpdated`,
 * `refresh`, `getPrice`). Throws if used outside a {@link PriceProvider}.
 */
export const useTokenPrices = (): PriceContextValue => {
  const ctx = useContext(PriceContext);
  if (!ctx) {
    throw new Error("useTokenPrices must be used within a PriceProvider");
  }
  return ctx;
};

/**
 * Convenience selector for a single asset's USD price (case-insensitive).
 * Unknown assets resolve to 1 (treated as a USD-pegged stable). Re-renders on
 * each ledger-tick price refresh.
 */
export const useTokenPrice = (asset: string): number => {
  const { getPrice } = useTokenPrices();
  return getPrice(asset);
};
