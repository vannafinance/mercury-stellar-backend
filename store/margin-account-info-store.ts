import createNewStore from "@/zustand/index";
import { MarginAccountService, type MarginAccount } from "@/lib/margin-utils";
import { computeMarginSnapshot } from "@/lib/account-snapshot";
// ────────────────────────────────────────────────────────────────────
// Rate-limiting / request-dedup gates.
// Goal: prevent StrictMode double-fire, rapid remounts, and concurrent
// refresh calls from hammering the blockchain.
// ────────────────────────────────────────────────────────────────────
const MIN_FETCH_INTERVAL_MS = 3_000;
const CACHE_DURATION_MS = 5_000;

const lastCheckByUser = new Map<string, number>();
const inflightCheckByUser = new Map<string, Promise<void>>();

const lastRefreshByAccount = new Map<string, number>();
const inflightRefreshByAccount = new Map<string, Promise<void>>();

// D25: when a mutation force-refreshes the store directly (authoritative client
// read), pause the cached /api/account snapshot from feeding the store for a
// window just past the route's 15s edge TTL — otherwise the still-cached
// (pre-mutation) snapshot could clobber the fresh post-mutation values. After
// the window the edge cache has caught up, so the snapshot feed resumes safely.
let snapshotFeedSuppressedUntil = 0;
export const suppressSnapshotFeed = (ms = 20_000) => {
  snapshotFeedSuppressedUntil = Date.now() + ms;
};
export const isSnapshotFeedSuppressed = () => Date.now() < snapshotFeedSuppressedUntil;

const canonicalMarginToken = (token: string): string => {
  const normalized = token.toUpperCase();
  if (normalized === 'BLEND_USDC' || normalized === 'USDC') return 'BLUSDC';
  if (normalized === 'AQUIRESUSDC' || normalized === 'AQUARIUS_USDC') return 'AQUSDC';
  if (normalized === 'SOROSWAPUSDC' || normalized === 'SOROSWAP_USDC') return 'SOUSDC';
  return normalized;
};

// Types
export interface BorrowedBalance {
  amount: string;
  usdValue: string;
}

export interface MarginAccountInfoStateType {
  totalBorrowedValue: number;
  totalCollateralValue: number;
  grossCollateralValue: number;
  totalValue: number;
  avgHealthFactor: number;
  collateralLeftBeforeLiquidation: number;
  netAvailableCollateral: number;
  timeToLiquidation: number;
  borrowRate: number;
  liquidationPremium: number;
  liquidationFee: number;
  debtLimit: number;
  minDebt: number;
  maxDebt: number;
  hasMarginAccount: boolean;
  marginAccountAddress: string | null;
  isCreatingAccount: boolean;
  accountCreationError: string | null;
  borrowedBalances: Record<string, BorrowedBalance>;
  collateralBalances: Record<string, BorrowedBalance>;
  isLoadingBorrowedBalances: boolean;
}

// Initial State
const initialState: MarginAccountInfoStateType = {
  totalBorrowedValue: 0,
  totalCollateralValue: 0,
  grossCollateralValue: 0,
  totalValue: 0,
  avgHealthFactor: 0,
  collateralLeftBeforeLiquidation: 0,
  netAvailableCollateral: 0,
  timeToLiquidation: 0,
  borrowRate: 0,
  liquidationPremium: 0,
  liquidationFee: 0,
  debtLimit: 0,
  minDebt: 0,
  maxDebt: 0,
  hasMarginAccount: false,
  marginAccountAddress: null,
  isCreatingAccount: false,
  accountCreationError: null,
  borrowedBalances: {},
  collateralBalances: {},
  isLoadingBorrowedBalances: false,
};

// Export Store
//
// NOT persisted. The account identity has a single cache — MarginAccountService's
// wallet-keyed, AccountManager-guarded localStorage (STORAGE_KEY). On reload,
// checkUserMarginAccount reads that cache synchronously for an instant paint, then
// reconciles against on-chain discovery (the source of truth). Persisting identity
// here too was a second, wallet-agnostic cache that could rehydrate the previously
// connected wallet's account and disagree with the chain. Balances are never
// persisted (they bled across accounts on reload) — they always come fresh.
export const useMarginAccountInfoStore = createNewStore(initialState, {
  name: "margin-account-info-store",
  devTools: true,
});

