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
  // Human-readable label for a Privy-embedded wallet's underlying login method
  // (e.g. "Google Wallet", "Apple Wallet") — derived from Privy's linkedAccounts,
  // so the navbar can show what the user actually signed in with instead of the
  // generic "Privy Wallet". Null for Freighter, or before Privy resolves it.
  walletProviderLabel: string | null;
  balance: string; // Native XLM balance
  tokenBalances: {
    XLM: string;
    USDC: string;
    BLEND_USDC: string;
    AQUARIUS_USDC: string;
    SOROSWAP_USDC: string;
  };
  depositedBalances: {
    XLM: string;
    USDC: string;
    AQUARIUS_USDC: string;
    SOROSWAP_USDC: string;
  };
  isLoading: boolean;
  manuallyDisconnected: boolean; // Track if user manually disconnected
}

// Initial State
const initialState: User = {
  address: null,
  isConnected: false,
  walletKind: null,
  walletProviderLabel: null,
  balance: '0',
  tokenBalances: {
    XLM: '0',
    USDC: '0',
    BLEND_USDC: '0',
    AQUARIUS_USDC: '0',
    SOROSWAP_USDC: '0',
  },
  depositedBalances: {
    XLM: '0',
    USDC: '0',
    AQUARIUS_USDC: '0',
    SOROSWAP_USDC: '0',
  },
  isLoading: false,
  manuallyDisconnected: false,
};

// Export Store
//
// Financial and wallet state is intentionally memory-only. Freighter/Privy are
// authoritative for connection state and every balance is re-read on-chain;
// persisting these values caused stale balances to appear after reloads.
export const useUserStore = createNewStore(initialState, {
  name: "user-store",
  devTools: true,
});
