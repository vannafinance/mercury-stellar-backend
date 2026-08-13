// Margin-account store: the connected user's smart margin account (identity +
// health-factor / collateral / borrowed / derived-risk fields) plus the action
// functions that discover, create, and mutate it on-chain. Account identity and
// balances are runtime-only and always rebuilt from authoritative chain reads.

import createNewStore from "@/zustand/index";
import { MarginAccountService, type MarginAccount } from "@/lib/margin-utils";
import { computeMarginSnapshot } from "@/lib/account-snapshot";
import { deriveMarginHealth } from "@/lib/margin-health";
import { showTxStep, showTxSuccess, showTxError } from "@/lib/tx-progress";
import { normalizeCreateAccountError } from "@/lib/errors/normalize";
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

const canonicalMarginToken = (token: string): string => {
  const normalized = token.toUpperCase();
  if (normalized === 'BLEND_USDC' || normalized === 'USDC') return 'BLUSDC';
  if (normalized === 'AQUIRESUSDC' || normalized === 'AQUARIUS_USDC') return 'AQUSDC';
  if (normalized === 'SOROSWAPUSDC' || normalized === 'SOROSWAP_USDC') return 'SOUSDC';
  return normalized;
};

// Types
/** A per-token balance entry: raw `amount` and its `usdValue` (both decimal strings). */
export interface BorrowedBalance {
  amount: string;
  usdValue: string;
}

/**
 * Full margin-account slice: account identity (`hasMarginAccount`,
 * `marginAccountAddress`), creation flags/errors, per-token borrowed/collateral
 * balances, and the derived risk fields (health factor, debt limits, liquidation
 * metrics) produced by `computeMarginSnapshot`.
 */
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
// NOT persisted. Identity and balances always come from AccountManager/Soroban.
export const useMarginAccountInfoStore = createNewStore(initialState, {
  name: "margin-account-info-store",
  devTools: true,
});

// Action functions
/**
 * Adopt a freshly created/known margin account: marks it present, stores its
 * address, clears creation flags, and wipes any leftover balances so a prior
 * account's values can't bleed in before the first refresh lands.
 */
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

/**
 * Reset the store to "no margin account" (used on disconnect or when discovery
 * finds none): zeroes all identity, balance, and derived-risk fields AND clears
 * every rate-limit/dedup cache so a later reconnect refetches from scratch.
 */
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

/** Toggle the account-creation loading flag; clears any prior error when entering the loading state. */
export const setAccountCreationLoading = (loading: boolean) => {
  useMarginAccountInfoStore.getState().set({
    isCreatingAccount: loading,
    accountCreationError: loading ? null : useMarginAccountInfoStore.getState().accountCreationError,
  });
};

/** Record an account-creation error (or clear it with null) and reset the loading flag. */
export const setAccountCreationError = (error: string | null) => {
  useMarginAccountInfoStore.getState().set({
    accountCreationError: error,
    isCreatingAccount: false,
  });
};

// Add deposit and borrow action
/**
 * Deposit collateral and open a leveraged borrow in one flow against the user's
 * active margin account. Refreshes borrowed balances afterwards (even on a
 * partial success where the deposit landed but the borrow failed).
 *
 * @param userAddress - Owner wallet; used to look up the active margin account.
 * @param depositAmount - Collateral amount to deposit (token units).
 * @param multiplier - Leverage multiplier for the borrow leg.
 * @param tokenSymbol - Collateral/borrow token; normalized to its canonical margin symbol. Defaults to XLM.
 * @returns `{ success, hash?, error? }`.
 */
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
/**
 * Borrow against an existing margin account (no deposit leg). Converts the amount
 * to WAD (18 decimals) via BigInt to avoid Number scientific-notation parse
 * failures, toggles `isLoadingBorrowedBalances`, and always refreshes balances
 * after the operation (success or failure).
 *
 * @param userAddress - Owner wallet; used to look up the active margin account.
 * @param tokenSymbol - Token to borrow; normalized to its canonical margin symbol.
 * @param borrowAmount - Amount to borrow (token units).
 * @returns `{ success, hash?, error? }`.
 */
