'use client';

import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { WalletService, ContractService, AssetType, ASSET_TYPES } from '@/lib/stellar-utils';
import { useUserStore } from '@/store/user';
import { useEarnPoolStore, addTransaction } from '@/store/earn-pool-store';
import { appendEarnHistory } from '@/lib/earn-history';

// ─────────────────────────────────────────────────────────────────────────────
// Pool data
//
// Moved to react-query so multiple consumers share a single fetch, the cache
// survives page navigation (gcTime 5 min), and stale-while-revalidate kicks in.
// We still write into `useEarnPoolStore` so components that read the pools
// from the store directly keep working unchanged (dual-write pattern).
// ─────────────────────────────────────────────────────────────────────────────
const calculateSupplyAPY = (utilizationRate: string) => {
  const utilization = parseFloat(utilizationRate) / 100;
  return (2.0 + utilization * 10).toFixed(2);
};

const calculateBorrowAPY = (utilizationRate: string) => {
  const utilization = parseFloat(utilizationRate) / 100;
  return (4.0 + utilization * 15).toFixed(2);
};

const calculateExchangeRateFromPool = (totalAssets: string, vTokenSupply: string) => {
  const assets = parseFloat(totalAssets) || 0;
  const supply = parseFloat(vTokenSupply) || 0;

  // Rate = total_assets / vToken_supply, where total_assets = available cash +
  // outstanding borrows (+ accrued interest). Borrows alone don't move the rate
  // since the loan is still owed back to the pool — cash drops but borrows rise
  // by the same amount. Interest pushes the rate above 1, so 1 vToken > 1 asset.
  if (assets <= 0 || supply <= 0) return '1';
  return (assets / supply).toFixed(7);
};

