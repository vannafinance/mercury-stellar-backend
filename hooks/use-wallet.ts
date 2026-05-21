import { useState, useEffect, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { WalletService, ContractService, AssetType, ASSET_TYPES } from '@/lib/stellar-utils';
import { useUserStore } from '@/store/user';
import { clearMarginAccount } from '@/store/margin-account-info-store';

export const useWallet = () => {
  const address = useUserStore((state) => state.address);
  const isConnected = useUserStore((state) => state.isConnected);
  const balance = useUserStore((state) => state.balance);
  const depositedBalances = useUserStore((state) => state.depositedBalances);
  const isLoadingStore = useUserStore((state) => state.isLoading);
  
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info' | '', text: string }>({ type: '', text: '' });

  // Force reset loading state on mount to fix stuck "Connecting..." state
  useEffect(() => {
    console.log('[useWallet] Initializing, resetting loading state', { address, isLoadingStore, isLoading });
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
        const [xlmDeposited, usdcDeposited, aquariusUsdcDeposited, soroswapUsdcDeposited] = await Promise.race([
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
      console.error('Error refreshing balances:', error);
      // Don't throw - just log the error so connection isn't blocked
    }
  }, [address]);

  const checkConnection = useCallback(async () => {
    // Don't auto-reconnect if user manually disconnected
    const { manuallyDisconnected } = useUserStore.getState();
    if (manuallyDisconnected) {
      return;
    }
    
    try {
      const { address: walletAddress, connected } = await WalletService.checkConnection();
      if (connected && walletAddress) {
        useUserStore.getState().set({
          address: walletAddress,
          isConnected: connected,
          isLoading: false,
        });
        await refreshBalances(walletAddress);
      } else {
        useUserStore.getState().set({
          address: null,
          isConnected: false,
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

  const connectWallet = useCallback(async () => {
    try {
      setIsLoading(true);
      useUserStore.getState().set({ isLoading: true, manuallyDisconnected: false });
      
      console.log('Starting wallet connection...');
      const result = await WalletService.connectWallet();
      
      if (result.success) {
        console.log('Wallet connected successfully:', result.address);
        
        // Set address and connected state immediately - don't wait for balance refresh
        useUserStore.getState().set({
          address: result.address,
          isConnected: true,
          manuallyDisconnected: false,
        });
        
        // Refresh balances asynchronously with timeout to prevent hanging
        console.log('Refreshing balances asynchronously...');
        refreshBalances(result.address).catch((error) => {
          console.error('Error refreshing balances after connection:', error);
        });
        
        setMessage({ type: 'success', text: 'Wallet connected successfully!' });
      } else {
        console.error('Wallet connection failed:', result.error);
        setMessage({ type: 'error', text: result.error || 'Failed to connect wallet' });
      }
    } catch (error: any) {
      console.error('Wallet connection error:', error);
      setMessage({ type: 'error', text: error?.message || 'Failed to connect wallet' });
    } finally {
      setIsLoading(false);
      useUserStore.getState().set({ isLoading: false });
    }
  }, [refreshBalances]);

  const disconnectWallet = useCallback(() => {
    console.log('Disconnecting wallet (keeping margin account data in localStorage)');

    // Don't clear localStorage - margin accounts should persist across wallet
    // connections (the address-stored mapping is keyed by user pubkey).
    // But DO reset in-memory state so the UI doesn't keep showing the
    // previous wallet's totals (HF, collateral, debt, etc.) after disconnect.
    useUserStore.getState().set({
      address: null,
      isConnected: false,
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
    setMessage({ type: 'info', text: 'Wallet disconnected' });
  }, []);

  return {
    // State
    address,
    isConnected,
    balance,
    depositedBalances,
    isLoading: isLoading || isLoadingStore,
    message,
    
    // Actions
    connectWallet,
    disconnectWallet,
    refreshBalances,
    clearMessage: () => setMessage({ type: '', text: '' }),
  };
};

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