// Action functions
export const setMarginAccount = (account: MarginAccount) => {
  useMarginAccountInfoStore.getState().set({
    hasMarginAccount: true,
    marginAccountAddress: account.address,
    accountCreationError: null,
    // Reset creation-loading flag on success — without this the button stays
    // stuck on "Creating Account..." and the next open-position attempt is
    // blocked. (setAccountCreationError already resets it on the error path.)
    isCreatingAccount: false,
    // A freshly created account is empty on-chain. Clear any balances left over
    // from a previously-loaded account so they don't bleed into the new one
    // during the window before refreshBorrowedBalances lands.
    ...STALE_BALANCE_RESET,
  });
};

// Balance/derived fields to wipe when a DIFFERENT wallet's margin account is
// resolved, so persisted (stale-while-revalidate) balances from a prior session
// can't bleed into the newly connected wallet before its refresh lands.
const STALE_BALANCE_RESET = {
  borrowedBalances: {},
  collateralBalances: {},
  totalBorrowedValue: 0,
  totalCollateralValue: 0,
  totalValue: 0,
  grossCollateralValue: 0,
  netAvailableCollateral: 0,
  collateralLeftBeforeLiquidation: 0,
  avgHealthFactor: 0,
} as const;

// Set the resolved margin account; if it differs from what's currently stored
// (e.g. a different wallet connected), drop the stale persisted balances.
const applyResolvedMarginAccount = (address: string | null) => {
  const prev = useMarginAccountInfoStore.getState().marginAccountAddress;
  useMarginAccountInfoStore.getState().set({
    hasMarginAccount: true,
    marginAccountAddress: address,
    ...(address !== prev ? STALE_BALANCE_RESET : {}),
  });
};

export const clearMarginAccount = () => {
  useMarginAccountInfoStore.getState().set({
    hasMarginAccount: false,
    marginAccountAddress: null,
    accountCreationError: null,
    totalBorrowedValue: 0,
    totalCollateralValue: 0,
    totalValue: 0,
    avgHealthFactor: 0,
    collateralLeftBeforeLiquidation: 0,
    netAvailableCollateral: 0,
    timeToLiquidation: 0,
    borrowRate: 0,
    liquidationPremium: 0,
    liquidationFee: 0,
    debtLimit: 0,
    minDebt: 0,
    maxDebt: 0,
    borrowedBalances: {},
    collateralBalances: {},
    isLoadingBorrowedBalances: false,
  });
  // Drop ALL rate-limit caches so a disconnect → reconnect refetches
  // from scratch. Two pairs exist:
  //   • lastCheckByUser / inflightCheckByUser  → checkUserMarginAccount()
  //   • lastRefreshByAccount / inflightRefreshByAccount → refreshBorrowedBalances()
  // Without clearing the second pair, the margin address gets re-detected on
  // reconnect but balance/HF stays at $0 because refreshBorrowedBalances
  // short-circuits on the stale CACHE_DURATION_MS hit.
  lastCheckByUser.clear();
  inflightCheckByUser.clear();
  lastRefreshByAccount.clear();
  inflightRefreshByAccount.clear();
};

export const setAccountCreationLoading = (loading: boolean) => {
  useMarginAccountInfoStore.getState().set({
    isCreatingAccount: loading,
    accountCreationError: loading ? null : useMarginAccountInfoStore.getState().accountCreationError,
  });
};

export const setAccountCreationError = (error: string | null) => {
  useMarginAccountInfoStore.getState().set({
    accountCreationError: error,
    isCreatingAccount: false,
  });
};

