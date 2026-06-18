'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ContractService, AssetType, ASSET_TYPES } from '@/lib/stellar-utils';
import { useUserStore } from '@/store/user';
import { useEarnPoolStore, addTransaction } from '@/store/earn-pool-store';
import { appendEarnHistory } from '@/lib/earn-history';
import { getEarnTransactionsFromMercury } from '@/lib/mercury-earn';
import { calculateExchangeRateFromPool, type AllPoolStats } from '@/lib/pool-stats';
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
};

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
          depositedBalances: { XLM: '0', USDC: '0', AQUARIUS_USDC: '0', SOROSWAP_USDC: '0' },
        });
        return EMPTY_POSITIONS;
      }

      useEarnPoolStore.getState().set({ isLoadingPositions: true });

      const [xlmVBalance, usdcVBalance, aquiresUsdcVBalance, soroswapUsdcVBalance] = await Promise.all([
        ContractService.getDepositedBalance(address, ASSET_TYPES.XLM),
        ContractService.getDepositedBalance(address, ASSET_TYPES.USDC),
        ContractService.getDepositedBalance(address, ASSET_TYPES.AQUARIUS_USDC),
        ContractService.getDepositedBalance(address, ASSET_TYPES.SOROSWAP_USDC),
      ]);

      const [xlmStats, usdcStats, aquiresUsdcStats, soroswapUsdcStats] = await Promise.all([
        ContractService.getPoolStats(ASSET_TYPES.XLM),
        ContractService.getPoolStats(ASSET_TYPES.USDC),
        ContractService.getPoolStats(ASSET_TYPES.AQUARIUS_USDC),
        ContractService.getPoolStats(ASSET_TYPES.SOROSWAP_USDC),
      ]);

      const xlmExchangeRate = parseFloat(calculateExchangeRateFromPool(xlmStats.totalSupply, xlmStats.vTokenSupply));
      const usdcExchangeRate = parseFloat(calculateExchangeRateFromPool(usdcStats.totalSupply, usdcStats.vTokenSupply));
      const aquiresUsdcExchangeRate = parseFloat(calculateExchangeRateFromPool(aquiresUsdcStats.totalSupply, aquiresUsdcStats.vTokenSupply));
      const soroswapUsdcExchangeRate = parseFloat(calculateExchangeRateFromPool(soroswapUsdcStats.totalSupply, soroswapUsdcStats.vTokenSupply));

      const xlmVBalanceNum = parseFloat(xlmVBalance) || 0;
      const usdcVBalanceNum = parseFloat(usdcVBalance) || 0;
      const aquiresUsdcVBalanceNum = parseFloat(aquiresUsdcVBalance) || 0;
      const soroswapUsdcVBalanceNum = parseFloat(soroswapUsdcVBalance) || 0;

      const xlmDeposited = (xlmVBalanceNum * xlmExchangeRate).toFixed(7);
      const usdcDeposited = (usdcVBalanceNum * usdcExchangeRate).toFixed(7);
      const aquiresUsdcDeposited = (aquiresUsdcVBalanceNum * aquiresUsdcExchangeRate).toFixed(7);
      const soroswapUsdcDeposited = (soroswapUsdcVBalanceNum * soroswapUsdcExchangeRate).toFixed(7);

      const [xlmBorrow, usdcBorrow, aquiresUsdcBorrow, soroswapUsdcBorrow] = await Promise.all([
        ContractService.getUserBorrowBalance(address, ASSET_TYPES.XLM),
        ContractService.getUserBorrowBalance(address, ASSET_TYPES.USDC),
        ContractService.getUserBorrowBalance(address, ASSET_TYPES.AQUARIUS_USDC),
        ContractService.getUserBorrowBalance(address, ASSET_TYPES.SOROSWAP_USDC),
      ]);

      const positions = {
        XLM: { deposited: xlmDeposited, vTokenBalance: xlmVBalance, borrowed: xlmBorrow, borrowShares: '0', earnedInterest: '0', accruedDebt: '0' },
        USDC: { deposited: usdcDeposited, vTokenBalance: usdcVBalance, borrowed: usdcBorrow, borrowShares: '0', earnedInterest: '0', accruedDebt: '0' },
        AQUARIUS_USDC: { deposited: aquiresUsdcDeposited, vTokenBalance: aquiresUsdcVBalance, borrowed: aquiresUsdcBorrow, borrowShares: '0', earnedInterest: '0', accruedDebt: '0' },
        SOROSWAP_USDC: { deposited: soroswapUsdcDeposited, vTokenBalance: soroswapUsdcVBalance, borrowed: soroswapUsdcBorrow, borrowShares: '0', earnedInterest: '0', accruedDebt: '0' },
      };

      useEarnPoolStore.getState().set({
        userPositions: positions,
        isLoadingPositions: false,
      });

      useUserStore.getState().set({
        depositedBalances: {
          XLM: xlmVBalance,
          USDC: usdcVBalance,
          AQUARIUS_USDC: aquiresUsdcVBalance,
          SOROSWAP_USDC: soroswapUsdcVBalance,
        },
      });

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
        appendEarnHistory({ asset: assetType, type: 'supply', amount: amount.toString(), hash, status: 'success' });
      }
    },

    // No optimistic write — the position must change only after the tx confirms.
    // ContractService.deposit waits for SUCCESS, so invalidate-on-settled refetches
    // the real on-chain balance; the ledger tick reconciles thereafter.
    onSettled: () => qc.invalidateQueries({ queryKey: ['earn'] }),
  });
};

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
        appendEarnHistory({ asset: assetType, type: 'withdraw', amount: amount.toString(), hash, status: 'success' });
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
    },
  });
};

// Hook to load on-chain earn pool transactions for the connected user.
// Uses react-query so the fetch re-fires automatically when the wallet
// reconnects after a page reload (enabled transitions false → true).
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

// Combined hook for earn page
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
