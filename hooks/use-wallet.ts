import { useState, useEffect, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { normalizeContractError } from '@/lib/errors/normalize';
import { WalletService, ContractService, AssetType, ASSET_TYPES } from '@/lib/stellar-utils';
import { setActiveWalletKind, getPrivyAuthControls, startPrivyConnect, type WalletKind } from '@/lib/wallet-adapter';
import { hasUnexpiredPrivySession } from '@/lib/privy-session';
import { useUserStore } from '@/store/user';
import { clearMarginAccount } from '@/store/margin-account-info-store';
import { useLedgerTick } from '@/contexts/ledger-subscriber';

const walletRefreshes = new Map<string, Promise<void>>();
const depositedRefreshes = new Map<string, Promise<void>>();

const withTimeout = <T,>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), ms),
    ),
  ]);

/**
 * Refresh the connected wallet from Horizon/Soroban with cross-component
 * in-flight deduplication. Wallet values are committed only after a real
 * network read; failures preserve the last verified in-memory values.
 */
export const refreshWalletBalancesOnChain = (targetAddress: string): Promise<void> => {
  const existing = walletRefreshes.get(targetAddress);
  if (existing) return existing;

  const run = (async () => {
    const tokenBalances = await withTimeout(
      ContractService.getAllTokenBalances(targetAddress),
      12_000,
      'Wallet balance refresh',
    );
    useUserStore.getState().set({
      balance: tokenBalances.XLM,
      tokenBalances,
    });

    // Receipt balances are secondary. Paint wallet balances first, then start
    // one de-duplicated background batch so ledger ticks cannot pile up RPCs.
    if (!depositedRefreshes.has(targetAddress)) {
      const depositedRun = withTimeout(
        Promise.all([
          ContractService.getDepositedBalance(targetAddress, ASSET_TYPES.XLM),
          ContractService.getDepositedBalance(targetAddress, ASSET_TYPES.USDC),
          ContractService.getDepositedBalance(targetAddress, ASSET_TYPES.AQUARIUS_USDC),
          ContractService.getDepositedBalance(targetAddress, ASSET_TYPES.SOROSWAP_USDC),
        ]),
        12_000,
        'Deposited balance refresh',
      ).then(([XLM, USDC, AQUARIUS_USDC, SOROSWAP_USDC]) => {
        useUserStore.getState().set({
          depositedBalances: { XLM, USDC, AQUARIUS_USDC, SOROSWAP_USDC },
        });
      }).catch((error) => {
        console.warn('Deposited balances refresh failed; wallet balances remain current:', error);
      }).finally(() => {
        depositedRefreshes.delete(targetAddress);
      });
      depositedRefreshes.set(targetAddress, depositedRun);
    }
  })().finally(() => {
    walletRefreshes.delete(targetAddress);
  });

  walletRefreshes.set(targetAddress, run);
  return run;
};

