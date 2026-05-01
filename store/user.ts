import createNewStore from "@/zustand/index"

// Types
export interface User {
  address: string | null;
  isConnected: boolean;
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
export const useUserStore = createNewStore(initialState, {
  name: "user-store",
  devTools: true,
  persist: {
    name: "user-store",
    version: 1,
    migrate: (persistedState: any, version: number) => {
      // Always reset isLoading to false on load to prevent stuck "Connecting..." state
      return {
        ...persistedState,
        isLoading: false,
      };
    },
  },
});