export const borrowTokens = async (
  userAddress: string,
  tokenSymbol: string,
  borrowAmount: number,
  // Forwarded to MarginAccountService.borrowTokens — pass the `nextSequence`
  // from a just-confirmed prior same-account tx (e.g. a dual-borrow's atomic
  // deposit_and_borrow leg) to skip a same-account RPC re-read that isn't
  // reliably caught up yet. See borrowTokensAttempt's doc comment.
  knownSequence?: string
): Promise<{ success: boolean; hash?: string; error?: string; nextSequence?: string }> => {
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
      borrowAmountWad,
      knownSequence
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
/** Admin/testing helper: runs the one-time on-chain contract configuration. Returns `{ success, error? }`. */
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

/**
 * Resolve the user's margin account into the store from authoritative on-chain
 * discovery (adopting the newest active account). Concurrent calls for the same
 * user are deduped, and results are
 * throttled by CACHE_DURATION_MS / MIN_FETCH_INTERVAL_MS unless `forceRefresh`.
 *
 * @param userAddress - Owner wallet to resolve.
 * @param forceRefresh - Bypass the throttle caches when true.
 */
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

      // A runtime entry can paint immediately during same-session navigation,
      // but it was originally resolved from chain and is never persisted.
      const accountInfo = MarginAccountService.getMarginAccountInfo(userAddress);
      const cachedAddress = accountInfo.hasAccount ? accountInfo.accountAddress ?? null : null;
      if (cachedAddress) {
        applyResolvedMarginAccount(cachedAddress);
      }

      // On-chain discovery is authoritative — it resolves the NEWEST
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

/**
 * Create a new on-chain margin account for the wallet, toggling the creation
 * loading flag and committing the resolved account (or recording an error) into
 * the store. Returns true on success.
 */
export const createMarginAccount = async (userAddress: string): Promise<boolean> => {
  try {
    setAccountCreationLoading(true);
    showTxStep("Creating your Vanna margin account on Stellar");

    const result = await MarginAccountService.createMarginAccount(userAddress);

    if (result.success && result.marginAccountAddress) {
      const marginAccount: MarginAccount = {
        address: result.marginAccountAddress,
        owner: userAddress,
        isActive: true,
        createdAt: Date.now()
      };

      setMarginAccount(marginAccount);
      showTxSuccess("Margin account created!");
      return true;
    } else {
      const rawMessage = result.error || 'Failed to create margin account';
      setAccountCreationError(rawMessage);
      showTxError(normalizeCreateAccountError(rawMessage));
      return false;
    }
  } catch (error: any) {
    const rawMessage = error?.message || 'Failed to create margin account';
    setAccountCreationError(rawMessage);
    showTxError(normalizeCreateAccountError(rawMessage));
    return false;
  }
};

/** Shallow-merge an arbitrary partial into the margin-account slice. */
export const updateAccountData = (data: Partial<MarginAccountInfoStateType>) => {
  useMarginAccountInfoStore.getState().set(data);
};


/**
 * Recompute and commit the account's balances and derived risk fields via the
 * shared `computeMarginSnapshot` (the single source of truth shared with the
 * /api/account route). Publishes fast debt/balances first via `onPartial`
 * (progressive render), then the full snapshot. Concurrent calls per account are
 * deduped and throttled unless `forceRefresh`; a forced refresh also suppresses
 * the cached snapshot feed for one TTL window so the lagging edge cache can't
 * overwrite the fresh post-mutation values.
 *
 * @param marginAccountAddress - Account to refresh (validated for basic shape).
 * @param forceRefresh - Bypass throttle caches after an on-chain mutation.
 */
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

    // Single source of truth for the HF / collateral / borrowed / net math —
    // shared with the cached /api/account route (lib/account-snapshot.ts) so the
    // mutation/fallback path and the server route can never diverge. onPartial
    // publishes the fast debt/balances first (progressive render); the heavier
    // farm/SAC/borrow-rate work resolves concurrently and lands in the final set.
    const snap = await computeMarginSnapshot(marginAccountAddress, {
      onPartial: (p) => {
        const prev = useMarginAccountInfoStore.getState();
        // MERGE collateral, don't replace. The partial read only has the
        // non-SAC collateral (AQUSDC/SOUSDC); XLM/BLUSDC arrive later in the
        // full pass via the SAC reconcile. Replacing here briefly blanked a
        // still-valid collateral list — and wiped the optimistic deposit —
        // which left the MB collateral grid stuck in its loading skeleton for
        // the whole reconcile window. Preserving prior keys keeps the grid
        // populated; the full snapshot below sets the authoritative set.
        const mergedCollateral = { ...prev.collateralBalances, ...p.collateralBalances };
        // Re-derive provisional health from the MERGED collateral so the health
        // factor stays coherent with the debt (never a stale ∞ over fresh debt)
        // without dipping when the partial read is missing SAC collateral.
        const mergedGross = Object.values(mergedCollateral).reduce(
          (sum, b) => sum + (parseFloat(b.usdValue) || 0),
          0,
        );
        const debt = p.totalBorrowedValue;
        const health = deriveMarginHealth({
          grossCollateralValue: Math.max(mergedGross, prev.grossCollateralValue || 0),
          effectiveDebtValue: debt > 0.01 ? debt : 0,
          totalBorrowedValue: debt,
        });
        useMarginAccountInfoStore.getState().set({
          borrowedBalances: { ...p.borrowedBalances },
          collateralBalances: mergedCollateral,
          totalBorrowedValue: debt,
          avgHealthFactor: health.avgHealthFactor,
          grossCollateralValue: Math.max(mergedGross, prev.grossCollateralValue || 0),
          netAvailableCollateral: health.netAvailableCollateral,
          collateralLeftBeforeLiquidation: health.collateralLeftBeforeLiquidation,
          isLoadingBorrowedBalances: false,
        });
      },
    });

    // Guard against a degraded client read blanking collateral. XLM/BLUSDC
    // collateral comes ONLY from the SAC reconcile, which can fail in the browser
    // (it succeeds server-side in /api/account). When it fails, snap.collateralBalances
    // drops those keys — which blanked the MB grid + Positions for an account that
    // demonstrably still holds collateral. If the fresh read shows ZERO collateral
    // but we already had some, treat it as degraded: update only the debt-side
    // fields and PRESERVE the prior collateral/health, letting the reliable server
    // snapshot feed (/api/account) reconcile. A genuine full withdrawal self-heals
    // on the next read/ledger tick.
    const prevState = useMarginAccountInfoStore.getState();
    const snapHasCollateral = Object.values(snap.collateralBalances).some(
      (b) => (parseFloat(b.amount) || 0) > 0,
    );
    const prevHadCollateral = Object.values(prevState.collateralBalances).some(
      (b) => (parseFloat(b.amount) || 0) > 0,
    );
    const collateralDegraded = !snapHasCollateral && prevHadCollateral;

    if (collateralDegraded) {
      console.warn(
        "[margin] client snapshot returned no collateral but account holds some " +
          "(likely a SAC reconcile failure); preserved prior collateral — the " +
          "server snapshot feed will reconcile.",
      );
      useMarginAccountInfoStore.getState().set({
        borrowedBalances: snap.borrowedBalances,
        totalBorrowedValue: snap.totalBorrowedValue,
        borrowRate: snap.borrowRate,
        isLoadingBorrowedBalances: false,
      });
    } else {
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
    }
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

/** Reset the entire slice back to its initial (empty) state. */
export const resetToInitialState = () => {
  useMarginAccountInfoStore.getState().reset();
};

/** Clear just the account-creation flags (loading + error), e.g. when reopening the create dialog. */
export const resetCreationState = () => {
  useMarginAccountInfoStore.getState().set({
    isCreatingAccount: false,
    accountCreationError: null,
  });
};
