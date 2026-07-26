import { useState, useEffect, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { normalizeContractError } from '@/lib/errors/normalize';
import { WalletService, ContractService, AssetType, ASSET_TYPES } from '@/lib/stellar-utils';
import { setActiveWalletKind, getPrivyAuthControls, type WalletKind } from '@/lib/wallet-adapter';
import { useUserStore } from '@/store/user';
import { clearMarginAccount } from '@/store/margin-account-info-store';

/**
 * Wallet connection lifecycle and balances, backed by `useUserStore`.
 *
 * Auto-checks the connection on mount and window focus (unless the user manually
 * disconnected), refreshes wallet + per-pool deposited balances (each guarded by
 * a 15s timeout so a stalled RPC never blocks the UI), and exposes connect/
 * disconnect actions. Disconnect resets in-memory state and clears the cached
 * margin-account stats (via `clearMarginAccount`) but preserves the wallet-keyed
 * localStorage margin mapping. Balance-refresh failures are non-fatal and retried.
 *
 * @returns `{ address, isConnected, balance, depositedBalances, isLoading,
 *   connectWallet, disconnectWallet, refreshBalances }`.
 */
export const useWallet = () => {
  const address = useUserStore((state) => state.address);
  const isConnected = useUserStore((state) => state.isConnected);
  const walletKind = useUserStore((state) => state.walletKind);
  const balance = useUserStore((state) => state.balance);
  const depositedBalances = useUserStore((state) => state.depositedBalances);
  const isLoadingStore = useUserStore((state) => state.isLoading);
  
  const [isLoading, setIsLoading] = useState(false);

  // Force reset loading state on mount to fix stuck "Connecting..." state
  useEffect(() => {
    setIsLoading(false);
    if (isLoadingStore) {
      useUserStore.getState().set({ isLoading: false });
    }
  }, []);

  const refreshBalances = useCallback(async (walletAddress?: string) => {
    const targetAddress = walletAddress || address;
    if (!targetAddress) return;

    try {
      // Create a promise that rejects after 15 seconds
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Balance refresh timeout')), 15000)
      );

      // Race between the actual request and the timeout
      const tokenBalances = await Promise.race([
        ContractService.getAllTokenBalances(targetAddress),
        timeoutPromise
      ]);

      // Update wallet balances immediately so UI is never blocked by deposited-balance calls.
      useUserStore.getState().set({
        balance: tokenBalances.XLM,
        tokenBalances: tokenBalances,
      });
      
      // Get all deposited balances in parallel
      const depositedBalancesPromise = Promise.all([
        ContractService.getDepositedBalance(targetAddress, ASSET_TYPES.XLM),
        ContractService.getDepositedBalance(targetAddress, ASSET_TYPES.USDC),
        ContractService.getDepositedBalance(targetAddress, ASSET_TYPES.AQUARIUS_USDC),
        ContractService.getDepositedBalance(targetAddress, ASSET_TYPES.SOROSWAP_USDC),
      ]);

      try {
        const [
          xlmDeposited,
          usdcDeposited,
          aquariusUsdcDeposited,
          soroswapUsdcDeposited,
        ] = await Promise.race([
          depositedBalancesPromise,
          timeoutPromise
        ]);

        useUserStore.getState().set({
          depositedBalances: {
            XLM: xlmDeposited,
            USDC: usdcDeposited,
            AQUARIUS_USDC: aquariusUsdcDeposited,
            SOROSWAP_USDC: soroswapUsdcDeposited,
          },
        });
      } catch (depositedError) {
        console.warn('Deposited balances refresh failed; wallet balances still updated:', depositedError);
      }
      
    } catch (error) {
      // Non-fatal: a transient RPC/Horizon failure shouldn't block the wallet or
      // light up the dev error overlay — warn and let the next refresh recover.
      console.warn('Error refreshing balances (non-fatal, will retry):', error);
    }
  }, [address]);

  const checkConnection = useCallback(async () => {
    // Don't auto-reconnect if user manually disconnected
    const { manuallyDisconnected, walletKind } = useUserStore.getState();
    if (manuallyDisconnected) {
      return;
    }

    // A persisted Privy session rehydrates through Privy's own SDK state
    // (see PrivyWalletBridge), which writes address/isConnected once it's
    // ready — there's nothing for the Freighter-specific check below to do.
    if (walletKind === 'privy') {
      setActiveWalletKind('privy');
      return;
    }

    setActiveWalletKind('freighter');
    try {
      const { address: walletAddress, connected } = await WalletService.checkConnection();
      if (connected && walletAddress) {
        useUserStore.getState().set({
          address: walletAddress,
          isConnected: connected,
          walletKind: 'freighter',
          isLoading: false,
        });
        await refreshBalances(walletAddress);
      } else {
        useUserStore.getState().set({
          address: null,
          isConnected: false,
          walletKind: null,
          balance: '0',
          tokenBalances: { XLM: '0', USDC: '0', BLEND_USDC: '0', AQUARIUS_USDC: '0', SOROSWAP_USDC: '0' },
          depositedBalances: { XLM: '0', USDC: '0', AQUARIUS_USDC: '0', SOROSWAP_USDC: '0' },
          isLoading: false,
        });
      }
    } catch (error) {
      console.error('Error checking connection:', error);
      useUserStore.getState().set({ isLoading: false });
    }
  }, [refreshBalances]);

  // Check wallet connection on mount and window focus
  useEffect(() => {
    checkConnection();
    
    const handleFocus = () => checkConnection();
    window.addEventListener('focus', handleFocus);
    
    return () => window.removeEventListener('focus', handleFocus);
  }, [checkConnection]);

  const connectWallet = useCallback(async (kind: WalletKind = 'freighter') => {
    if (kind === 'privy') {
      // Opens Privy's login modal; PrivyWalletBridge reactively writes
      // address/isConnected/walletKind into the store once the user
      // authenticates and their Stellar embedded wallet is ready.
      const controls = getPrivyAuthControls();
      if (!controls) {
        toast.error('Privy login is not available right now');
        return;
      }
      setActiveWalletKind('privy');
      controls.login();
      return;
    }

    try {
      setIsLoading(true);
      useUserStore.getState().set({ isLoading: true, manuallyDisconnected: false });

      setActiveWalletKind('freighter');
      const result = await WalletService.connectWallet();

      if (result.success) {

        // Set address and connected state immediately - don't wait for balance refresh
        useUserStore.getState().set({
          address: result.address,
          isConnected: true,
          walletKind: 'freighter',
          manuallyDisconnected: false,
        });

        // Refresh balances asynchronously with timeout to prevent hanging
        refreshBalances(result.address).catch((error) => {
          console.error('Error refreshing balances after connection:', error);
        });

        toast.success('Wallet connected successfully!');
      } else {
        console.error('Wallet connection failed:', result.error);
        toast.error(normalizeContractError(result.error, 'Failed to connect wallet'));
      }
    } catch (error: any) {
      console.error('Wallet connection error:', error);
      toast.error(normalizeContractError(error?.message, 'Failed to connect wallet'));
    } finally {
      setIsLoading(false);
      useUserStore.getState().set({ isLoading: false });
    }
  }, [refreshBalances]);

  const disconnectWallet = useCallback(() => {
    const { walletKind } = useUserStore.getState();
    if (walletKind === 'privy') {
      getPrivyAuthControls()?.logout().catch((error) => {
        console.error('Error logging out of Privy:', error);
      });
    }
    setActiveWalletKind(null);

    // Don't clear localStorage - margin accounts should persist across wallet
    // connections (the address-stored mapping is keyed by user pubkey).
    // But DO reset in-memory state so the UI doesn't keep showing the
    // previous wallet's totals (HF, collateral, debt, etc.) after disconnect.
    useUserStore.getState().set({
      address: null,
      isConnected: false,
      walletKind: null,
      balance: '0',
      tokenBalances: { XLM: '0', USDC: '0', BLEND_USDC: '0', AQUARIUS_USDC: '0', SOROSWAP_USDC: '0' },
      depositedBalances: { XLM: '0', USDC: '0', AQUARIUS_USDC: '0', SOROSWAP_USDC: '0' },
      manuallyDisconnected: true, // Mark as manually disconnected to prevent auto-reconnect
      isLoading: false,
    });
    // Clear cached margin-account stats so the margin page renders zeros
    // instead of the old user's HF / collateral / debt.
    clearMarginAccount();
    setIsLoading(false);
    toast('Wallet disconnected');
  }, []);

  return {
    address,
    isConnected,
    walletKind,
    balance,
    depositedBalances,
    isLoading: isLoading || isLoadingStore,
    connectWallet,
    disconnectWallet,
    refreshBalances,
  };
};

