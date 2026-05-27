"use client";

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  buildPrices,
  fetchXlmPriceUsd,
  readCachedXlmPrice,
  TokenPrices,
  XLM_FALLBACK_PRICE,
} from "@/lib/prices";
import { useLedgerTick } from "@/contexts/ledger-subscriber";

interface PriceContextValue {
  prices: TokenPrices;
  xlmUsd: number;
  isLoading: boolean;
  lastUpdated: number | null;
  refresh: () => Promise<void>;
  getPrice: (asset: string) => number;
}

const PriceContext = createContext<PriceContextValue | undefined>(undefined);

export const PriceProvider = ({ children }: { children: React.ReactNode }) => {
  const [xlmUsd, setXlmUsd] = useState<number>(() => readCachedXlmPrice() ?? XLM_FALLBACK_PRICE);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const mountedRef = useRef(true);
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const refresh = useMemo(
    () => async () => {
      try {
        const price = await fetchXlmPriceUsd(true);
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

export const useTokenPrices = (): PriceContextValue => {
  const ctx = useContext(PriceContext);
  if (!ctx) {
    throw new Error("useTokenPrices must be used within a PriceProvider");
  }
  return ctx;
};

export const useTokenPrice = (asset: string): number => {
  const { getPrice } = useTokenPrices();
  return getPrice(asset);
};
