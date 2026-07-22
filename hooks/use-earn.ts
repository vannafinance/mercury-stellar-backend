'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ContractService, AssetType, ASSET_TYPES } from '@/lib/stellar-utils';
import { useUserStore } from '@/store/user';
import { useEarnPoolStore, addTransaction } from '@/store/earn-pool-store';
import { appendEarnHistory } from '@/lib/earn-history';
import { getEarnTransactionsFromMercury } from '@/lib/mercury-earn';
import { type AllPoolStats } from '@/lib/pool-stats';
import { useLedgerTick } from '@/contexts/ledger-subscriber';
import { normalizeSupplyError, normalizeWithdrawError } from '@/lib/errors/normalize';

// ─────────────────────────────────────────────────────────────────────────────
// Pool data
//
// Moved to react-query so multiple consumers share a single fetch, the cache
// survives page navigation (gcTime 5 min), and stale-while-revalidate kicks in.
// We still write into `useEarnPoolStore` so components that read the pools
// from the store directly keep working unchanged (dual-write pattern).
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Lending-pool market stats from the cached `/api/pools` edge route.
 *
 * Shared across consumers via React Query; ledger-tick invalidates and
 * staleTime 4s gives stale-while-revalidate (data stays on screen during
 * background refetch). Dual-writes into `useEarnPoolStore`.
 *
 * @returns `{ pools, isLoading, isRefreshing, lastUpdated, error, refresh }` —
 *   `pools` falls back to the store snapshot until the first fetch resolves.
 */
export const usePoolData = () => {
  const storePools = useEarnPoolStore((s) => s.pools);
  const lastUpdated = useEarnPoolStore((s) => s.lastUpdated);
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const query = useQuery({
    queryKey: ['earn', 'pools'],
    queryFn: async (): Promise<AllPoolStats> => {
      useEarnPoolStore.getState().set({ isLoadingPools: true });

      // Pool stats now come from the cached /api/pools edge route (shared across
      // all users; APY/exchange-rate computed server-side). Still dual-written
      // into the earn store so direct store readers keep working.
      const res = await fetch('/api/pools');
      if (!res.ok) {
        useEarnPoolStore.getState().set({ isLoadingPools: false });
        throw new Error(`pool stats failed (${res.status})`);
      }
      const mapped = (await res.json()) as AllPoolStats;

      useEarnPoolStore.getState().set({
        pools: mapped,
        lastUpdated: Date.now(),
        isLoadingPools: false,
      });

      return mapped;
    },
    staleTime: 4_000,
  });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    qc.invalidateQueries({ queryKey: ['earn', 'pools'] });
  }, [tick, qc]);

  if (query.isError) {
    useEarnPoolStore.getState().set({ isLoadingPools: false });
  }

  return {
    pools: query.data ?? storePools,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    lastUpdated,
    error: query.error ? (query.error as Error).message : null,
    refresh: () => query.refetch(),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// User positions
// ─────────────────────────────────────────────────────────────────────────────
const EMPTY_POSITION = {
  deposited: '0',
  vTokenBalance: '0',
  borrowed: '0',
  borrowShares: '0',
  earnedInterest: '0',
  accruedDebt: '0',
};

const EMPTY_POSITIONS = {
  XLM: { ...EMPTY_POSITION },
  USDC: { ...EMPTY_POSITION },
  AQUARIUS_USDC: { ...EMPTY_POSITION },
  SOROSWAP_USDC: { ...EMPTY_POSITION },
  BLND: { ...EMPTY_POSITION },
  AQUA: { ...EMPTY_POSITION },
  WETH: { ...EMPTY_POSITION },
  EURC: { ...EMPTY_POSITION },
};

const EARN_ASSETS = [
  ASSET_TYPES.XLM,
  ASSET_TYPES.USDC,
  ASSET_TYPES.AQUARIUS_USDC,
  ASSET_TYPES.SOROSWAP_USDC,
  ASSET_TYPES.BLND,
  ASSET_TYPES.AQUA,
  ASSET_TYPES.WETH,
  ASSET_TYPES.EURC,
] as const;

const EMPTY_DEPOSITED = {
  XLM: '0',
  USDC: '0',
  AQUARIUS_USDC: '0',
  SOROSWAP_USDC: '0',
  BLND: '0',
  AQUA: '0',
  WETH: '0',
  EURC: '0',
};

/**
 * The connected user's per-pool positions (deposited, vToken balance, borrowed).
 *
 * Enabled only when a wallet is connected. Collapses the deposit/pool-stats/
 * borrow reads into one concurrent batch and derives `deposited` from the cached
 * exchange rate. Ledger-tick invalidated; dual-writes positions into the earn
 * store and deposited balances into the user store. Returns EMPTY_POSITIONS when
 * disconnected.
 *
 * @returns `{ positions, isLoading, isRefreshing, error, refresh }`.
 */
export const useUserPositions = () => {
  const address = useUserStore((state) => state.address);
  const isConnected = useUserStore((state) => state.isConnected);
  const storePositions = useEarnPoolStore((s) => s.userPositions);
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const query = useQuery({
    queryKey: ['earn', 'userPositions', address ?? null],
    enabled: Boolean(address && isConnected),
    queryFn: async () => {
      if (!address) {
        useEarnPoolStore.getState().set({ userPositions: EMPTY_POSITIONS });
        useUserStore.getState().set({
          depositedBalances: { ...EMPTY_DEPOSITED },
        });
        return EMPTY_POSITIONS;
      }

      useEarnPoolStore.getState().set({ isLoadingPositions: true });

      // Collapse the 3 serial RPC waves (deposits → pool stats → borrows) into a
      // single concurrent batch, and reuse the cached /api/pools route for
      // exchange rates instead of re-reading getPoolStats per pool.
      const [vBalances, poolsRes, borrows] = await Promise.all([
        Promise.all(EARN_ASSETS.map((a) => ContractService.getDepositedBalance(address, a))),
        fetch('/api/pools')
          .then((r) => (r.ok ? (r.json() as Promise<AllPoolStats>) : null))
          .catch(() => null),
        Promise.all(EARN_ASSETS.map((a) => ContractService.getUserBorrowBalance(address, a))),
      ]);

      const positions = { ...EMPTY_POSITIONS } as typeof EMPTY_POSITIONS;
      const depositedBalances = { ...EMPTY_DEPOSITED };

      EARN_ASSETS.forEach((asset, i) => {
        const vBal = vBalances[i];
        const borrow = borrows[i];
        const key = asset as keyof AllPoolStats;
        const rate = poolsRes ? parseFloat(poolsRes[key].exchangeRate) || 1 : 1;
        const vNum = parseFloat(vBal) || 0;
        positions[asset] = {
          deposited: (vNum * rate).toFixed(7),
          vTokenBalance: vBal,
          borrowed: borrow,
          borrowShares: '0',
          earnedInterest: '0',
          accruedDebt: '0',
        };
        depositedBalances[asset] = vBal;
      });

      useEarnPoolStore.getState().set({
        userPositions: positions,
        isLoadingPositions: false,
      });

      useUserStore.getState().set({ depositedBalances });

      return positions;
    },
  });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    qc.invalidateQueries({ queryKey: ['earn', 'userPositions'] });
  }, [tick, qc]);

  if (query.isError) {
    useEarnPoolStore.getState().set({ isLoadingPositions: false });
  }

  const isWalletConnected = Boolean(address && isConnected);

  return {
    positions: isWalletConnected ? (query.data ?? storePositions) : EMPTY_POSITIONS,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    error: query.error ? (query.error as Error).message : null,
    refresh: () => query.refetch(),
  };
};

