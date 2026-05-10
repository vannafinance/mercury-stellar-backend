import createNewStore from "@/zustand/index";
import { MarginAccountService, type MarginAccount } from "@/lib/margin-utils";
import { fetchTokenPrices, getCachedTokenPrice } from "@/lib/oracle-price";
import { ContractService, ASSET_TYPES, type AssetType } from "@/lib/stellar-utils";
import { computeBorrowApr } from "@/lib/utils/borrow-rate";

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

// Live token prices via the on-chain Reflector oracle. The cached helper
// returns the most recently fetched price (or a static fallback the very
// first time) so synchronous reducers stay synchronous; refresh paths await
// `fetchTokenPrices` to keep the cache warm before recomputing USD totals.
const PRICEABLE_TOKENS = ['XLM', 'USDC', 'BLUSDC', 'AQUSDC', 'SOUSDC'] as const;
const tokenPrice = (token: string): number => getCachedTokenPrice(token);

// Liquidation threshold from RiskEngine contract: BALANCE_TO_BORROW_THRESHOLD = 1.1 * WAD
// Account is liquidatable when: (totalCollateral / totalDebt) < 1.1
const LIQUIDATION_THRESHOLD = 1.1;
const HEALTH_FACTOR_INFINITY_SENTINEL = 999;
// Sub-cent residuals (interest dust, rounding remainders from a fully-repaid
// loan) shouldn't poison the HF / borrow-rate / time-to-liquidation displays
// by pretending the user still has real debt. A penny is a sane floor: below
// this we treat the position as having zero debt for UI calculations.
const USD_DUST_EPSILON = 0.01;

const canonicalMarginToken = (token: string): string => {
  const normalized = token.toUpperCase();
  if (normalized === 'BLEND_USDC' || normalized === 'USDC') return 'BLUSDC';
  if (normalized === 'AQUIRESUSDC' || normalized === 'AQUARIUS_USDC') return 'AQUSDC';
  if (normalized === 'SOROSWAPUSDC' || normalized === 'SOROSWAP_USDC') return 'SOUSDC';
  return normalized;
};

// Map a canonical debt symbol back to the lending pool's AssetType so we can
// fetch its on-chain utilization for borrow-rate computation.
const debtSymbolToAssetType = (symbol: string): AssetType | null => {
  switch (symbol.toUpperCase()) {
    case 'XLM': return ASSET_TYPES.XLM;
    case 'BLUSDC': return ASSET_TYPES.USDC;
    case 'AQUSDC': return ASSET_TYPES.AQUARIUS_USDC;
    case 'SOUSDC': return ASSET_TYPES.SOROSWAP_USDC;
    default: return null;
  }
};

// Types
export interface BorrowedBalance {
  amount: string;
  usdValue: string;
}

