// Stellar-flavoured replacement for the original EVM-keyed store.
// Original shape was `byChain[chainId]` because Vanna's EVM build queried
// Base/Arbitrum/Optimism in parallel. Stellar runs on a single network, so
// the shape is flat. The single live consumer (`app/analytics/overview2/page.tsx`)
// has been updated to read this flat shape.

import { create } from "zustand";
import type { AccountSnapshot, AllAccountsResult } from "./types";
import { buildAnalyticsSnapshots } from "@/lib/analytics/stellar/buildSnapshots";

const CACHE_TTL_MS = 30_000;
const MIN_REFRESH_MS = 3_000;

type Store = {
  result: AllAccountsResult | null;
  fetchedAt: number;
  isLoading: boolean;
  error: string | null;
  inflight: Promise<AllAccountsResult> | null;
  isFresh: () => boolean;
  load: (
    userAddress: string | null,
    opts?: { force?: boolean },
  ) => Promise<AllAccountsResult | null>;
  clear: () => void;
};

const empty = (): Pick<Store, "result" | "fetchedAt" | "isLoading" | "error" | "inflight"> => ({
  result: null,
  fetchedAt: 0,
  isLoading: false,
  error: null,
  inflight: null,
});

export const useAnalyticsOnchainStore = create<Store>((set, get) => ({
  ...empty(),

  isFresh: () => {
    const s = get();
    if (!s.result) return false;
    return Date.now() - s.fetchedAt < CACHE_TTL_MS;
  },

  load: async (userAddress, opts) => {
    const force = opts?.force ?? false;
    const state = get();
    const now = Date.now();

    if (state.inflight) return state.inflight;
    if (!force && state.result && now - state.fetchedAt < CACHE_TTL_MS) return state.result;
    if (!force && state.result && now - state.fetchedAt < MIN_REFRESH_MS) return state.result;

    const promise = (async (): Promise<AllAccountsResult> => {
      try {
        const { accounts, realAccountCount } = await buildAnalyticsSnapshots(userAddress, { force });
        const result: AllAccountsResult = {
          chainId: 0, // synthetic — Stellar isn't EVM, callers don't read this
          accounts,
          fetchedAt: Date.now(),
          accountCount: accounts.length,
          realAccountCount,
          skippedCount: 0,
        };
        set({
          result,
          fetchedAt: result.fetchedAt,
          isLoading: false,
          error: null,
          inflight: null,
        });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ ...empty(), error: msg });
        throw err;
      }
    })();

    set({ ...get(), isLoading: true, error: null, inflight: promise });

    try {
      return await promise;
    } catch {
      return null;
    }
  },

  clear: () => set(empty()),
}));