// Add deposit and borrow action
export const depositAndBorrow = async (
  userAddress: string, 
  depositAmount: number, 
  multiplier: number, 
  tokenSymbol: string = 'XLM'
): Promise<{ success: boolean; hash?: string; error?: string }> => {
  try {
    const normalizedTokenSymbol = canonicalMarginToken(tokenSymbol);

    // Get current margin account
    const account = MarginAccountService.getStoredMarginAccount(userAddress);
    if (!account || !account.isActive) {
      return {
        success: false,
        error: 'No active margin account found'
      };
    }

    // Execute deposit and borrow
    const result = await MarginAccountService.depositAndBorrow(
      account.address,
      depositAmount,
      multiplier,
      normalizedTokenSymbol
    );

    // Refresh borrowed balances after successful deposit (even if borrow fails, deposit might still succeed)
    if (result.success || result.error?.includes('Deposit was successful')) {
      await refreshBorrowedBalances(account.address, true);
    }

    return result;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
};

// Add standalone borrow function
export const borrowTokens = async (
  userAddress: string,
  tokenSymbol: string,
  borrowAmount: number
): Promise<{ success: boolean; hash?: string; error?: string }> => {
  try {
    const normalizedTokenSymbol = canonicalMarginToken(tokenSymbol);


    // Get current margin account
    const account = MarginAccountService.getStoredMarginAccount(userAddress);
    if (!account || !account.isActive) {
      console.error('❌ No active margin account found');
      return {
        success: false,
        error: 'No active margin account found. Please create a margin account first.'
      };
    }


    // Convert borrow amount to WAD (18 decimals). Splitting the multiplication
    // through BigInt avoids the JS Number `toString()` falling back to
    // scientific notation for large values (e.g. 3431.79 * 1e18 prints as
    // '3.43e+21'), which downstream `BigInt(...)` parsing rejects.
    const borrowAmountWad = (
      BigInt(Math.floor(borrowAmount * 1_000_000)) * BigInt(1_000_000_000_000)
    ).toString();

    // Update loading state
    useMarginAccountInfoStore.getState().set({ 
      isLoadingBorrowedBalances: true 
    });

    // Execute borrow operation
    const result = await MarginAccountService.borrowTokens(
      account.address,
      normalizedTokenSymbol,
      borrowAmountWad
    );


    // Always refresh borrowed balances after operation (success or failure)
    try {
      await refreshBorrowedBalances(account.address, true);
    } catch (refreshError) {
      console.warn('⚠️ Failed to refresh borrowed balances:', refreshError);
    }

    // Update loading state
    useMarginAccountInfoStore.getState().set({ 
      isLoadingBorrowedBalances: false 
    });

    return result;
  } catch (error) {
    console.error('💥 Error in borrowTokens store function:', error);
    
    // Make sure to reset loading state
    useMarginAccountInfoStore.getState().set({ 
      isLoadingBorrowedBalances: false 
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
};

// Add contract setup action (for admin/testing purposes)
export const setupContractConfiguration = async (): Promise<{ success: boolean; error?: string }> => {
  try {
    const result = await MarginAccountService.setupContractConfiguration();
    return result;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
};

export const checkUserMarginAccount = async (
  userAddress: string,
  forceRefresh = false,
): Promise<void> => {
  // Dedup concurrent calls for the same user.
  const existing = inflightCheckByUser.get(userAddress);
  if (existing) return existing;

  // Respect cache TTL unless caller asks for a force refresh.
  const last = lastCheckByUser.get(userAddress) ?? 0;
  const age = Date.now() - last;
  if (!forceRefresh && age < CACHE_DURATION_MS) {
    return;
  }
  if (!forceRefresh && age < MIN_FETCH_INTERVAL_MS) {
    return;
  }

  const run = (async () => {
    try {

      // Step 1: localStorage gives an instant first paint, but it is only a
      // hint — a stale entry must never pin an old account. So we apply the
      // cached address for speed, then ALWAYS reconcile against the chain.
      const accountInfo = MarginAccountService.getMarginAccountInfo(userAddress);
      const cachedAddress = accountInfo.hasAccount ? accountInfo.accountAddress ?? null : null;
      if (cachedAddress) {
        applyResolvedMarginAccount(cachedAddress);
      }

      // Step 2: on-chain discovery is authoritative — it resolves the NEWEST
      // active account (see getMarginAccountFromRegistry). Adopt it even when a
      // cached account exists, so the cache can't keep showing an older one.
      try {
        const blockchainAccount = await MarginAccountService.discoverExistingAccount(userAddress);

        if (blockchainAccount) {
          applyResolvedMarginAccount(blockchainAccount);
        } else if (!cachedAddress) {
          // Chain has no active account and nothing was cached → none exists.
          clearMarginAccount();
        }
        // If discovery returns null but we had a cached account, keep the cached
        // one rather than wiping the section on a single empty/failed lookup.
      } catch (blockchainError) {
        console.error('❌ Error checking blockchain for existing account:', blockchainError);
        if (!cachedAddress) clearMarginAccount();
      }
    } catch (error) {
      console.error('❌ Error in checkUserMarginAccount:', error);
      clearMarginAccount();
    } finally {
      lastCheckByUser.set(userAddress, Date.now());
      inflightCheckByUser.delete(userAddress);
    }
  })();

  inflightCheckByUser.set(userAddress, run);
  return run;
};

export const createMarginAccount = async (userAddress: string): Promise<boolean> => {
  try {
    setAccountCreationLoading(true);
    
    const result = await MarginAccountService.createMarginAccount(userAddress);
    
    if (result.success && result.marginAccountAddress) {
      const marginAccount: MarginAccount = {
        address: result.marginAccountAddress,
        owner: userAddress,
        isActive: true,
        createdAt: Date.now()
      };
      
      setMarginAccount(marginAccount);
      return true;
    } else {
      setAccountCreationError(result.error || 'Failed to create margin account');
      return false;
    }
  } catch (error: any) {
    setAccountCreationError(error?.message || 'Failed to create margin account');
    return false;
  }
};

export const updateAccountData = (data: Partial<MarginAccountInfoStateType>) => {
  useMarginAccountInfoStore.getState().set(data);
};

export const refreshBorrowedBalances = async (
  marginAccountAddress: string,
  forceRefresh = false,
): Promise<void> => {
  if (!marginAccountAddress || typeof marginAccountAddress !== 'string' || marginAccountAddress.length < 10) {
    console.warn('⚠️ Invalid margin account address, skipping balance refresh');
    return;
  }

  // Dedup concurrent refresh calls for the same account.
  const existing = inflightRefreshByAccount.get(marginAccountAddress);
  if (existing) return existing;

  // Respect cache TTL unless caller asks for a force refresh.
  const last = lastRefreshByAccount.get(marginAccountAddress) ?? 0;
  const age = Date.now() - last;
  if (!forceRefresh && age < CACHE_DURATION_MS) return;
  if (!forceRefresh && age < MIN_FETCH_INTERVAL_MS) return;

  // A forced refresh means a mutation just changed state — protect the result
  // from the lagging cached snapshot for one TTL window.
  if (forceRefresh) suppressSnapshotFeed();

  const run = (async () => {
  try {
    useMarginAccountInfoStore.getState().set({ isLoadingBorrowedBalances: true });

    // Single source of truth for the HF / collateral / borrowed / net math —
    // shared with the cached /api/account route (lib/account-snapshot.ts) so the
    // mutation/fallback path and the server route can never diverge. onPartial
    // publishes the fast debt/balances first (progressive render); the heavier
    // farm/SAC/borrow-rate work resolves concurrently and lands in the final set.
    const snap = await computeMarginSnapshot(marginAccountAddress, {
      onPartial: (p) => {
        useMarginAccountInfoStore.getState().set({
          borrowedBalances: { ...p.borrowedBalances },
          collateralBalances: { ...p.collateralBalances },
          totalBorrowedValue: p.totalBorrowedValue,
          isLoadingBorrowedBalances: false,
        });
      },
    });

    useMarginAccountInfoStore.getState().set({
      borrowedBalances: snap.borrowedBalances,
      collateralBalances: snap.collateralBalances,
      totalBorrowedValue: snap.totalBorrowedValue,
      totalCollateralValue: snap.totalCollateralValue,
      grossCollateralValue: snap.grossCollateralValue,
      totalValue: snap.totalValue,
      avgHealthFactor: snap.avgHealthFactor,
      collateralLeftBeforeLiquidation: snap.collateralLeftBeforeLiquidation,
      netAvailableCollateral: snap.netAvailableCollateral,
      timeToLiquidation: 0,
      borrowRate: snap.borrowRate,
      debtLimit: snap.debtLimit,
      minDebt: 0,
      maxDebt: snap.debtLimit,
      isLoadingBorrowedBalances: false,
    });
  } catch (error: any) {
    console.error('❌ Error refreshing balances:', error);
    useMarginAccountInfoStore.getState().set({ isLoadingBorrowedBalances: false });
  } finally {
    lastRefreshByAccount.set(marginAccountAddress, Date.now());
    inflightRefreshByAccount.delete(marginAccountAddress);
  }
  })();

  inflightRefreshByAccount.set(marginAccountAddress, run);
  return run;
};

export const resetToInitialState = () => {
  useMarginAccountInfoStore.getState().reset();
};

export const resetCreationState = () => {
  useMarginAccountInfoStore.getState().set({
    isCreatingAccount: false,
    accountCreationError: null,
  });
};
