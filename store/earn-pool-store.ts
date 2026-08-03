import createNewStore from "@/zustand/index";

// Earn-page store: lending-pool statistics, the connected user's per-pool
// positions, and a short recent-transaction log. Written by the React Query
// earn hooks (dual-write) and read by components that consume the store directly.

// Pool Data Types
/** Per-pool market statistics (supply/borrow totals, APYs, vToken exchange rate). All values are decimal strings. */
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

/** The connected user's position in a single pool. All values are decimal strings. */
export interface UserPoolPosition {
  deposited: string;          // Amount deposited (underlying asset)
  vTokenBalance: string;      // vToken balance
  borrowed: string;           // Amount borrowed
  borrowShares: string;       // Borrow shares
  earnedInterest: string;     // Interest earned
  accruedDebt: string;        // Debt accrued from borrowing
}

/** Full earn-store slice: per-pool stats, per-pool user positions, recent tx log, loading flags, and the selected pool. */
export interface EarnPoolState {
  // Pool Statistics
  pools: {
    XLM: PoolStats;
    USDC: PoolStats;
  };

  // User Positions
  userPositions: {
    XLM: UserPoolPosition;
    USDC: UserPoolPosition;
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
  },
  userPositions: {
    XLM: { ...defaultUserPosition },
    USDC: { ...defaultUserPosition },
  },
  recentTransactions: [],
  isLoadingPools: false,
  isLoadingPositions: false,
  lastUpdated: null,
  selectedPool: null,
};

// Export Store
//
// NOT persisted — pool stats and positions are always refreshed from chain so a
// reload never shows stale numbers.
export const useEarnPoolStore = createNewStore(initialState, {
  name: "earn-pool-store",
  devTools: true,
  persist: false, // Don't persist - refresh from chain
});

// Helper functions
/**
 * Prepends a transaction to `recentTransactions`, capping the log at 20 entries.
 * `timestamp` is set to now. Call after a supply/withdraw/borrow/repay confirms.
 */
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
/** Sums the user's deposited amounts across all pools; returns a 2-dp decimal string. */
export const calculateUserTotalDeposited = (): string => {
  const { userPositions } = useEarnPoolStore.getState();
  const total = (Object.values(userPositions) as UserPoolPosition[]).reduce(
    (sum, p) => sum + (parseFloat(p.deposited) || 0),
    0,
  );
  return total.toFixed(2);
};

/** Sums the user's borrowed amounts across all pools; returns a 2-dp decimal string. */
export const calculateUserTotalBorrowed = (): string => {
  const { userPositions } = useEarnPoolStore.getState();
  const total = (Object.values(userPositions) as UserPoolPosition[]).reduce(
    (sum, p) => sum + (parseFloat(p.borrowed) || 0),
    0,
  );
  return total.toFixed(2);
};
