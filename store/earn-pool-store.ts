import createNewStore from "@/zustand/index";

// Pool Data Types
export interface PoolStats {
  totalSupply: string;
  totalBorrowed: string;
  availableLiquidity: string;
  utilizationRate: string;
  supplyAPY: string;
  borrowAPY: string;
  vTokenSupply: string;
  exchangeRate: string; // vToken to underlying ratio
}

export interface UserPoolPosition {
  deposited: string;          // Amount deposited (underlying asset)
  vTokenBalance: string;      // vToken balance
  borrowed: string;           // Amount borrowed
  borrowShares: string;       // Borrow shares
  earnedInterest: string;     // Interest earned
  accruedDebt: string;        // Debt accrued from borrowing
}

export interface EarnPoolState {
  // Pool Statistics
  pools: {
    XLM: PoolStats;
    USDC: PoolStats;
    AQUARIUS_USDC: PoolStats;
    SOROSWAP_USDC: PoolStats;
  };

  // User Positions
  userPositions: {
    XLM: UserPoolPosition;
    USDC: UserPoolPosition;
    AQUARIUS_USDC: UserPoolPosition;
    SOROSWAP_USDC: UserPoolPosition;
  };
  
  // Transaction History
  recentTransactions: {
    type: 'deposit' | 'withdraw' | 'borrow' | 'repay' | 'supply';
    asset: string;
    amount: string;
    timestamp: number;
    hash: string;
    status: 'success' | 'pending' | 'failed';
  }[];
  
  // Loading states
  isLoadingPools: boolean;
  isLoadingPositions: boolean;
  lastUpdated: number | null;
  
  // Selected pool for detail view
  selectedPool: string | null;
}

// Default pool stats
const defaultPoolStats: PoolStats = {
  totalSupply: '0',
  totalBorrowed: '0',
  availableLiquidity: '0',
  utilizationRate: '0',
  supplyAPY: '0',
  borrowAPY: '0',
  vTokenSupply: '0',
  exchangeRate: '1',
};

// Default user position
const defaultUserPosition: UserPoolPosition = {
  deposited: '0',
  vTokenBalance: '0',
  borrowed: '0',
  borrowShares: '0',
  earnedInterest: '0',
  accruedDebt: '0',
};

// Initial State
const initialState: EarnPoolState = {
  pools: {
    XLM: { ...defaultPoolStats },
    USDC: { ...defaultPoolStats },
    AQUARIUS_USDC: { ...defaultPoolStats },
    SOROSWAP_USDC: { ...defaultPoolStats },
  },
  userPositions: {
    XLM: { ...defaultUserPosition },
    USDC: { ...defaultUserPosition },
    AQUARIUS_USDC: { ...defaultUserPosition },
    SOROSWAP_USDC: { ...defaultUserPosition },
  },
  recentTransactions: [],
  isLoadingPools: false,
  isLoadingPositions: false,
  lastUpdated: null,
  selectedPool: null,
};

// Export Store
export const useEarnPoolStore = createNewStore(initialState, {
  name: "earn-pool-store",
  devTools: true,
  persist: false, // Don't persist - refresh from chain
});

// Helper functions
export const addTransaction = (
  type: 'deposit' | 'withdraw' | 'borrow' | 'repay' | 'supply',
  asset: string,
  amount: string,
  hash: string,
  status: 'success' | 'pending' | 'failed' = 'success'
) => {
  const { recentTransactions } = useEarnPoolStore.getState();
  const newTransaction = {
    type,
    asset,
    amount,
    timestamp: Date.now(),
    hash,
    status,
  };
  
  // Keep only last 20 transactions
  const updatedTransactions = [newTransaction, ...recentTransactions].slice(0, 20);
  useEarnPoolStore.getState().set({ recentTransactions: updatedTransactions });
};

// Calculate derived values
export const calculateUserTotalDeposited = (): string => {
  const { userPositions } = useEarnPoolStore.getState();
  const xlmValue = parseFloat(userPositions.XLM.deposited) || 0;
  const usdcValue = parseFloat(userPositions.USDC.deposited) || 0;
  const aquiresUsdcValue = parseFloat(userPositions.AQUARIUS_USDC.deposited) || 0;
  const soroswapUsdcValue = parseFloat(userPositions.SOROSWAP_USDC.deposited) || 0;

  return (xlmValue + usdcValue + aquiresUsdcValue + soroswapUsdcValue).toFixed(2);
};

export const calculateUserTotalBorrowed = (): string => {
  const { userPositions } = useEarnPoolStore.getState();
  const xlmValue = parseFloat(userPositions.XLM.borrowed) || 0;
  const usdcValue = parseFloat(userPositions.USDC.borrowed) || 0;
  const aquiresUsdcValue = parseFloat(userPositions.AQUARIUS_USDC.borrowed) || 0;
  const soroswapUsdcValue = parseFloat(userPositions.SOROSWAP_USDC.borrowed) || 0;

  return (xlmValue + usdcValue + aquiresUsdcValue + soroswapUsdcValue).toFixed(2);
};