export interface MarginAccountInfoStateType {
  totalBorrowedValue: number;
  totalCollateralValue: number;
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
export const useMarginAccountInfoStore = createNewStore(initialState, {
  name: "margin-account-info-store",
  devTools: true,
  persist: {
    name: "margin-account-info-store",
    version: 3,
    migrate: (persistedState: any, _version: number) => {
      return {
        ...persistedState,
        isCreatingAccount: false,
        isLoadingBorrowedBalances: false,
        borrowedBalances: {},
        collateralBalances: {},
        totalBorrowedValue: 0,
        totalCollateralValue: 0,
        totalValue: 0,
        avgHealthFactor: 0,
      };
    },
    // Persist only the account identity. Balances and derived metrics must be
    // re-fetched from the chain on every load — otherwise a previous wallet's
    // residual entries (e.g. a 40 XLM borrow from a different test session)
    // bleed into a freshly connected wallet's UI until the async refresh lands.
    partialize: (state) => ({
      hasMarginAccount: state.hasMarginAccount,
      marginAccountAddress: state.marginAccountAddress,
    }),
  },
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
      await refreshBorrowedBalances(account.address);
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

    console.log('🏦 === MARGIN STORE: BORROW OPERATION ===');
    console.log('📊 Borrow parameters:', {
      userAddress,
      tokenSymbol: normalizedTokenSymbol,
      borrowAmount
    });

    // Get current margin account
    const account = MarginAccountService.getStoredMarginAccount(userAddress);
    if (!account || !account.isActive) {
      console.error('❌ No active margin account found');
      return {
        success: false,
        error: 'No active margin account found. Please create a margin account first.'
      };
    }

    console.log('✅ Found active margin account:', account.address);

    // Convert borrow amount to WAD (18 decimals)
    const borrowAmountWad = (borrowAmount * Math.pow(10, 18)).toString();
    console.log('🔢 Converting to WAD:', {
      originalAmount: borrowAmount,
      wadAmount: borrowAmountWad
    });

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

    console.log('📈 Borrow operation result:', result);

    // Always refresh borrowed balances after operation (success or failure)
    try {
      console.log('🔄 Refreshing borrowed balances...');
      await refreshBorrowedBalances(account.address);
      console.log('✅ Borrowed balances refreshed');
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
      console.log('🔍 Checking margin account for user:', userAddress);

      // Step 1: Check localStorage first (fastest)
      const accountInfo = MarginAccountService.getMarginAccountInfo(userAddress);

      if (accountInfo.hasAccount) {
        console.log('✅ Found margin account in localStorage:', accountInfo.accountAddress);
        useMarginAccountInfoStore.getState().set({
          hasMarginAccount: true,
          marginAccountAddress: accountInfo.accountAddress || null,
        });
        return;
      }

      // Step 2: No account in localStorage - check blockchain
      console.log('🌐 No account in localStorage, searching blockchain...');

      try {
        const blockchainAccount = await MarginAccountService.discoverExistingAccount(userAddress);

        if (blockchainAccount) {
          console.log('✅ Recovered margin account from blockchain:', blockchainAccount);
          useMarginAccountInfoStore.getState().set({
            hasMarginAccount: true,
            marginAccountAddress: blockchainAccount,
          });
        } else {
          console.log('❌ No margin account found - user needs to create one');
          clearMarginAccount();
        }
      } catch (blockchainError) {
        console.error('❌ Error checking blockchain for existing account:', blockchainError);
        clearMarginAccount();
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

  const run = (async () => {
  try {
    useMarginAccountInfoStore.getState().set({ isLoadingBorrowedBalances: true });

    // Fetch borrowed balances, collateral balances, and live oracle prices in
    // parallel. The oracle warm-up is what makes downstream `tokenPrice()`
    // calls return real-time values instead of static fallbacks.
    const [borrowedResult, collateralResult] = await Promise.all([
      MarginAccountService.getCurrentBorrowedBalances(marginAccountAddress),
      MarginAccountService.getCollateralBalances(marginAccountAddress),
      fetchTokenPrices([...PRICEABLE_TOKENS]),
    ]);

    let totalBorrowedValue = 0;
    let totalCollateralValue = 0;
    const borrowedBalances: Record<string, { amount: string; usdValue: string }> = {};
    const collateralBalances: Record<string, { amount: string; usdValue: string }> = {};

    // ── Borrowed totals ───────────────────────────────────────────────────────
    if (borrowedResult.success && borrowedResult.data) {
      const dedupedBorrowed: Record<string, { amount: string; usdValue: string }> = {};
      Object.entries(borrowedResult.data).forEach(([token, { amount, usdValue }]) => {
        const canonical = canonicalMarginToken(token);
        const current = dedupedBorrowed[canonical];
        if (!current || parseFloat(amount) > parseFloat(current.amount)) {
          dedupedBorrowed[canonical] = { amount, usdValue };
        }
      });

      Object.entries(dedupedBorrowed).forEach(([token, { amount }]) => {
        // Always recompute USD from the live oracle cache. The upstream
        // getCurrentBorrowedBalances sometimes returns a 1:1 placeholder
        // (token amount as USD) which would make XLM debt look 10× too big
        // and tank the displayed Health Factor / Net Available Collateral.
        const price = tokenPrice(token);
        const usd = parseFloat(amount) * price;
        totalBorrowedValue += usd;
        borrowedBalances[token] = { amount, usdValue: usd.toFixed(2) };
      });
    }

    // ── Collateral totals ─────────────────────────────────────────────────────
    if (collateralResult.success && collateralResult.data) {
      const dedupedCollateral: Record<string, string> = {};
      Object.entries(collateralResult.data).forEach(([token, { amount }]) => {
        const canonical = canonicalMarginToken(token);
        const current = dedupedCollateral[canonical];
        if (!current || parseFloat(amount) > parseFloat(current)) {
          dedupedCollateral[canonical] = amount;
        }
      });

      Object.entries(dedupedCollateral).forEach(([token, amount]) => {
        const price = tokenPrice(token);
        const tokenAmount = parseFloat(amount);
        const usd = tokenAmount * price;
        totalCollateralValue += usd;
        collateralBalances[token] = {
          amount,
          usdValue: usd.toFixed(2),
        };
      });
    }

    // ── Derived calculations (matching RiskEngine contract math) ──────────────
    //
    // Contract check is effectively:
    //   (totalCollateral / totalDebt) > 1.1    (when debt > 0)
    // We keep a finite sentinel for "infinite" HF to avoid giant unreadable UI numbers.
    const effectiveDebtValue =
      totalBorrowedValue > USD_DUST_EPSILON ? totalBorrowedValue : 0;

    // Borrowed funds physically live in the smart_account until they're
    // deployed elsewhere, so for solvency they're an asset on the balance
    // sheet. Mirror the contract's borrow-time check (risk_engine.rs:141-145):
    //   HF_check = (collateral + borrow_value) / (debt + borrow_value)
    // For ongoing display this becomes (collateral + debt) / debt — collateral
    // is the unencumbered deposit, +debt is the borrowed funds sitting in the
    // account. Without this, a 3x leverage position shows HF = 0.5 even though
    // the borrow check passed at 1.5, which is the number users expect to see.
    //
    // If the user has tracking-tokens (Blend deploy already happened), those
    // are already accounted for inside collateralBalances and we must NOT add
    // the borrowed value again — would double-count.
    const hasTrackingTokenCollateral = Object.keys(collateralBalances).some((sym) => {
      const upper = sym.toUpperCase();
      return (
        upper.startsWith('BLEND_') ||
        upper.startsWith('AQ_') ||
        upper.startsWith('SS_') ||
        upper.endsWith('_LP') ||
        upper.includes('AQUARIUS') ||
        upper.includes('SOROSWAP')
      );
    });
    const grossCollateralValue = hasTrackingTokenCollateral
      ? totalCollateralValue
      : totalCollateralValue + effectiveDebtValue;

    const avgHealthFactor =
      effectiveDebtValue > 0
        ? grossCollateralValue / effectiveDebtValue
        : grossCollateralValue > 0
          ? HEALTH_FACTOR_INFINITY_SENTINEL
          : 0;

    //  Collateral Left Before Liquidation:
    //    = grossCollateral - (totalDebt × LIQUIDATION_THRESHOLD)
    //    i.e. how much collateral value can fall before HF hits 1.1
    const collateralLeftBeforeLiquidation = Math.max(
      0,
      grossCollateralValue - effectiveDebtValue * LIQUIDATION_THRESHOLD
    );

    // Net Available Collateral = unencumbered equity (deposit not backing debt).
    // For a leveraged position this equals the user's initial collateral —
    // the borrowed assets sit in the account but they're owed, not free.
    const netAvailableCollateral = Math.max(0, totalCollateralValue);

    //  Total Value = collateral + debt (gross balance sheet). Reflects the
    // total USD value sitting in the margin account — both the user's own
    // deposit and the borrowed funds physically held by the smart account.
    // Equity (collateral − debt) is already surfaced separately as
    // "Net Available Collateral", so this row is the additive total.
    const totalValue = totalCollateralValue + effectiveDebtValue;

    //  Debt limit = maximum safe debt at liquidation threshold
    const debtLimit = grossCollateralValue > 0
      ? grossCollateralValue / LIQUIDATION_THRESHOLD
      : 0;

    //  Borrow rate — derive from the lending pool's live on-chain utilization
    // for the user's largest debt asset, then apply the documented two-slope
    // rate model (see lib/utils/borrow-rate.ts). Falls back to 0 when there
    // is no real debt or the pool stats RPC fails.
    let borrowRate = 0;
    if (effectiveDebtValue > 0) {
      const primaryDebtSymbol = Object.entries(borrowedBalances)
        .map(([symbol, b]) => ({ symbol, usd: parseFloat(b.usdValue) || 0 }))
        .sort((a, b) => b.usd - a.usd)[0]?.symbol;
      const assetType = primaryDebtSymbol ? debtSymbolToAssetType(primaryDebtSymbol) : null;
      if (assetType) {
        try {
          const stats = await ContractService.getPoolStats(assetType);
          const utilizationPct = parseFloat(stats.utilizationRate) || 0;
          borrowRate = parseFloat(computeBorrowApr(utilizationPct).toFixed(2));
        } catch (rateErr) {
          console.warn('⚠️ Borrow rate fetch failed, leaving as 0:', rateErr);
        }
      }
    }

    useMarginAccountInfoStore.getState().set({
      borrowedBalances,
      collateralBalances,
      totalBorrowedValue,
      totalCollateralValue,
      totalValue,
      avgHealthFactor,
      collateralLeftBeforeLiquidation,
      netAvailableCollateral,
      timeToLiquidation: 0,
      borrowRate,
      debtLimit,
      minDebt: 0,
      maxDebt: debtLimit,
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