/**
 * Mutation to supply (deposit) liquidity into a pool. Variables:
 * `{ amount, assetType }`. No optimistic write — `ContractService.deposit`
 * waits for SUCCESS, then `onSettled` invalidates `['earn']` to refetch the real
 * balance. Records the tx in the store/earn-history and normalizes errors.
 */
export const useSupplyLiquidity = () => {
  const qc = useQueryClient();
  const address = useUserStore((state) => state.address);

  return useMutation({
    mutationFn: async ({ amount, assetType }: { amount: number; assetType: AssetType }) => {
      if (!address) throw new Error('Please connect your wallet first');
      if (!amount || amount <= 0) throw new Error('Please enter a valid amount');

      const result = await ContractService.deposit(address, amount, assetType);
      if (!result.success) {
        throw new Error(normalizeSupplyError(result.error, assetType));
      }
      return { hash: result.hash, amount, assetType };
    },

    onSuccess: ({ hash, amount, assetType }) => {
      if (hash) {
        addTransaction('supply', assetType, amount.toString(), hash, 'success');
        if (address) {
          appendEarnHistory({ walletAddress: address, asset: assetType, type: 'supply', amount: amount.toString(), hash, status: 'success' });
        }
      }
    },

    // No optimistic write — the position must change only after the tx confirms.
    // ContractService.deposit waits for SUCCESS, so invalidate-on-settled refetches
    // the real on-chain balance; the ledger tick reconciles thereafter.
    onSettled: () => qc.invalidateQueries({ queryKey: ['earn'] }),
  });
};

/**
 * Mutation to withdraw liquidity from a pool. Variables: `{ amount, assetType }`.
 * Guards against withdrawing more than the deposited vToken balance, waits for
 * SUCCESS, then invalidates `['earn']`. The returned object is augmented with a
 * `depositedBalances` map (per-asset vToken balances) for max-amount UIs.
 */