/**
 * Mutation to deposit into a pool. Variables: `{ amount, assetType }`. Requires a
 * connected wallet and a positive amount; on success invalidates `['earn']` and
 * `['margin']` to refetch real balances. (Lower-level than `useSupplyLiquidity` —
 * no toast/history side effects.)
 */
export const useDeposit = () => {
  const qc = useQueryClient();
  const address = useUserStore((state) => state.address);

  return useMutation({
    mutationFn: async ({ amount, assetType }: { amount: number; assetType: AssetType }) => {
      if (!address) throw new Error('Please connect your wallet first');
      if (!amount || amount <= 0) throw new Error('Please enter a valid amount');

      const result = await ContractService.deposit(address, amount, assetType);
      if (!result.success) {
        throw new Error(result.error || 'Deposit failed');
      }
      return { hash: result.hash, amount, assetType };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['earn'] });
      qc.invalidateQueries({ queryKey: ['margin'] });
    },
  });
};

/**
 * Mutation to withdraw from a pool. Variables: `{ amount, assetType }`. Requires
 * a connected wallet, a positive amount, and that the amount not exceed the
 * deposited balance; on success invalidates `['earn']` and `['margin']`.
 */
export const useWithdraw = () => {
  const qc = useQueryClient();
  const address = useUserStore((state) => state.address);
  const depositedBalances = useUserStore((state) => state.depositedBalances);

  return useMutation({
    mutationFn: async ({ amount, assetType }: { amount: number; assetType: AssetType }) => {
      if (!address) throw new Error('Please connect your wallet first');
      if (!amount || amount <= 0) throw new Error('Please enter a valid amount');

      const depositedAmount = parseFloat(depositedBalances[assetType] || '0');
      if (amount > depositedAmount) {
        throw new Error('Cannot withdraw more than deposited balance');
      }

      const result = await ContractService.withdraw(address, amount, assetType);
      if (!result.success) {
        throw new Error(result.error || 'Withdrawal failed');
      }
      return { hash: result.hash, amount, assetType };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['earn'] });
      qc.invalidateQueries({ queryKey: ['margin'] });
    },
  });
};