/**
 * Wallet connection lifecycle and balances, backed by `useUserStore`.
 *
 * Auto-checks the connection on mount and window focus (unless the user manually
 * disconnected), refreshes wallet + per-pool deposited balances (each guarded by
 * a 15s timeout so a stalled RPC never blocks the UI), and exposes connect/
 * disconnect actions. Disconnect resets in-memory state and clears the cached
 * margin-account stats (via `clearMarginAccount`). The account is rediscovered
 * from AccountManager storage on reconnect. Refresh failures are non-fatal.
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
  const privyReady = useUserStore((state) => state.privyReady);
  const privyAuthenticated = useUserStore((state) => state.privyAuthenticated);
  const walletService = useUserStore((state) => state.walletService);
  
  const [isLoading, setIsLoading] = useState(false);
  const { tick } = useLedgerTick();

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
      await refreshWalletBalancesOnChain(targetAddress);
    } catch (error) {
      // Non-fatal: a transient RPC/Horizon failure shouldn't block the wallet or
      // light up the dev error overlay — warn and let the next refresh recover.
      console.warn('Error refreshing balances (non-fatal, will retry):', error);
    }
  }, [address]);

  // Reconcile wallet balances on every closed ledger. The module-level
  // in-flight map deduplicates multiple useWallet consumers into one read.
  useEffect(() => {
    if (!tick || !address || !isConnected) return;
    refreshWalletBalancesOnChain(address).catch((error) => {
      console.warn('Ledger balance refresh failed; next ledger will retry:', error);
    });
  }, [tick, address, isConnected]);

  const checkConnection = useCallback(async () => {
    // Don't auto-reconnect if user manually disconnected
    const { manuallyDisconnected, walletKind } = useUserStore.getState();
    if (manuallyDisconnected) {
      return;
    }

    const privy = getPrivyAuthControls();
    const persisted = hasUnexpiredPrivySession();

    /**
     * A persisted Privy token outranks Freighter. Wiping `address` while that token is
     * still valid is the "Connect a wallet" false logout: Privy failed to fetch
     * auth.privy.io, `authenticated` stayed false, Freighter was not injected, and the
     * else-branch cleared the store. The session was never expired.
     */
    if (persisted && !privy?.authenticated) {
      setActiveWalletKind("privy");
      useUserStore.getState().set({
        walletKind: "privy",
        isLoading: false,
        walletService: "unreachable",
      });
      try { privy?.resync?.(); } catch { /* bridge still hydrating */ }
      return;
    }

    // A persisted Privy session rehydrates through Privy's own SDK state
    // (see PrivyWalletBridge). Mark the kind, then try an immediate resync so
    // the signing bridge is registered before the user hits Approve & sign.
    if (walletKind === 'privy' || privy?.authenticated) {
      setActiveWalletKind('privy');
      try {
        const controls = privy ?? getPrivyAuthControls();
        useUserStore.getState().set({
          walletKind: 'privy',
          isLoading: false,
          walletService: controls?.authenticated ? "ok" : useUserStore.getState().walletService,
        });
        if (controls?.resync?.()) return;
        // Bridge not ready yet — leave kind=privy; PrivyWalletBridge will fill it.
      } catch {
        /* ignore */
      }
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
          walletService: 'ok',
        });
        await refreshBalances(walletAddress);
      } else if (!hasUnexpiredPrivySession()) {
        useUserStore.getState().set({
          address: null,
          isConnected: false,
          walletKind: null,
          walletProviderLabel: null,
          balance: '0',
          tokenBalances: { XLM: '0', USDC: '0', BLEND_USDC: '0', AQUARIUS_USDC: '0', SOROSWAP_USDC: '0' },
          depositedBalances: { XLM: '0', USDC: '0', AQUARIUS_USDC: '0', SOROSWAP_USDC: '0' },
          isLoading: false,
          walletService: null,
        });
      }
    } catch (error) {
      console.error('Error checking connection:', error);
      useUserStore.getState().set({ isLoading: false });
    }
  }, [refreshBalances]);

  // Re-run when Privy finishes hydrating or recovers authentication — the mount
  // check is a snapshot, and wiping before that snapshot is the false logout.
  useEffect(() => {
    checkConnection();
    
    const handleFocus = () => checkConnection();
    window.addEventListener('focus', handleFocus);
    
    return () => window.removeEventListener('focus', handleFocus);
  }, [checkConnection, privyReady, privyAuthenticated]);

  const connectWallet = useCallback(async (kind: WalletKind = 'freighter') => {
    if (kind === 'privy') {
      // Opens Privy's login modal; PrivyWalletBridge reactively writes
      // address/isConnected/walletKind into the store once the user
      // authenticates and their Stellar embedded wallet is ready.
      // `login()` no-ops when a Privy session is already live — startPrivyConnect
      // resyncs in that case so the click is not a dead button.
      try {
        useUserStore.getState().set({ manuallyDisconnected: false });
        const result = startPrivyConnect();
        if (result === 'unavailable') {
          toast.error('Privy login is not available right now');
          return;
        }
        if (result === 'resync') {
          toast.success('Vanna wallet connected');
        } else if (result === 'pending-wallet') {
          toast('Signed in — creating your Vanna wallet…');
        }
      } catch (error: unknown) {
        console.error('Privy login failed:', error);
        const message = error instanceof Error ? error.message : undefined;
        toast.error(normalizeContractError(message, 'Failed to open Vanna wallet login'));
      }
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

    // Reset in-memory state so the UI doesn't keep showing the
    // previous wallet's totals (HF, collateral, debt, etc.) after disconnect.
    useUserStore.getState().set({
      address: null,
      isConnected: false,
      walletKind: null,
      walletProviderLabel: null,
      balance: '0',
      tokenBalances: { XLM: '0', USDC: '0', BLEND_USDC: '0', AQUARIUS_USDC: '0', SOROSWAP_USDC: '0' },
      depositedBalances: { XLM: '0', USDC: '0', AQUARIUS_USDC: '0', SOROSWAP_USDC: '0' },
      manuallyDisconnected: true, // Mark as manually disconnected to prevent auto-reconnect
      isLoading: false,
      walletService: null,
      privyAuthenticated: false,
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
    walletService,
    connectWallet,
    disconnectWallet,
    refreshBalances,
    retryWalletService: checkConnection,
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

      const depositedKey = assetType === ASSET_TYPES.BLEND_USDC ? ASSET_TYPES.USDC : assetType;
      const depositedAmount = parseFloat(depositedBalances[depositedKey] || '0');
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