export const useWithdrawLiquidity = () => {
  const qc = useQueryClient();
  const address = useUserStore((state) => state.address);
  const userPositions = useEarnPoolStore((s) => s.userPositions);

  const mutation = useMutation({
    mutationFn: async ({ amount, assetType }: { amount: number; assetType: AssetType }) => {
      if (!address) throw new Error('Please connect your wallet first');
      if (!amount || amount <= 0) throw new Error('Please enter a valid amount');

      const userPosition = assetType === ASSET_TYPES.BLEND_USDC ? userPositions.USDC : userPositions[assetType];
      const depositedAmount = parseFloat(userPosition?.vTokenBalance || '0');
      if (amount > depositedAmount) {
        throw new Error(`Cannot withdraw more than deposited balance (${depositedAmount.toFixed(7)} v${assetType})`);
      }

      const result = await ContractService.withdraw(address, amount, assetType);
      if (!result.success) {
        throw new Error(normalizeWithdrawError(result.error, assetType));
      }
      return { hash: result.hash, amount, assetType };
    },

    onSuccess: ({ hash, amount, assetType }) => {
      if (hash) {
        addTransaction('withdraw', assetType, amount.toString(), hash, 'success');
        if (address) {
          appendEarnHistory({ walletAddress: address, asset: assetType, type: 'withdraw', amount: amount.toString(), hash, status: 'success' });
        }
      }
    },

    // No optimistic write — the position must change only after the tx confirms.
    // ContractService.withdraw waits for SUCCESS, so invalidate-on-settled refetches
    // the real on-chain balance; the ledger tick reconciles thereafter.
    onSettled: () => qc.invalidateQueries({ queryKey: ['earn'] }),
  });

  return Object.assign(mutation, {
    depositedBalances: {
      XLM: userPositions.XLM?.vTokenBalance || '0',
      USDC: userPositions.USDC?.vTokenBalance || '0',
      AQUARIUS_USDC: userPositions.AQUARIUS_USDC?.vTokenBalance || '0',
      SOROSWAP_USDC: userPositions.SOROSWAP_USDC?.vTokenBalance || '0',
      BLND: userPositions.BLND?.vTokenBalance || '0',
      AQUA: userPositions.AQUA?.vTokenBalance || '0',
      WETH: userPositions.WETH?.vTokenBalance || '0',
      EURC: userPositions.EURC?.vTokenBalance || '0',
    },
  });
};

/**
 * On-chain earn-pool transaction history for the connected user, sourced from
 * Mercury. Enabled only when connected, so the fetch re-fires automatically on
 * reconnect (enabled false → true). Ledger-tick invalidated; refetches on window
 * focus.
 *
 * @returns `{ transactions, isLoading, isRefreshing, refresh }`.
 */
export const useEarnTransactions = () => {
  const address = useUserStore((state) => state.address);
  const isConnected = useUserStore((state) => state.isConnected);
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const query = useQuery({
    queryKey: ['earn', 'transactions', address ?? null],
    enabled: Boolean(address && isConnected),
    queryFn: async () => {
      if (!address) return [];
      return getEarnTransactionsFromMercury(address);
    },
    staleTime: 4_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    qc.invalidateQueries({ queryKey: ['earn', 'transactions'] });
  }, [tick, qc]);

  return {
    transactions: query.data ?? [],
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    refresh: () => query.refetch(),
  };
};

/**
 * Aggregate hook for the Earn page: composes `usePoolData` + `useUserPositions`
 * + wallet/store state and derives totals (total deposited/borrowed, deposit-
 * weighted APY). Exposes a single `refresh` that refetches pools and positions
 * together.
 */
export const useEarnPage = () => {
  const wallet = useUserStore();
  const poolData = usePoolData();
  const userPositionsData = useUserPositions();
  const { recentTransactions } = useEarnPoolStore();

  const totalDeposited = Object.values(userPositionsData.positions).reduce(
    (sum, pos) => sum + (parseFloat(pos.deposited) || 0),
    0
  );

  const totalBorrowed = Object.values(userPositionsData.positions).reduce(
    (sum, pos) => sum + (parseFloat(pos.borrowed) || 0),
    0
  );

  const calculateWeightedAPY = () => {
    let totalValue = 0;
    let weightedAPY = 0;

    Object.entries(poolData.pools).forEach(([asset, pool]) => {
      const deposited = parseFloat(userPositionsData.positions[asset as keyof typeof userPositionsData.positions]?.deposited || '0');
      if (deposited > 0) {
        totalValue += deposited;
        weightedAPY += deposited * parseFloat(pool.supplyAPY || '0');
      }
    });

    return totalValue > 0 ? (weightedAPY / totalValue).toFixed(2) : '0';
  };

  const refresh = useCallback(async () => {
    await Promise.all([
      poolData.refresh(),
      userPositionsData.refresh(),
    ]);
  }, [poolData, userPositionsData]);

  return {
    isConnected: wallet.isConnected,
    address: wallet.address,
    nativeBalance: wallet.balance,

    pools: poolData.pools,
    isLoadingPools: poolData.isLoading,

    userPositions: userPositionsData.positions,
    isLoadingPositions: userPositionsData.isLoading,

    totalDeposited,
    totalBorrowed,
    weightedAPY: calculateWeightedAPY(),

    recentTransactions,

    refresh,
  };
};
