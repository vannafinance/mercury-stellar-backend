import createNewStore from "@/zustand/index"

// Connected-wallet store: connection status, native XLM balance, per-token wallet
// balances, and per-pool deposited balances. The single source of truth for "who
// is connected" across the app; written by the wallet hooks.

// Types
/** Connected-wallet slice: address/connection flags plus wallet and deposited balances (decimal strings). */
export interface User {
  address: string | null;
  isConnected: boolean;
  walletKind: 'freighter' | 'privy' | null;
  balance: string; // Native XLM balance
  tokenBalances: {
    XLM: string;
    USDC: string;
  };
  depositedBalances: {
    XLM: string;
    USDC: string;
  };
  isLoading: boolean;
  manuallyDisconnected: boolean; // Track if user manually disconnected
}

// Initial State
const initialState: User = {
  address: null,
  isConnected: false,
  walletKind: null,
  balance: '0',
  tokenBalances: {
    XLM: '0',
    USDC: '0',
  },
  depositedBalances: {
    XLM: '0',
    USDC: '0',
  },
  isLoading: false,
  manuallyDisconnected: false,
};

// Export Store
//
// Persisted (versioned) for an instant first paint of the last-connected wallet.
// The migrate fn always forces `isLoading` back to false on rehydrate so a
// reload mid-connect never leaves the UI stuck on "Connecting...".
export const useUserStore = createNewStore(initialState, {
  name: "user-store",
  devTools: true,
  persist: {
    name: "user-store",
    // v2: mainnet — strip testnet multi-USDC keys that survived deepmerge.
    version: 2,
    migrate: (persistedState: any, _version: number) => {
      const keep = (raw: Record<string, string> | undefined) => ({
        XLM: raw?.XLM ?? "0",
        USDC: raw?.USDC ?? "0",
      });
      return {
        ...persistedState,
        // Always reset isLoading so a reload mid-connect never sticks on "Connecting..."
        isLoading: false,
        tokenBalances: keep(persistedState?.tokenBalances),
        depositedBalances: keep(persistedState?.depositedBalances),
      };
    },
  },
});