export const usePoolData = () => {
  const storePools = useEarnPoolStore((s) => s.pools);
  const lastUpdated = useEarnPoolStore((s) => s.lastUpdated);

  const query = useQuery({
    queryKey: ['earn', 'pools'],
    queryFn: async () => {
      useEarnPoolStore.getState().set({ isLoadingPools: true });

      const [xlmStats, usdcStats, aquiresUsdcStats, soroswapUsdcStats] = await Promise.all([
        ContractService.getPoolStats(ASSET_TYPES.XLM),
        ContractService.getPoolStats(ASSET_TYPES.USDC),
        ContractService.getPoolStats(ASSET_TYPES.AQUARIUS_USDC),
        ContractService.getPoolStats(ASSET_TYPES.SOROSWAP_USDC),
      ]);

      const mapped = {
        XLM: {
          ...xlmStats,
          supplyAPY: calculateSupplyAPY(xlmStats.utilizationRate),
          borrowAPY: calculateBorrowAPY(xlmStats.utilizationRate),
          exchangeRate: calculateExchangeRateFromPool(xlmStats.totalSupply, xlmStats.vTokenSupply),
        },
        USDC: {
          ...usdcStats,
          supplyAPY: calculateSupplyAPY(usdcStats.utilizationRate),
          borrowAPY: calculateBorrowAPY(usdcStats.utilizationRate),
          exchangeRate: calculateExchangeRateFromPool(usdcStats.totalSupply, usdcStats.vTokenSupply),
        },
        AQUARIUS_USDC: {
          ...aquiresUsdcStats,
          supplyAPY: calculateSupplyAPY(aquiresUsdcStats.utilizationRate),
          borrowAPY: calculateBorrowAPY(aquiresUsdcStats.utilizationRate),
          exchangeRate: calculateExchangeRateFromPool(aquiresUsdcStats.totalSupply, aquiresUsdcStats.vTokenSupply),
        },
        SOROSWAP_USDC: {
          ...soroswapUsdcStats,
          supplyAPY: calculateSupplyAPY(soroswapUsdcStats.utilizationRate),
          borrowAPY: calculateBorrowAPY(soroswapUsdcStats.utilizationRate),
          exchangeRate: calculateExchangeRateFromPool(soroswapUsdcStats.totalSupply, soroswapUsdcStats.vTokenSupply),
        },
      };

      useEarnPoolStore.getState().set({
        pools: mapped,
        lastUpdated: Date.now(),
        isLoadingPools: false,
      });

      return mapped;
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  // Let the store's loading flag stay false after an error — the store write
  // in queryFn only runs on success. Reset it here so retries don't get stuck.
  if (query.isError) {
    useEarnPoolStore.getState().set({ isLoadingPools: false });
  }

  return {
    pools: query.data ?? storePools,
    isLoading: query.isLoading || query.isFetching,
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

  if (query.isError) {
    useEarnPoolStore.getState().set({ isLoadingPositions: false });
  }

  return {
    positions: query.data ?? storePositions,
    isLoading: query.isLoading || query.isFetching,
    error: query.error ? (query.error as Error).message : null,
    refresh: () => query.refetch(),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Mutations — stay imperative. react-query's `useMutation` would be a clean
// fit here, but the message/loading UX is already wired through setState and
// the callers expect the existing return shape.
// ─────────────────────────────────────────────────────────────────────────────
export const useSupplyLiquidity = () => {
  const address = useUserStore((state) => state.address);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info' | '', text: string }>({ type: '', text: '' });

  const normalizeSupplyError = useCallback((rawError: string | undefined, assetType: AssetType) => {
    const fallback = `Failed to supply ${assetType}. Please try again.`;
    if (!rawError) return fallback;

    const text = rawError.replace(/\s+/g, ' ').trim();
    const lowerText = text.toLowerCase();

    if (
      lowerText.includes('cancelled') ||
      lowerText.includes('canceled') ||
      lowerText.includes('rejected by user')
    ) {
      return 'Transaction cancelled by user.';
    }

    if (
      lowerText.includes('insufficient') ||
      lowerText.includes('underfunded') ||
      lowerText.includes('insufficientbalance') ||
      lowerText.includes('balance is not sufficient')
    ) {
      return `You cannot supply all your ${assetType}. Keep a small balance and try again.`;
    }

    if (
      lowerText.includes('diagnostic event') ||
      lowerText.includes('hosterror') ||
      lowerText.includes('sorobanrpcerror') ||
      lowerText.includes('transaction failed') ||
      lowerText.includes('error(contract')
    ) {
      return `Supply failed for ${assetType}. Please reduce the amount and try again.`;
    }

    return text.length > 180 ? `${text.slice(0, 180)}...` : text;
  }, []);

  const refreshAllBalances = useCallback(async () => {
    if (!address) return;

    try {
      const balance = await WalletService.getBalance(address);

      const [xlmDeposited, usdcDeposited, aquiresUsdcDeposited, soroswapUsdcDeposited] = await Promise.all([
        ContractService.getDepositedBalance(address, ASSET_TYPES.XLM),
        ContractService.getDepositedBalance(address, ASSET_TYPES.USDC),
        ContractService.getDepositedBalance(address, ASSET_TYPES.AQUARIUS_USDC),
        ContractService.getDepositedBalance(address, ASSET_TYPES.SOROSWAP_USDC),
      ]);

      useUserStore.getState().set({
        balance,
        depositedBalances: {
          XLM: xlmDeposited,
          USDC: usdcDeposited,
          AQUARIUS_USDC: aquiresUsdcDeposited,
          SOROSWAP_USDC: soroswapUsdcDeposited,
        },
      });
    } catch (error) {
      console.error('Error refreshing balances:', error);
    }
  }, [address]);

  const supply = useCallback(async (amount: number, assetType: AssetType = ASSET_TYPES.XLM) => {
    if (!address) {
      setMessage({ type: 'error', text: 'Please connect your wallet first' });
      return { success: false };
    }

    if (!amount || amount <= 0) {
      setMessage({ type: 'error', text: 'Please enter a valid amount' });
      return { success: false };
    }

    try {
      setIsLoading(true);
      setMessage({ type: 'info', text: `Supplying ${amount} ${assetType} to the lending pool...` });

      const result = await ContractService.deposit(address, amount, assetType);

      if (result.success) {
        setMessage({ type: 'success', text: `Successfully supplied ${amount} ${assetType}! You received v${assetType} tokens.` });

        if (result.hash) {
          addTransaction('supply', assetType, amount.toString(), result.hash, 'success');
          appendEarnHistory({
            asset: assetType,
            type: 'supply',
            amount: amount.toString(),
            hash: result.hash,
            status: 'success',
          });
        }

        await refreshAllBalances();

        return { success: true, hash: result.hash };
      } else {
        setMessage({ type: 'error', text: normalizeSupplyError(result.error, assetType) });
        return { success: false };
      }
    } catch (error: any) {
      setMessage({ type: 'error', text: normalizeSupplyError(error?.message, assetType) });
      return { success: false };
    } finally {
      setIsLoading(false);
    }
  }, [address, refreshAllBalances, normalizeSupplyError]);

  return {
    supply,
    isLoading,
    message,
    clearMessage: () => setMessage({ type: '', text: '' }),
  };
};

export const useWithdrawLiquidity = () => {
  const address = useUserStore((state) => state.address);
  const userPositions = useEarnPoolStore((s) => s.userPositions);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info' | '', text: string }>({ type: '', text: '' });

  const normalizeWithdrawError = useCallback((rawError: string | undefined, assetType: AssetType) => {
    const fallback = `Failed to withdraw ${assetType}. Please try again.`;
    if (!rawError) return fallback;

    const text = rawError.replace(/\s+/g, ' ').trim();
    const lowerText = text.toLowerCase();

    if (
      lowerText.includes('cancelled') ||
      lowerText.includes('canceled') ||
      lowerText.includes('rejected by user')
    ) {
      return 'Transaction cancelled by user.';
    }

    if (
      lowerText.includes('insufficient') ||
      lowerText.includes('underfunded') ||
      lowerText.includes('insufficientbalance') ||
      lowerText.includes('balance is not sufficient')
    ) {
      return `You cannot withdraw all your v${assetType}. Keep a small balance and try again.`;
    }

    if (
      lowerText.includes('diagnostic event') ||
      lowerText.includes('hosterror') ||
      lowerText.includes('sorobanrpcerror') ||
      lowerText.includes('transaction failed') ||
      lowerText.includes('error(contract')
    ) {
      return `Withdraw failed for ${assetType}. Please reduce the amount and try again.`;
    }

    return text.length > 180 ? `${text.slice(0, 180)}...` : text;
  }, []);

  const refreshAllBalances = useCallback(async () => {
    if (!address) return;

    try {
      const balance = await WalletService.getBalance(address);

      const [xlmDeposited, usdcDeposited, aquiresUsdcDeposited, soroswapUsdcDeposited] = await Promise.all([
        ContractService.getDepositedBalance(address, ASSET_TYPES.XLM),
        ContractService.getDepositedBalance(address, ASSET_TYPES.USDC),
        ContractService.getDepositedBalance(address, ASSET_TYPES.AQUARIUS_USDC),
        ContractService.getDepositedBalance(address, ASSET_TYPES.SOROSWAP_USDC),
      ]);

      useUserStore.getState().set({
        balance,
        depositedBalances: {
          XLM: xlmDeposited,
          USDC: usdcDeposited,
          AQUARIUS_USDC: aquiresUsdcDeposited,
          SOROSWAP_USDC: soroswapUsdcDeposited,
        },
      });

      const poolRates = useEarnPoolStore.getState().pools;
      const xlmRate = parseFloat(poolRates.XLM.exchangeRate || '1') || 1;
      const usdcRate = parseFloat(poolRates.USDC.exchangeRate || '1') || 1;
      const aquiresUsdcRate = parseFloat(poolRates.AQUARIUS_USDC.exchangeRate || '1') || 1;
      const soroswapUsdcRate = parseFloat(poolRates.SOROSWAP_USDC.exchangeRate || '1') || 1;

      useEarnPoolStore.getState().set({
        userPositions: {
          XLM: {
            ...useEarnPoolStore.getState().userPositions.XLM,
            vTokenBalance: xlmDeposited,
            deposited: ((parseFloat(xlmDeposited) || 0) * xlmRate).toFixed(7),
          },
          USDC: {
            ...useEarnPoolStore.getState().userPositions.USDC,
            vTokenBalance: usdcDeposited,
            deposited: ((parseFloat(usdcDeposited) || 0) * usdcRate).toFixed(7),
          },
          AQUARIUS_USDC: {
            ...useEarnPoolStore.getState().userPositions.AQUARIUS_USDC,
            vTokenBalance: aquiresUsdcDeposited,
            deposited: ((parseFloat(aquiresUsdcDeposited) || 0) * aquiresUsdcRate).toFixed(7),
          },
          SOROSWAP_USDC: {
            ...useEarnPoolStore.getState().userPositions.SOROSWAP_USDC,
            vTokenBalance: soroswapUsdcDeposited,
            deposited: ((parseFloat(soroswapUsdcDeposited) || 0) * soroswapUsdcRate).toFixed(7),
          },
        },
      });
    } catch (error) {
      console.error('Error refreshing balances:', error);
    }
  }, [address]);

  const withdraw = useCallback(async (amount: number, assetType: AssetType = ASSET_TYPES.XLM) => {
    if (!address) {
      setMessage({ type: 'error', text: 'Please connect your wallet first' });
      return { success: false };
    }

    if (!amount || amount <= 0) {
      setMessage({ type: 'error', text: 'Please enter a valid amount' });
      return { success: false };
    }

    const userPosition = assetType === ASSET_TYPES.BLEND_USDC ? userPositions.USDC : userPositions[assetType];
    const depositedAmount = parseFloat(userPosition?.vTokenBalance || '0');
    if (amount > depositedAmount) {
      setMessage({ type: 'error', text: `Cannot withdraw more than deposited balance (${depositedAmount.toFixed(7)} v${assetType})` });
      return { success: false };
    }

    try {
      setIsLoading(true);
      setMessage({ type: 'info', text: `Withdrawing ${amount} v${assetType} from the lending pool...` });

      const result = await ContractService.withdraw(address, amount, assetType);

      if (result.success) {
        setMessage({ type: 'success', text: `Successfully withdrew ${assetType}! Transaction confirmed.` });

        if (result.hash) {
          addTransaction('withdraw', assetType, amount.toString(), result.hash, 'success');
          appendEarnHistory({
            asset: assetType,
            type: 'withdraw',
            amount: amount.toString(),
            hash: result.hash,
            status: 'success',
          });
        }

        await refreshAllBalances();

        return { success: true, hash: result.hash };
      } else {
        setMessage({ type: 'error', text: normalizeWithdrawError(result.error, assetType) });
        return { success: false };
      }
    } catch (error: any) {
      setMessage({ type: 'error', text: normalizeWithdrawError(error?.message, assetType) });
      return { success: false };
    } finally {
      setIsLoading(false);
    }
  }, [address, userPositions, refreshAllBalances, normalizeWithdrawError]);

  return {
    withdraw,
    isLoading,
    message,
    depositedBalances: {
      XLM: userPositions.XLM?.vTokenBalance || '0',
      USDC: userPositions.USDC?.vTokenBalance || '0',
      AQUARIUS_USDC: userPositions.AQUARIUS_USDC?.vTokenBalance || '0',
      SOROSWAP_USDC: userPositions.SOROSWAP_USDC?.vTokenBalance || '0',
    },
    clearMessage: () => setMessage({ type: '', text: '' }),
  };
};

// Hook to load on-chain earn pool transactions for the connected user.
// Uses react-query so the fetch re-fires automatically when the wallet
// reconnects after a page reload (enabled transitions false → true).
export const useEarnTransactions = () => {
  const address = useUserStore((state) => state.address);
  const isConnected = useUserStore((state) => state.isConnected);

  const query = useQuery({
    queryKey: ['earn', 'transactions', address ?? null],
    enabled: Boolean(address && isConnected),
    queryFn: async () => {
      if (!address) return [];
      return ContractService.getEarnPoolEvents(address);
    },
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchInterval: address && isConnected ? 10_000 : false,
    refetchOnWindowFocus: true,
  });

  return {
    transactions: query.data ?? [],
    isLoading: query.isLoading || query.isFetching,
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
