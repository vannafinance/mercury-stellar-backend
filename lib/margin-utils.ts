/**
 * Margin / smart-account integration layer for the Vanna lending protocol.
 *
 * Wraps the on-chain AccountManager + per-trader SmartAccount contracts behind
 * one service class (`MarginAccountService`): account discovery/creation,
 * collateral deposit/withdraw, borrow/repay, and the one-signature "open
 * position" flows (deposit + borrow + deploy to Blend). Reads go through
 * simulated transactions; writes are signed via Freighter.
 *
 * Amount conventions are deliberate and load-bearing:
 *   - The contract stores and accepts amounts in WAD (18-decimal fixed point);
 *     all `*_wad` params/returns use this scale.
 *   - SAC tokens on this deployment are 7-decimal (stroops), so a stroop→WAD
 *     conversion multiplies by 1e11 (see `getMarginAccountTokenBalanceWad`).
 *   - Symbol normalization (`normalizeContractTokenSymbol`) maps the several UI
 *     aliases (USDC/BLUSDC, AQUSDC, SOUSDC) onto the exact symbols the contract
 *     expects per call site — these differ between deposit and repay.
 *
 * Discovery favors permanent on-chain storage over RPC events because Soroban
 * testnet only retains events for ~7 days.
 */
import * as StellarSdk from '@stellar/stellar-sdk';
import { getAddress, signTransaction } from '@/lib/wallet-adapter';
import { getReadSourceAddress } from '@/lib/read-source';
import {
  CONTRACT_ADDRESSES,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
  ContractService,
  ASSET_TYPES,
  type AssetType,
  resubmitOnTryAgainLater,
  withFootprintRaceRetry,
  describeSendError,
  describeFailedTx,
} from './stellar-utils';
import { BlendService } from './blend-utils';
import { mergeFarmTrackingCollateralIntoBalances } from '@/lib/analytics/stellar/farmTrackingCollateral';
import { fetchTokenPrice, getCachedTokenPrice } from './oracle-price';
import { markTxSubmitted, showTxStep } from './tx-progress';

// Types
/**
 * A trader's deployed margin smart account, as tracked client-side.
 *
 * `address` is the on-chain SmartAccount C-address; `owner` is the trader's
 * G-address. `accountManagerAddress` records which AccountManager deployment
 * minted it — used to invalidate cached accounts after a redeploy (a stale
 * account points at a dead manager).
 */
export interface MarginAccount {
  address: string;
  owner: string;
  isActive: boolean;
  createdAt: number;
  accountManagerAddress?: string;
}

/**
 * Outcome of {@link MarginAccountService.createMarginAccount}. On success,
 * `marginAccountAddress` is set; `hash` is present only when a creation tx was
 * actually submitted (absent when an existing account was recovered). `error`
 * may be populated even when `success` is true to carry an informational note
 * (e.g. "account already exists").
 */
export interface MarginAccountCreationResult {
  success: boolean;
  marginAccountAddress?: string;
  hash?: string;
  error?: string;
}

/**
 * Service for managing a trader's margin smart account against the on-chain
 * AccountManager. All methods are static; the class holds no instance state.
 *
 * Read methods simulate transactions (no signature, no fee); write methods
 * prepare → sign via Freighter → submit → poll. Most writes bump the fee well
 * above BASE_FEE (20x–120x) because the chained collateral/borrow/deploy paths
 * are resource-heavy. Account discovery is always authoritative on-chain; the
 * in-memory map below only avoids duplicate lookups during the current runtime.
 */
export class MarginAccountService {
  private static marginAccountCache = new Map<string, MarginAccount>();

  private static normalizeContractTokenSymbol(tokenSymbol: string): string {
    const normalized = tokenSymbol?.toUpperCase();
    if (normalized === 'BLUSDC' || normalized === 'BLEND_USDC' || normalized === 'USDC') {
      // Use canonical USDC symbol for Blend USDC on this deployment.
      // The contract routes USDC and BLUSDC to the same token address,
      // but USDC avoids the BLUSDC symbol trap observed in deposit_collateral_tokens.
      return 'USDC';
    }
    if (normalized === 'AQUSDC' || normalized === 'AQUIRESUSDC' || normalized === 'AQUARIUS_USDC') {
      return 'AQUSDC';
    }
    if (normalized === 'SOUSDC' || normalized === 'SOROSWAPUSDC' || normalized === 'SOROSWAP_USDC') {
      return 'SOUSDC';
    }
    return normalized;
  }

  private static async checkWalletBalanceForDeposit(
    walletAddress: string,
    contractTokenSymbol: string,
    depositAmount: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (contractTokenSymbol === "XLM") {
      return { ok: true };
    }

    let tokenContract: string | undefined;
    let displaySymbol = contractTokenSymbol;
    if (contractTokenSymbol === "USDC") {
      tokenContract = CONTRACT_ADDRESSES.BLEND_USDC;
      displaySymbol = "BLUSDC";
    } else if (contractTokenSymbol === "AQUSDC") {
      tokenContract = CONTRACT_ADDRESSES.AQUARIUS_USDC;
    } else if (contractTokenSymbol === "SOUSDC") {
      tokenContract = CONTRACT_ADDRESSES.SOROSWAP_USDC;
    }

    if (!tokenContract) return { ok: true };

    const balanceStr = await ContractService.getSorobanTokenWalletBalance(
      tokenContract,
      walletAddress,
    );
    const available = parseFloat(balanceStr) || 0;
    if (available + 1e-7 < depositAmount) {
      if (available <= 1e-7) {
        const faucetHint =
          displaySymbol === "BLUSDC"
            ? "Blend USDC"
            : displaySymbol === "AQUSDC"
              ? "Aquarius USDC"
              : displaySymbol === "SOUSDC"
                ? "Soroswap USDC"
                : displaySymbol;
        return {
          ok: false,
          error:
            `You have no ${displaySymbol} in your wallet. Use the Faucet to mint ${faucetHint} (establishes the required trustline), then retry.`,
        };
      }
      return {
        ok: false,
        error: `Insufficient ${displaySymbol} wallet balance. Available: ${available.toFixed(2)} ${displaySymbol}.`,
      };
    }

    return { ok: true };
  }

  private static async checkPoolLiquidity(
    contractBorrowSymbol: string,
    borrowAmountTokens: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    type PoolEntry = { assetType: AssetType; displayName: string };
    const poolMap: Record<string, PoolEntry> = {
      XLM:    { assetType: ASSET_TYPES.XLM,           displayName: 'XLM' },
      USDC:   { assetType: ASSET_TYPES.USDC,          displayName: 'USDC' },
      AQUSDC: { assetType: ASSET_TYPES.AQUARIUS_USDC, displayName: 'Aquarius USDC' },
      SOUSDC: { assetType: ASSET_TYPES.SOROSWAP_USDC, displayName: 'Soroswap USDC' },
    };

    const entry = poolMap[contractBorrowSymbol];
    if (!entry) return { ok: true };

    // Matches lending-pool's own MAX_UTILIZATION_WAD (pool.rs) — 95%. A small
    // safety margin below the real cap (94% here) absorbs interest accruing
    // between this read and the transaction actually executing, same
    // rationale as this file's other pre-execution safety buffers.
    const MAX_UTILIZATION = 0.94;

    try {
      const [poolLiqStr, poolBorrowsStr] = await Promise.all([
        ContractService.getPoolLiquidity(entry.assetType),
        ContractService.getPoolBorrows(entry.assetType),
      ]);
      const poolBalance = parseFloat(poolLiqStr) || 0;
      const poolBorrows = parseFloat(poolBorrowsStr) || 0;

      if (borrowAmountTokens > poolBalance) {
        return {
          ok: false,
          error:
            `The ${entry.displayName} lending pool does not have enough liquidity. ` +
            `Available: ${poolBalance.toFixed(2)} ${entry.displayName}, ` +
            `you need: ${borrowAmountTokens.toFixed(2)} ${entry.displayName}. ` +
            `Please reduce your leverage or wait for more liquidity to be supplied to the pool.`,
        };
      }

      // The pool rejects ANY borrow that would push utilization
      // (borrows / (liquidity + borrows)) past its hard cap, even when raw
      // liquidity above is technically enough — confirmed live: a pool at
      // 94.88% utilization traps on a borrow request that raw liquidity
      // alone would have allowed, because it pushes utilization to 96.42%.
      // That trap surfaces as an opaque generic HostError (Soroban strips
      // panic message text in the release WASM build), so this check must
      // catch it BEFORE submission — there's no way to give the user a
      // clear reason after the fact.
      const totalAssets = poolBalance + poolBorrows;
      if (totalAssets > 0) {
        const newUtilization = (poolBorrows + borrowAmountTokens) / totalAssets;
        if (newUtilization > MAX_UTILIZATION) {
          const maxAdditionalBorrow = Math.max(0, totalAssets * MAX_UTILIZATION - poolBorrows);
          return {
            ok: false,
            error:
              `The ${entry.displayName} lending pool is already at ${(poolBorrows / totalAssets * 100).toFixed(1)}% utilization ` +
              `and can only safely lend ${maxAdditionalBorrow.toFixed(2)} more ${entry.displayName} right now ` +
              `(you requested ${borrowAmountTokens.toFixed(2)}). Please reduce your leverage/borrow amount, ` +
              `or wait for more liquidity to be supplied to the pool.`,
          };
        }
      }

      return { ok: true };
    } catch {
      return { ok: true };
    }
  }

  private static parseBorrowNotAllowedMessage(raw: any, tokenSymbol: string): string {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});

    if (text.includes('is_borrow_allowed') && text.includes('false')) {
      return `Borrow not allowed by Risk Engine for ${tokenSymbol}. Your account collateral/debt ratio is too low for this borrow amount. Please repay existing debt or add more collateral, then try again.`;
    }

    if (text.includes('Borrowing is not allowed for this user')) {
      return `Borrow not allowed by Risk Engine for ${tokenSymbol}. Your account collateral/debt ratio is too low for this borrow amount. Please repay existing debt or add more collateral, then try again.`;
    }

    if (text.includes('price not available')) {
      return `Borrow failed for ${tokenSymbol} because an oracle price is missing for one of your account assets. Please configure oracle pricing for all collateral/debt symbols and retry.`;
    }

    if (text.includes('trustline entry is missing for account')) {
      const match = text.match(/trustline entry is missing for account"\s*,\s*([A-Z0-9]+)/);
      const accountHint = match?.[1] ? ` (${match[1]})` : '';
      return `Borrow failed for ${tokenSymbol}: lending pool treasury trustline is missing${accountHint}. This is a pool configuration issue, not your collateral ratio.`;
    }

    if (text.includes('Budget') || text.includes('ExceededLimit')) {
      return 'Budget exceeded.';
    }

    if (text.includes('InvalidAction') || text.includes('UnreachableCodeReached')) {
      return `Borrow action rejected for ${tokenSymbol}. This usually means borrow constraints are not satisfied (health factor, debt limit, or collateral requirements).`;
    }

    return `Borrow failed for ${tokenSymbol}. Please check collateral, existing debt, and risk limits, then retry.`;
  }

  private static formatUserFacingContractError(raw: any, action: 'repay' | 'borrow' | 'withdraw' | 'generic' = 'generic'): string {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
    const compact = text.split('\nEvent log')[0]?.trim() || text;

    // The diagnostic clues that actually distinguish WHY a call failed —
    // collect_from's boolean false, remove_borrowed_token_balance's underflow
    // trap, ArithDomain/u256_sub panics, Budget/ExceededLimit — live INSIDE
    // the "Event log" section, which `compact` (used for the short fallback
    // return at the bottom) deliberately cuts off. Match keyword checks
    // against the FULL `text` below, never `compact` — checking `compact`
    // here silently never matches (confirmed live: a genuine insufficient-
    // margin-account-balance repay fell through every check below straight
    // to the generic "HostError" fallback, because every distinguishing
    // keyword was in the truncated-away event log).
    if (/budget|exceededlimit/i.test(text)) {
      return 'Budget exceeded.';
    }

    if (action === 'repay') {
      // collect_from's u256 subtraction underflows (ArithDomain) whenever the
      // requested amount exceeds what the margin account actually holds —
      // this fires identically whether the gap is a hair of freshly-accrued
      // interest or the account genuinely never had enough of this asset.
      // `remove_borrowed_token_balance` traps the same way when the token's
      // OWN transfer discovers the shortfall a step later (confirmed live:
      // collect_from returns false, then AccountManager still calls
      // remove_borrowed_token_balance, which underflows and panics —
      // surfacing as a generic `Error(WasmVm, InvalidAction)` with none of
      // that detail in the headline). Repay only ever pulls from the margin
      // account (no wallet top-up), so the fix is the same either way: bring
      // more of this asset into the margin account (Transfer Collateral)
      // before repaying again.
      if (
        text.includes('Error(Object, ArithDomain)') ||
        text.includes('ArithDomain') ||
        text.includes('collect_from') ||
        text.includes('u256_sub') ||
        text.includes('remove_borrowed_token_balance') ||
        text.toLowerCase().includes('insufficient') ||
        text.toLowerCase().includes('balance is not sufficient')
      ) {
        return 'Insufficient balance in your margin account to repay this amount. Transfer more funds to your margin account (Transfer Collateral) first, then retry.';
      }

      if (compact.includes('HostError')) {
        return 'Repay transaction failed on-chain. Please refresh debt value and retry.';
      }
    }

    if (action === 'withdraw') {
      if (
        compact.includes('is_withdraw_allowed') ||
        compact.includes('InvalidAction') ||
        compact.includes('UnreachableCodeReached')
      ) {
        return 'Withdraw is blocked by Risk Engine. You likely have active debt, and this transfer would make your account unsafe. Repay some debt or withdraw a smaller amount.';
      }

      if (
        compact.toLowerCase().includes('insufficient') ||
        compact.toLowerCase().includes('balance')
      ) {
        return 'Insufficient collateral balance for this withdrawal.';
      }

      if (compact.includes('HostError')) {
        return 'Withdraw transaction failed on-chain. Please retry with a smaller amount.';
      }
    }

    if (compact.includes('HostError')) {
      return 'Transaction failed on-chain. Please retry in a moment.';
    }

    if (compact.length > 220) {
      return `${compact.slice(0, 220)}...`;
    }

    return compact || 'Transaction failed';
  }

  private static addUsdcAliases(
    balances: Record<string, { amount: string; usdValue: string }>
  ): Record<string, { amount: string; usdValue: string }> {
    const usdc = balances.USDC;
    const blusdc = balances.BLUSDC;

    // Some deployments store/retrieve Blend USDC under USDC, while UI reads BLUSDC.
    // Mirror the non-zero side so both keys stay consistent for rendering + transfer inputs.
    if (usdc && blusdc) {
      const usdcAmount = parseFloat(usdc.amount || '0');
      const blusdcAmount = parseFloat(blusdc.amount || '0');
      if (usdcAmount > blusdcAmount) {
        balances.BLUSDC = { ...usdc };
      } else if (blusdcAmount > usdcAmount) {
        balances.USDC = { ...blusdc };
      }
    } else if (usdc && !blusdc) {
      balances.BLUSDC = { ...usdc };
    } else if (blusdc && !usdc) {
      balances.USDC = { ...blusdc };
    }

    return balances;
  }

  private static async getMarginCollateralBalanceWad(
    marginAccountAddress: string,
    tokenSymbol: string
  ): Promise<bigint> {
    try {
      const userAddress = await getAddress();
      if (userAddress.error) return BigInt(0);

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(userAddress.address);
      const marginContract = new StellarSdk.Contract(marginAccountAddress);

      const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          marginContract.call(
            'get_collateral_token_balance',
            StellarSdk.nativeToScVal(tokenSymbol, { type: 'symbol' })
          )
        )
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (!('result' in sim) || !sim.result?.retval) return BigInt(0);
      const raw = StellarSdk.scValToNative(sim.result.retval);
      return BigInt(raw.toString());
    } catch {
      return BigInt(0);
    }
  }

  private static async waitForCollateralSync(
    marginAccountAddress: string,
    tokenSymbol: string,
    minExpectedWad: bigint
  ): Promise<boolean> {
    const maxAttempts = 20;
    const delayMs = 1200;

    for (let i = 0; i < maxAttempts; i += 1) {
      const current = await this.getMarginCollateralBalanceWad(marginAccountAddress, tokenSymbol);
      if (current >= minExpectedWad) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return false;
  }

  private static async simulateBorrowAllowed(
    marginAccountAddress: string,
    tokenSymbol: string,
    borrowAmountWad: bigint
  ): Promise<boolean> {
    if (borrowAmountWad <= BigInt(0)) return false;

    try {
      const userAddress = await getAddress();
      if (userAddress.error) return false;

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(userAddress.address);
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);

      const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'borrow',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
            StellarSdk.nativeToScVal(borrowAmountWad.toString(), { type: 'u256' }),
            StellarSdk.nativeToScVal(tokenSymbol, { type: 'symbol' })
          )
        )
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      return !('error' in sim);
    } catch {
      return false;
    }
  }

  private static async findMaxBorrowAllowedWad(
    marginAccountAddress: string,
    tokenSymbol: string,
    requestedBorrowWad: bigint
  ): Promise<bigint> {
    if (requestedBorrowWad <= BigInt(0)) return BigInt(0);

    if (await this.simulateBorrowAllowed(marginAccountAddress, tokenSymbol, requestedBorrowWad)) {
      return requestedBorrowWad;
    }

    let low = BigInt(0);
    let high = requestedBorrowWad;
    let attempts = 0;

    while (low < high && attempts < 24) {
      attempts += 1;
      const mid = (low + high + BigInt(1)) / BigInt(2);
      const allowed = await this.simulateBorrowAllowed(marginAccountAddress, tokenSymbol, mid);
      if (allowed) {
        low = mid;
      } else {
        high = mid - BigInt(1);
      }
    }

    return low;
  }

  /**
   * Read the runtime-cached margin account for a trader.
   *
   * @param userAddress - Trader's G-address used for registry discovery.
   * The cache is deliberately memory-only: financial/account state must never
   * be restored from browser storage. The layout hydrator first discovers the
   * account from AccountManager persistent storage and then fills this map.
   */
  static getStoredMarginAccount(userAddress: string): MarginAccount | null {
    return this.marginAccountCache.get(userAddress) ?? null;
  }

  /**
   * Cache a chain-resolved margin account for this runtime only.
   *
   * @param userAddress - Trader's G-address (map key).
   * @param marginAccount - Account to persist; its `accountManagerAddress` is
   *                        overwritten with the live deployment.
   */
  static storeMarginAccount(userAddress: string, marginAccount: MarginAccount): void {
    this.marginAccountCache.set(userAddress, {
      ...marginAccount,
      accountManagerAddress: CONTRACT_ADDRESSES.ACCOUNT_MANAGER,
    });
  }


  /**
   * Whether the trader has an active runtime-cached margin account.
   * This is only a synchronous UI convenience. Use
   * {@link discoverExistingAccount} to recover one that isn't cached.
   *
   * @param userAddress - Trader's G-address.
   */
  static hasMarginAccount(userAddress: string): boolean {
    const account = this.getStoredMarginAccount(userAddress);
    return account !== null && account.isActive;
  }

  /**
   * Create a margin smart account for a trader via AccountManager
   * `create_account`, enforcing one-account-per-trader.
   *
   * Idempotent by design: checks the runtime cache, then the chain
   * ({@link discoverExistingAccount}), and returns the existing account if
   * found — only signs/submits a creation tx when none exists anywhere. On a
   * successful tx it extracts the new C-address from the result (or re-reads it
   * from the registry as a fallback) and caches it.
   *
   * @param userAddress - Trader's G-address; becomes the account owner and the
   *                       tx source (Freighter will prompt for a signature).
   * @returns {@link MarginAccountCreationResult}. When an existing account is
   *          returned, `success` is true and `error` carries an informational
   *          note; `hash` is set only when a new account was actually minted.
   */
  static async createMarginAccount(
    userAddress: string
  ): Promise<MarginAccountCreationResult> {
    try {
      
      // STEP 1: reuse an account already resolved from chain in this runtime.
      const existingAccount = this.getStoredMarginAccount(userAddress);
      if (existingAccount && existingAccount.isActive) {
        return {
          success: true,
          marginAccountAddress: existingAccount.address,
          error: 'User already has an active margin account'
        };
      }
      
      // STEP 2: Check blockchain for existing accounts (comprehensive search)
      const blockchainAccount = await this.getMarginAccountFromRegistry(userAddress);
      if (blockchainAccount) {
        return {
          success: true,
          marginAccountAddress: blockchainAccount,
          error: 'User already has an active margin account (recovered from blockchain)'
        };
      }
      
      // STEP 3: No existing account found anywhere - proceed with creation
      
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(userAddress);
      
      // Create contract instance for AccountManager
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);
      
      // Build the transaction to call create_account
      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'create_account',
            StellarSdk.nativeToScVal(userAddress, { type: 'address' })
          )
        )
        .setTimeout(30)
        .build();

      const preparedTx = await server.prepareTransaction(transaction);
      
      // Sign the transaction
      const signResult = await signTransaction(preparedTx.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      const signedTx = StellarSdk.TransactionBuilder.fromXDR(
        signResult.signedTxXdr,
        NETWORK_PASSPHRASE
      );

      // Wallet just returned a signed tx — switch the progress modal from
      // "waiting on you" to an animated "confirming on-chain" fill.
      markTxSubmitted();

      const result = await server.sendTransaction(signedTx as StellarSdk.Transaction);

      if (result.status === 'PENDING') {
        // Poll for transaction completion
        const finalResult = await this.pollTransactionStatus(server, result.hash);
        
        if (finalResult.status === 'SUCCESS') {
          // Extract the margin account address from the result
          let marginAccountAddress = this.extractMarginAccountAddress(finalResult);
          
          // If we couldn't extract the address, try to get it via contract call
          if (!marginAccountAddress) {
            marginAccountAddress = await this.getMarginAccountFromRegistry(userAddress);
          }
          
          if (marginAccountAddress) {
            // Store the margin account
            const marginAccount: MarginAccount = {
              address: marginAccountAddress,
              owner: userAddress,
              isActive: true,
              createdAt: Date.now()
            };
            
            this.storeMarginAccount(userAddress, marginAccount);
            
            return {
              success: true,
              marginAccountAddress,
              hash: result.hash
            };
          } else {
            return {
              success: false,
              error: 'Failed to extract margin account address from transaction result'
            };
          }
        } else {
          return {
            success: false,
            error: `Transaction failed with status: ${finalResult.status}`
          };
        }
      } else {
        return {
          success: false,
          error: `Transaction failed immediately with status: ${result.status}`
        };
      }
    } catch (error: any) {
      console.error('Create margin account error:', error);
      return {
        success: false,
        error: error?.message || 'Failed to create margin account'
      };
    }
  }

  /**
   * Get margin account from blockchain by querying smart contracts.
   *
   * Lookup strategy (most reliable first):
   *   1. Read AccountManager persistent storage `SmartAccounts(trader)` via
   *      getContractData. This is the ground truth — the contract writes here
   *      on every account creation and extends TTL by 1+ year, so it never
   *      expires the way RPC events do.
   *   2. Fall back to Smart_account_creation events (only ~7d retention on
   *      testnet) — covers the edge case where storage read fails (RPC
   *      hiccup, key shape change, etc.).
   *
   * Then for each candidate, verify on-chain that the smart account is still
   * active before returning it.
   */
  private static async getMarginAccountFromRegistry(userAddress: string): Promise<string | null> {
    try {

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);

      // Step 1: read on-chain persistent storage (permanent, no event-retention limit)
      let candidates = await this.getSmartAccountsFromStorage(userAddress, server);

      // Step 2: events fallback only if storage returned nothing
      if (candidates.length === 0) {
        candidates = await this.getAccountsFromEvents(userAddress, server);
      }

      // Step 3: resolve to the NEWEST account, deterministically. Walk
      // newest-first and take the first one the contract definitively reports
      // active. Crucially, if a candidate's status is undetermined (RPC error),
      // we resolve to it anyway rather than skipping to an older account — the
      // newest account is the intended one, and on a clean tick it would win.
      // Skipping on a transient error is exactly what made the resolved account
      // (and the displayed collateral) flip between accounts every ledger close.
      for (let i = candidates.length - 1; i >= 0; i--) {
        const accountAddress = candidates[i];
        const isActive = await this.isAccountActive(accountAddress, server, userAddress);

        // Definitively inactive → this slot was abandoned; try the next-newest.
        if (isActive === false) continue;

        // Active (true) or undetermined (null) → this is our account. Resolving
        // on null keeps selection stable across transient RPC failures.
        const marginAccount: MarginAccount = {
          address: accountAddress,
          owner: userAddress,
          isActive: true,
          createdAt: Date.now(),
        };
        this.storeMarginAccount(userAddress, marginAccount);
        return accountAddress;
      }

      return null;
    } catch (error) {
      console.error('❌ Error discovering existing margin account from blockchain:', error);
      return null;
    }
  }

  /**
   * Read trader → smart-accounts mapping directly from AccountManager's
   * persistent storage.
   *
   * The contract stores it under `AccountManagerKey::SmartAccounts(trader)`
   * (see Protocol_V1_Soroban/contracts/AccountManagerContract — the enum
   * tuple variant serializes as `ScVec[Symbol("SmartAccounts"), Address]`).
   * Persistent storage TTL is extended to ~1 year on every write, so this
   * lookup works even for accounts created weeks/months ago — unlike events,
   * which Soroban testnet RPC retains for only ~7 days.
   */
  private static async getSmartAccountsFromStorage(
    userAddress: string,
    server: StellarSdk.rpc.Server,
  ): Promise<string[]> {
    try {
      const key = StellarSdk.xdr.ScVal.scvVec([
        StellarSdk.xdr.ScVal.scvSymbol('SmartAccounts'),
        StellarSdk.nativeToScVal(userAddress, { type: 'address' }),
      ]);

      const entry = await server.getContractData(
        CONTRACT_ADDRESSES.ACCOUNT_MANAGER,
        key,
        StellarSdk.rpc.Durability.Persistent,
      );

      const native = StellarSdk.scValToNative(entry.val.contractData().val());
      return Array.isArray(native) ? (native as string[]) : [];
    } catch (error: any) {
      // Missing entry → user has never created a margin account on this
      // contract. Treat as "no accounts" and let the events fallback try.
      const msg = String(error?.message ?? error ?? '');
      if (msg.includes('not found') || msg.includes('Could not find ledger entry')) {
        return [];
      }
      console.warn('⚠️ Failed to read SmartAccounts from storage:', error);
      return [];
    }
  }

  /**
   * Get user's inactive accounts from the AccountManager contract
   */
  private static async getUserInactiveAccounts(userAddress: string, server: StellarSdk.rpc.Server): Promise<string[]> {
    try {
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);
      
      const call = contract.call(
        'get_inactive_accounts',
        StellarSdk.nativeToScVal(userAddress, { type: 'address' })
      );
      
      const result = await server.simulateTransaction(
        new StellarSdk.TransactionBuilder(
          new StellarSdk.Account(CONTRACT_ADDRESSES.ACCOUNT_MANAGER, '0'), 
          { fee: '0', networkPassphrase: NETWORK_PASSPHRASE }
        ).addOperation(call).setTimeout(30).build()
      );
      
      // Check for successful simulation result
      if ('result' in result && result.result) {
        const accounts = StellarSdk.scValToNative(result.result.retval);
        return Array.isArray(accounts) ? accounts : [];
      }
      
      return [];
    } catch (error) {
      console.error('Error getting inactive accounts from contract:', error);
      return [];
    }
  }

  /**
   * Get accounts from Smart_account_creation events.
   *
   * Stellar SDK delivers contract events with `topic` (array of ScVals) and
   * `value` (the body ScVal) as separate fields — NOT a single ScVal of
   * `[topics, data]`. The previous implementation parsed the wrong shape and
   * always returned []. This is the bounded fallback when AccountManager's
   * persistent trader→account registry lookup cannot resolve an account.
   */
  private static async getAccountsFromEvents(userAddress: string, server: StellarSdk.rpc.Server): Promise<string[]> {
    const accounts: string[] = [];
    try {
      const startLedger = await this.getRecentLedger(server);

      // Pre-filter at the RPC layer: only Smart_account_creation events whose
      // second topic equals our trader address. Saves us scanning every
      // Trader_Borrow / Trader_Repay event the AccountManager emits.
      const nameTopic = StellarSdk.xdr.ScVal.scvSymbol('Smart_account_creation').toXDR('base64');
      const userTopic = StellarSdk.nativeToScVal(userAddress, { type: 'address' }).toXDR('base64');

      let cursor: string | undefined;
      // Page through up to ~10k events. Stops early when RPC returns < limit.
      for (let page = 0; page < 50; page++) {
        const resp: any = await (server as any).getEvents({
          startLedger: cursor ? undefined : startLedger,
          cursor,
          filters: [
            {
              type: 'contract',
              contractIds: [CONTRACT_ADDRESSES.ACCOUNT_MANAGER],
              topics: [[nameTopic, userTopic]],
            },
          ],
          limit: 200,
        });

        const events = resp?.events ?? [];
        for (const ev of events) {
          try {
            const data = ev.value ? StellarSdk.scValToNative(ev.value) : null;
            if (data && typeof data === 'object' && (data as any).smart_account) {
              accounts.push((data as any).smart_account);
            }
          } catch {
            // skip malformed event
          }
        }

        if (events.length < 200) break;
        cursor = resp?.cursor ?? events[events.length - 1]?.pagingToken;
        if (!cursor) break;
      }
    } catch (error) {
      console.error('❌ Error getting accounts from events:', error);
    }

    return [...new Set(accounts)];
  }

  /**
   * Check if a smart account is active with improved error handling.
   *
   * The simulateTransaction source must be a real ed25519 G-address — passing
   * the AccountManager's contract C-address fails with "accountId is invalid"
   * inside the SDK's StrKey check. We use the trader's wallet address since
   * it's always available at the call site and is a valid G-address.
   */
  // Returns true/false when the contract gives a definitive answer, or null when
  // the status could not be determined (RPC/simulation error). The null case is
  // critical: callers must NOT treat "couldn't reach RPC" as "inactive", or a
  // transient error silently demotes a live account and discovery flips to a
  // different one on the next ledger tick.
  private static async isAccountActive(
    accountAddress: string,
    server: StellarSdk.rpc.Server,
    sourceUserAddress: string,
  ): Promise<boolean | null> {
    try {
      const contract = new StellarSdk.Contract(accountAddress);
      const call = contract.call('is_account_active');

      const transaction = new StellarSdk.TransactionBuilder(
        new StellarSdk.Account(sourceUserAddress, '0'),
        { fee: '100', networkPassphrase: NETWORK_PASSPHRASE }
      )
      .addOperation(call)
      .setTimeout(30)
      .build();

      const result = await server.simulateTransaction(transaction);

      // A simulation error is "undetermined", not "inactive".
      if ('error' in result && result.error) {
        console.warn('⚠️ Contract simulation failed for account:', accountAddress, result.error);
        return null;
      }

      if ('result' in result && result.result) {
        return StellarSdk.scValToNative(result.result.retval) === true;
      }

      console.warn('⚠️ No valid result from account activity check');
      return null;
    } catch (error) {
      console.error('❌ Error checking account active status:', error);
      return null;
    }
  }

  /**
   * Get recent ledger for event querying with better range
   */
  private static async getRecentLedger(server: StellarSdk.rpc.Server): Promise<number> {
    try {
      const latestLedger = await server.getLatestLedger();
      // Soroban testnet RPC retains events for ~7 days. Going back the full 7
      // days (17280*7) lands ~1 ledger BELOW the retention floor as the chain
      // advances, which makes getEvents throw "startLedger must be within the
      // ledger range". Use ~6 days so startLedger stays comfortably inside the
      // window. Accounts older than retention are recovered from AccountManager
      // persistent registry storage, not browser state or event scraping.
      const lookBackLedgers = 17280 * 6; // ~6 days of ledgers (5s blocks)
      const startLedger = Math.max(1, latestLedger.sequence - lookBackLedgers);
      return startLedger;
    } catch (error) {
      console.error('❌ Error getting recent ledger, using default:', error);
      return 1;
    }
  }

  /**
   * Extract margin account address from transaction result
   */
  private static extractMarginAccountAddress(result: any): string | null {
    try {
      
      // The create_account function returns the margin account address
      // Try to extract from returnValue first (newer Stellar SDK structure)
      if (result.returnValue) {
        try {
          const returnValue = StellarSdk.scValToNative(result.returnValue);
          if (returnValue && typeof returnValue === 'string') {
            return returnValue;
          }
        } catch (e) {
          console.warn('Failed to parse return value:', e);
        }
      }
      
      // Try result.result.retval (current SDK structure)
      if (result.result && !result.error && result.result.retval) {
        try {
          const returnValue = StellarSdk.scValToNative(result.result.retval);
          if (returnValue && typeof returnValue === 'string') {
            return returnValue;
          }
        } catch (e) {
          console.warn('Failed to parse result.result.retval:', e);
        }
      }
      
      // Try result.result.result (alternative structure)
      if (result.result && result.result.result && result.result.result.ok) {
        try {
          const returnValue = StellarSdk.scValToNative(result.result.result.ok);
          if (returnValue && typeof returnValue === 'string') {
            return returnValue;
          }
        } catch (e) {
          console.warn('Failed to parse result.result.result.ok:', e);
        }
      }
      
      // Alternative: try to extract from events
      if (result.events && result.events.length > 0) {
        for (const event of result.events) {
          if (event.type === 'contract') {
            try {
              // Parse the event data - look for Smart_account_creation event
              const eventTopic = event.value[0]; // Event topic
              const eventData = event.value[1]; // Event data
              
              if (eventTopic && StellarSdk.scValToNative(eventTopic) === 'Smart_account_creation') {
                const data = StellarSdk.scValToNative(eventData);
                
                if (data && typeof data === 'object' && data.smart_account) {
                  return data.smart_account;
                }
              }
            } catch (e) {
              console.warn('Failed to parse event data:', e);
            }
          }
        }
      }
      
      // If we can't extract the address, we'll have to implement a different approach
      console.warn('Could not extract margin account address from transaction result');
      return null;
    } catch (error) {
      console.error('Error extracting margin account address:', error);
      return null;
    }
  }

  /**
   * Poll transaction status until completion
   */
  private static async pollTransactionStatus(
    server: StellarSdk.rpc.Server,
    hash: string
  ): Promise<any> {
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      try {
        const result = await server.getTransaction(hash);
        
        if (result.status !== 'NOT_FOUND') {
          return result;
        }
      } catch (error: any) {
        console.error('Error polling transaction:', error);
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      attempts++;
    }
    
    throw new Error('Transaction timeout');
  }

  /**
   * Discover a trader's existing margin account directly from the chain. Reads
   * AccountManager persistent storage first, falling back to creation events,
   * and stores the resolved address in the runtime cache.
   *
   * @param userAddress - Trader's G-address.
   * @returns The newest active SmartAccount C-address, or null if none found.
   */
  static async discoverExistingAccount(userAddress: string): Promise<string | null> {
    return await this.getMarginAccountFromRegistry(userAddress);
  }

  /**
   * Summarize the runtime-cached margin account for UI display. Returns
   * `{ hasAccount: false }` until authoritative chain discovery completes.
   *
   * @param userAddress - Trader's G-address.
   */
  static getMarginAccountInfo(userAddress: string): {
    hasAccount: boolean;
    accountAddress?: string;
    isActive?: boolean;
    createdAt?: number;
  } {
    const account = this.getStoredMarginAccount(userAddress);
    
    if (!account) {
      return { hasAccount: false };
    }
    
    return {
      hasAccount: true,
      accountAddress: account.address,
      isActive: account.isActive,
      createdAt: account.createdAt
    };
  }

  /**
   * Truncate an address to `XXXXXX...XXXX` for compact display.
   *
   * @param address - Any Stellar address; empty input yields an empty string.
   */
  static formatAccountAddress(address: string): string {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  /**
   * Remove a trader's runtime-cached margin account (testing/reset). Does not
   * touch the chain; the account will be re-discovered.
   *
   * @param userAddress - Trader's G-address.
   */
  static clearMarginAccount(userAddress: string): void {
    this.marginAccountCache.delete(userAddress);
  }

  /**
   * Whether the AccountManager currently accepts a token as collateral
   * (`get_iscollateral_allowed`). Read-only simulation against the connected
   * wallet. The symbol is normalized first, so any UI alias is accepted.
   *
   * @param tokenSymbol - Token symbol or UI alias (XLM, USDC/BLUSDC, AQUSDC, SOUSDC).
   * @returns true if allowed; false on "not allowed", missing wallet, or any
   *          simulation error (fail-closed).
   */
  static async isCollateralAllowed(tokenSymbol: string): Promise<boolean> {
    try {
      const contractTokenSymbol = this.normalizeContractTokenSymbol(tokenSymbol);
      
      const userAddress = await getAddress();
      if (userAddress.error) {
        console.error('Failed to get user address for simulation');
        return false;
      }

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(userAddress.address);
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);
      
      const call = contract.call(
        'get_iscollateral_allowed',
        StellarSdk.nativeToScVal(contractTokenSymbol, { type: 'symbol' })
      );
      
      const transaction = new StellarSdk.TransactionBuilder(
        sourceAccount,
        { fee: '100', networkPassphrase: NETWORK_PASSPHRASE }
      )
      .addOperation(call)
      .setTimeout(30)
      .build();
      
      const result = await server.simulateTransaction(transaction);
      
      if ('result' in result && result.result) {
        const isAllowed = StellarSdk.scValToNative(result.result.retval) === true;
        return isAllowed;
      }
      
      console.warn('⚠️ Could not determine collateral status');
      return false;
    } catch (error) {
      console.error('❌ Error checking collateral allowed status:', error);
      return false;
    }
  }

  /**
   * Read the AccountManager's per-asset deposit cap (`get_max_asset_cap`) via
   * read-only simulation.
   *
   * @returns The cap as a number, or 0 when the wallet is unavailable, the view
   *          is unimplemented on this deployment, or the call errors. Callers
   *          treat 0 as "unknown — let the contract enforce limits on execute"
   *          rather than a hard block.
   */
  static async getMaxAssetCap(): Promise<number> {
    try {
      
      const userAddress = await getAddress();
      if (userAddress.error) {
        console.error('Failed to get user address for simulation');
        return 0;
      }

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(userAddress.address);
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);
      
      const call = contract.call('get_max_asset_cap');
      
      const transaction = new StellarSdk.TransactionBuilder(
        sourceAccount,
        { fee: '100', networkPassphrase: NETWORK_PASSPHRASE }
      )
      .addOperation(call)
      .setTimeout(30)
      .build();
      
      const result = await server.simulateTransaction(transaction);
      
      if ('result' in result && result.result) {
        const maxCap = StellarSdk.scValToNative(result.result.retval);
        return Number(maxCap) || 0;
      }
      
      console.warn('⚠️ Could not get max asset cap');
      return 0;
    } catch (error) {
      console.error('❌ Error getting max asset cap:', error);
      return 0;
    }
  }

  /**
   * Verify that the Registry has a contract address set for a token, via the
   * generic `get_token_address_for(symbol)` index. A missing address is the
   * most common cause of "deposit/borrow fails for no obvious reason" after a
   * fresh Registry deploy.
   *
   * Used to dispatch to per-token legacy getters (`get_xlm_contract_address`,
   * `get_usdc_contract_address`, `get_aquarius_usdc_addr`,
   * `get_soroswap_usdc_addr`) — the latter two no longer exist on the
   * deployed contract (superseded by this generic index), so this check
   * always reported AQUSDC/SOUSDC as "not configured" even when the Registry
   * had them set correctly, incorrectly blocking valid deposits/borrows for
   * those two tokens. `get_token_address_for` is generic across every
   * registered symbol, so one uniform call now covers all of them.
   *
   * @param tokenSymbol - Token symbol or UI alias; normalized before lookup.
   * @returns `{ configured: true }` when the address is set, otherwise
   *          `{ configured: false, error }` with an admin-actionable message.
   *          Fail-closed: unknown tokens and errors report not-configured.
   */
  static async isTokenConfigured(tokenSymbol: string): Promise<{ configured: boolean; error?: string }> {
    const contractTokenSymbol = this.normalizeContractTokenSymbol(tokenSymbol);
    try {

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const userAddress = await getAddress();
      if (userAddress.error) {
        return { configured: false, error: 'Failed to get user address' };
      }

      const sourceAccount = await server.getAccount(userAddress.address);
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.REGISTRY);

      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'get_token_address_for',
            StellarSdk.nativeToScVal(contractTokenSymbol, { type: 'symbol' })
          )
        )
        .setTimeout(30)
        .build();

      const simulationResult = await server.simulateTransaction(transaction);

      if ('error' in simulationResult && simulationResult.error) {
        console.warn(`⚠️ ${contractTokenSymbol} lookup failed in Registry:`, simulationResult.error);
        return {
          configured: false,
          error: `${contractTokenSymbol} token contract address not set in Registry. Please configure it first.`
        };
      }

      // get_token_address_for returns Option<Address> — None (no address
      // registered for this symbol) decodes to a falsy value, distinct from
      // a genuine simulation error above.
      if ('result' in simulationResult && simulationResult.result) {
        const decoded = StellarSdk.scValToNative(simulationResult.result.retval);
        if (decoded) {
          return { configured: true };
        }
      }

      return {
        configured: false,
        error: `${contractTokenSymbol} token contract address not set in Registry. Please configure it first.`
      };
    } catch (error: any) {
      console.error(`❌ Error checking token configuration:`, error);
      if (error.message?.includes('UnreachableCodeReached') || 
          error.message?.includes('Failed to fetch')) {
        return { 
          configured: false, 
          error: `${contractTokenSymbol} token not configured in Registry. Admin must set the token contract address.` 
        };
      }
      return { configured: false, error: error.message };
    }
  }

  /**
   * Deposit collateral into a margin account via AccountManager
   * `deposit_collateral_tokens`. Runs cheap pre-flight reads (Registry config,
   * collateral-allowed, optional asset cap) to surface admin/config problems
   * before prompting for a signature, then prepares → signs → submits → polls.
   * Uses 20x BASE_FEE for the resource-heavy transfer+accounting path.
   *
   * @param marginAccountAddress - Target SmartAccount C-address.
   * @param tokenSymbol - Token symbol or UI alias; normalized before use.
   * @param amountWad - Deposit amount as a u256 WAD (18-decimal) string.
   * @returns `{ success, hash? , error? }`. A failed pre-flight returns an
   *          admin-actionable `error` without signing anything.
   */
  static async depositCollateralTokens(
    marginAccountAddress: string,
    tokenSymbol: string,
    amountWad: string,
    // Pass the `nextSequence` from a just-confirmed prior same-account tx to
    // skip an RPC `getAccount()` read that isn't reliably fresh yet right
    // after that tx. See borrowTokensAttempt's doc comment / stellar-utils.ts's
    // isFootprintRaceError for the full explanation.
    knownSequence?: string
  ): Promise<{ success: boolean; hash?: string; error?: string; nextSequence?: string }> {
    return withFootprintRaceRetry(
      () => this.depositCollateralTokensAttempt(marginAccountAddress, tokenSymbol, amountWad, knownSequence),
      'Deposit',
    );
  }

  private static async depositCollateralTokensAttempt(
    marginAccountAddress: string,
    tokenSymbol: string,
    amountWad: string,
    knownSequence?: string
  ): Promise<{ success: boolean; hash?: string; error?: string; nextSequence?: string }> {
    try {
      const contractTokenSymbol = this.normalizeContractTokenSymbol(tokenSymbol);

      // Pre-flight checks

      // Check 0: Token configuration in Registry
      const configCheck = await this.isTokenConfigured(contractTokenSymbol);
      if (!configCheck.configured) {
        return {
          success: false,
          error: `⚠️ Configuration Issue: ${configCheck.error}\n\n` +
                 `The ${contractTokenSymbol} token contract address needs to be set in the Registry contract.\n` +
                 `Please contact the admin to configure the new Registry deployment.`
        };
      }

      // Check 1: Is collateral allowed for this token?
      const isCollateralAllowed = await this.isCollateralAllowed(contractTokenSymbol);
      if (!isCollateralAllowed) {
        return {
          success: false,
          error: `${contractTokenSymbol} is not allowed as collateral. Please ask the contract admin to enable this token first.`
        };
      }

      // Check 2: Read max asset cap when available. Some deployments omit get_max_asset_cap,
      // so do not hard-block here and let the contract enforce limits on execution.
      const maxAssetCap = await this.getMaxAssetCap();
      if (maxAssetCap === 0) {
        console.warn('⚠️ Max asset cap unavailable/zero from view call; continuing and deferring limit checks to contract execution.');
      }


      const userAddress = await getAddress();
      if (userAddress.error) {
        return {
          success: false,
          error: 'Failed to get user address'
        };
      }

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = knownSequence
        ? new StellarSdk.Account(userAddress.address, knownSequence)
        : await server.getAccount(userAddress.address);

      // Create contract instance for AccountManager
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);

      // Build the transaction to call deposit_collateral_tokens with higher fee
      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: (parseInt(StellarSdk.BASE_FEE) * 20).toString(), // 20x base fee for deposit operations
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'deposit_collateral_tokens',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
            StellarSdk.nativeToScVal(contractTokenSymbol, { type: 'symbol' }),
            StellarSdk.nativeToScVal(amountWad, { type: 'u256' })
          )
        )
        .setTimeout(30)
        .build();

      // sourceAccount is mutated in place by .build() (sequence incremented
      // by the tx it just consumed) — capture it now so a caller chaining
      // straight into another same-account tx can skip re-reading it.
      const nextSequence = sourceAccount.sequenceNumber();

      const preparedTx = await server.prepareTransaction(transaction);

      // Sign the transaction
      const signResult = await signTransaction(preparedTx.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      const signedTx = StellarSdk.TransactionBuilder.fromXDR(
        signResult.signedTxXdr,
        NETWORK_PASSPHRASE
      );

      // Wallet just returned a signed tx — switch the progress modal from
      // "waiting on you" to an animated "confirming on-chain" fill.
      markTxSubmitted();

      let result = await server.sendTransaction(signedTx as StellarSdk.Transaction);
      result = await resubmitOnTryAgainLater(server, signedTx as StellarSdk.Transaction, result, 'Deposit');

      if (result.status === 'PENDING') {
        const finalResult = await this.pollTransactionStatus(server, result.hash);

        if (finalResult.status === 'SUCCESS') {
          return {
            success: true,
            hash: result.hash,
            nextSequence,
          };
        } else {
          const reason = describeFailedTx(finalResult);
          return {
            success: false,
            error: `Deposit transaction failed with status: ${finalResult.status}${reason ? `: ${reason}` : ''}`
          };
        }
      } else if (result.status === 'ERROR') {
        const resultCode = describeSendError(result);
        console.error(`❌ Deposit transaction failed immediately with ERROR status (${resultCode})`);
        return {
          success: false,
          error: resultCode !== 'unknown'
            ? `Deposit transaction failed with result: ${resultCode}`
            : `Deposit transaction failed immediately with status: ${result.status}`,
        };
      } else {
        return {
          success: false,
          error: `Deposit transaction failed immediately with status: ${result.status}`
        };
      }
    } catch (error: any) {
      console.error('❌ Error depositing collateral tokens:', error);
      return {
        success: false,
        error: error?.message || 'Failed to deposit collateral tokens'
      };
    }
  }

  /**
   * Withdraw collateral from a margin account back to the trader's wallet via
   * AccountManager `withdraw_collateral_balance` (50x BASE_FEE).
   *
   * Budget handling: this op routinely trips a budget-like error at the
   * cheap pre-check `simulateTransaction` call even though the real
   * `prepareTransaction` (which re-simulates with the actual submit-time
   * footprint) goes on to succeed — so a budget-class simulation error is
   * logged and prepare is attempted anyway. A PREPARE failure is not given
   * the same benefit of the doubt: prepare is what attaches the Soroban
   * resource footprint the network requires for this to submit at all, so a
   * prepare failure aborts with a user-facing message instead of sending a
   * transaction that has no footprint attached and cannot succeed. A
   * genuine contract error (e.g. Risk Engine blocking the withdraw while
   * debt is open) also aborts with a user-facing message.
   *
   * @param marginAccountAddress - Source SmartAccount C-address.
   * @param tokenSymbol - Token symbol or UI alias; normalized before use.
   * @param amountWad - Withdraw amount as a u256 WAD (18-decimal) string.
   * @returns `{ success, hash?, error? }`; errors are mapped to friendly
   *          'withdraw'-context messages.
   */
  static async withdrawCollateralBalance(
    marginAccountAddress: string,
    tokenSymbol: string,
    amountWad: string
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
    try {
      const contractTokenSymbol = this.normalizeContractTokenSymbol(tokenSymbol);

      // Pre-flight checks
      
      // Check: Is collateral allowed for this token?
      const isCollateralAllowed = await this.isCollateralAllowed(contractTokenSymbol);
      if (!isCollateralAllowed) {
        return {
          success: false,
          error: `${contractTokenSymbol} is not allowed as collateral. Please ask the contract admin to enable this token first.`
        };
      }

      const userAddress = await getAddress();
      if (userAddress.error) {
        return {
          success: false,
          error: 'Failed to get user address'
        };
      }

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(userAddress.address);
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);

      // Use 50x base fee - higher fee for complex operation
      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: (parseInt(StellarSdk.BASE_FEE) * 50).toString(),
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'withdraw_collateral_balance',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
            StellarSdk.nativeToScVal(contractTokenSymbol, { type: 'symbol' }),
            StellarSdk.nativeToScVal(amountWad, { type: 'u256' })
          )
        )
        .setTimeout(30)
        .build();

      const simulationResult = await server.simulateTransaction(transaction);

      // Check if simulation failed with budget error - this is expected for complex operations
      if ('error' in simulationResult && simulationResult.error) {
        const simulationText = JSON.stringify(simulationResult.error);
        const isBudgetLikeError =
          simulationText.includes('Budget') ||
          simulationText.includes('ExceededLimit') ||
          simulationText.includes('resources') ||
          simulationText.includes('resource');

        if (!isBudgetLikeError) {
          // Not a budget error - this is a real contract error
          return {
            success: false,
            error: this.formatUserFacingContractError(simulationResult.error, 'withdraw')
          };
        }

        // Budget-like error is expected for complex withdrawals - attempt to prepare anyway
        console.warn('⚠️ Withdraw simulation returned budget-like error; attempting transaction preparation anyway (this is normal for complex operations).');
      }

      let preparedTx: StellarSdk.Transaction;
      try {
        preparedTx = await server.prepareTransaction(transaction);
      } catch (prepareError: any) {
        // Unlike the simulation-only budget error above, a prepare FAILURE is
        // not safe to shrug off: prepareTransaction is what attaches the
        // Soroban resource footprint (readOnly/readWrite ledger keys,
        // instructions, fee) to the tx's `ext` field. Without it,
        // TransactionBuilder.build() leaves `ext` as TransactionExt(0, Void)
        // — no Soroban extension at all — which the network rejects outright
        // for an InvokeHostFunction operation (this always touches many
        // ledger entries; declaring none of them is invalid, not "usually
        // fine"). Sending that envelope anyway (the previous behavior here)
        // wasted a real signature + a real submitted tx on a submission that
        // cannot succeed. Fail cleanly instead, matching the borrow path's
        // handling of the same failure mode below.
        console.error('❌ Withdraw preparation failed:', prepareError);
        return {
          success: false,
          error: this.formatUserFacingContractError(prepareError?.message || prepareError, 'withdraw'),
        };
      }

      const signResult = await signTransaction(preparedTx.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      const signedTx = StellarSdk.TransactionBuilder.fromXDR(
        signResult.signedTxXdr,
        NETWORK_PASSPHRASE
      );

      // Wallet just returned a signed tx — switch the progress modal from
      // "waiting on you" to an animated "confirming on-chain" fill.
      markTxSubmitted();

      const result = await server.sendTransaction(signedTx as StellarSdk.Transaction);

      if (result.status === 'PENDING') {
        const finalResult = await this.pollTransactionStatus(server, result.hash);
        if (finalResult.status === 'SUCCESS') {
          return {
            success: true,
            hash: result.hash
          };
        }
        return {
          success: false,
          error: `Withdraw collateral failed with status: ${finalResult.status}`
        };
      }

      return {
        success: false,
        error: `Withdraw collateral failed immediately with status: ${result.status}`
      };
    } catch (error: any) {
      console.error('❌ Error withdrawing collateral tokens:', error);
      return {
        success: false,
        error: this.formatUserFacingContractError(error?.message || error, 'withdraw')
      };
    }
  }

  /**
   * Borrow from a lending pool into a margin account via AccountManager
   * `borrow` (50x BASE_FEE).
   *
   * Verifies the account is active, then handles the borrow path's quirk that a
   * budget-like simulation error can still assemble/prepare successfully — in
   * that case it assembles from the sim result rather than aborting. Genuine
   * "borrow not allowed" failures (Risk Engine health/debt-limit, missing
   * oracle price, treasury trustline) are mapped to specific messages via
   * {@link parseBorrowNotAllowedMessage}.
   *
   * @param marginAccountAddress - Borrowing SmartAccount C-address.
   * @param tokenSymbol - Token symbol or UI alias; normalized before use.
   * @param borrowAmountWad - Borrow amount as a u256 WAD (18-decimal) string.
   * @returns `{ success, hash?, error? }`.
   */
  /**
   * Decodes a failed `getTransaction` result's diagnostic events into a
   * human-readable string (e.g. `scecExceededLimit: operation byte-write
   * resources exceeds amount specified (1920, 1880)`). The resource
   * footprint `prepareTransaction` computes from simulation can go stale by
   * the time the signed tx actually executes — e.g. a same-asset repay whose
   * amount exactly clears the debt can tip into a bigger "remove the ledger
   * entry" write path if a little more interest accrues in the gap while the
   * wallet popup is open — and the host then rejects the tx with
   * scecExceededLimit instead of a business-logic error. Callers need this
   * decoded text (not just `status: 'FAILED'`) to detect that case via
   * {@link isFootprintRaceError} and retry with a fresh simulation.
   */
  static async borrowTokens(
    marginAccountAddress: string,
    tokenSymbol: string,
    borrowAmountWad: string,
    // Pass the `nextSequence` from a just-confirmed prior same-account tx
    // (e.g. one-click's first borrow leg, or a dual-borrow's atomic
    // deposit+borrow) to skip the RPC `getAccount()` read entirely on the
    // first attempt. See borrowTokensAttempt's doc comment: a fresh RPC
    // read is not reliably fresh enough right after a same-account tx —
    // confirmed live hitting `txBadSeq` on every one of 3 growing-backoff
    // retries, so retrying a stale RPC read is not itself a fix. Only the
    // FIRST attempt uses it — a failed attempt invalidates the assumption
    // it was built on, so retries fall back to a fresh `getAccount()`.
    knownSequence?: string
  ): Promise<{ success: boolean; hash?: string; error?: string; nextSequence?: string }> {
    let firstAttempt = true;
    return withFootprintRaceRetry(() => {
      // Only the FIRST attempt uses knownSequence — a failed attempt
      // invalidates the assumption it was built on, so retries fall back to
      // a fresh getAccount() (handled inside borrowTokensAttempt itself).
      const seq = firstAttempt ? knownSequence : undefined;
      firstAttempt = false;
      return this.borrowTokensAttempt(marginAccountAddress, tokenSymbol, borrowAmountWad, seq);
    }, 'Borrow');
  }

  private static async borrowTokensAttempt(
    marginAccountAddress: string,
    tokenSymbol: string,
    borrowAmountWad: string,
    // When the caller already knows the account's post-prior-tx sequence
    // (e.g. the previous leg of a dual-borrow/one-click just confirmed),
    // pass it here instead of re-fetching via `getAccount()`. See this
    // method's `nextSequence` return value doc comment for why — a fresh
    // RPC read is NOT a reliable source of truth for "the very next
    // sequence number" immediately after a same-account tx confirms.
    knownSequence?: string
  ): Promise<{ success: boolean; hash?: string; error?: string; nextSequence?: string }> {
    try {
      const contractTokenSymbol = this.normalizeContractTokenSymbol(tokenSymbol);

      // Same pre-flight depositAndBorrow already runs — a borrow this
      // standalone path issues (dual-borrow's 2nd leg, one-click's b1/b2,
      // Pro mode's single borrow) is just as capable of pushing the target
      // pool past its 95% utilization cap, which traps with an opaque
      // generic HostError (see checkPoolLiquidity's doc comment) instead of
      // a message a user can act on.
      const borrowAmountTokens = Number(borrowAmountWad) / 1e18;
      const liquidityCheck = await this.checkPoolLiquidity(contractTokenSymbol, borrowAmountTokens);
      if (!liquidityCheck.ok) {
        return { success: false, error: liquidityCheck.error };
      }

      const userAddress = await getAddress();
      if (userAddress.error) {
        return {
          success: false,
          error: 'Failed to get user address'
        };
      }

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      // `getAccount()` reads the account's sequence off whichever RPC node
      // answers the request. Immediately after a same-account tx confirms
      // (e.g. this leg's own retry, or a prior leg in the same flow), a
      // multi-node RPC endpoint can keep answering with a STALE sequence no
      // matter how long or how many times you retry — confirmed live: 3
      // outer attempts with growing 2s/4s backoff, PLUS inner
      // TRY_AGAIN_LATER resubmits, all still hit `txBadSeq`. Waiting longer
      // doesn't fix a wrong answer. When the caller can supply the sequence
      // directly (because IT just confirmed the prior tx and knows for a
      // fact what comes next), skip the RPC read entirely.
      const sourceAccount = knownSequence
        ? new StellarSdk.Account(userAddress.address, knownSequence)
        : await server.getAccount(userAddress.address);

      // Create contract instance for AccountManager
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);
      
      // Pre-check: Verify margin account exists and is active
      
      try {
        const isActive = await this.testContractInteraction(marginAccountAddress);
        if (!isActive) {
          return {
            success: false,
            error: 'Margin account is not active or accessible. Please check account status.'
          };
        }
      } catch (verifyError: any) {
        console.warn('⚠️ Could not verify margin account state:', verifyError.message);
        // Continue anyway, but log the warning
      }
      
      // SIMPLIFIED: Use consistent parameters like deposit operation
      
      // Use same fee structure as successful deposit operation
      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: (parseInt(StellarSdk.BASE_FEE) * 50).toString(), // 50x base fee (more than deposit's 20x)
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'borrow',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
            StellarSdk.nativeToScVal(borrowAmountWad, { type: 'u256' }),
            StellarSdk.nativeToScVal(contractTokenSymbol, { type: 'symbol' })
          )
        )
        .setTimeout(60) // Reasonable timeout like successful operations
        .build();

      // `TransactionBuilder.build()` mutates `sourceAccount` in place,
      // incrementing its sequence to the value this tx just consumed — so
      // this is the exact sequence the account will have once this tx
      // confirms. Captured now (works whether `sourceAccount` came from
      // `knownSequence` or a fresh `getAccount()`) so a caller chaining
      // straight into another same-account tx (a dual-borrow/one-click's
      // next leg) can pass it as that call's `knownSequence` instead of
      // racing an RPC re-read.
      const nextSequence = sourceAccount.sequenceNumber();

      const simulationResult = await server.simulateTransaction(transaction);
      if ('error' in simulationResult && simulationResult.error) {
        const simulationText = JSON.stringify(simulationResult.error);
        const isBudgetLikeError =
          simulationText.includes('Budget') ||
          simulationText.includes('ExceededLimit') ||
          simulationText.includes('resources') ||
          simulationText.includes('resource');

        if (!isBudgetLikeError) {
          return {
            success: false,
            error: this.parseBorrowNotAllowedMessage(simulationResult, contractTokenSymbol),
          };
        }

        // Some borrow paths can fail pre-simulation on budget but still pass when assembled/prepared.
        console.warn('⚠️ Borrow simulation returned a budget-like error; attempting transaction assembly/prepare anyway.');
      }

      let preparedTx: StellarSdk.Transaction;
      try {
        // Always re-simulate here rather than reusing `simulationResult` (the
        // pre-check above) to build the footprint, so it's computed as close
        // to submit-time as possible. `prepareTransaction` simulates fresh
        // internally.
        preparedTx = await server.prepareTransaction(transaction);

        // Pad the simulated refundable resource fee with a small safety
        // margin. The simulation's estimate can undershoot the real
        // execution's event/ledger-write-rent cost by a tiny amount (seen
        // live: needed 4688 stroops, simulation only allocated 4500) — e.g.
        // when interest accrual between simulate and submit nudges a write's
        // byte size. Falling short here fails the whole tx post-hoc with
        // "refundable resource fee was not sufficient" (scecExceededLimit)
        // even though every contract call already succeeded. The margin
        // added is a few thousand stroops (a fraction of a cent) — negligible
        // next to this call's existing 50x-BASE_FEE inclusion fee.
        // Bump the OVERALL tx fee by the same margin, not just the resourceFee
        // sub-component — the two must satisfy fee >= resourceFee, and only
        // padding resourceFee could push it past the original fee, producing
        // an invalid (fee < resourceFee) transaction.
        const RESOURCE_FEE_SAFETY_MARGIN_STROOPS = BigInt(5000);
        const currentSorobanData = preparedTx.toEnvelope().v1().tx().ext().sorobanData();
        const currentResourceFee = BigInt(currentSorobanData.resourceFee().toString());
        const currentTotalFee = BigInt(preparedTx.fee);
        const paddedSorobanData = new StellarSdk.SorobanDataBuilder(currentSorobanData)
          .setResourceFee((currentResourceFee + RESOURCE_FEE_SAFETY_MARGIN_STROOPS).toString())
          .build();
        preparedTx = StellarSdk.TransactionBuilder.cloneFrom(preparedTx, {
          fee: (currentTotalFee + RESOURCE_FEE_SAFETY_MARGIN_STROOPS).toString(),
        })
          .setSorobanData(paddedSorobanData)
          .build();
      } catch (prepareError: any) {
        console.error('❌ Borrow preparation failed:', prepareError);
        return {
          success: false,
          error: this.parseBorrowNotAllowedMessage(prepareError, contractTokenSymbol),
        };
      }
      
      // Sign the transaction
      const signResult = await signTransaction(preparedTx.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      const signedTx = StellarSdk.TransactionBuilder.fromXDR(
        signResult.signedTxXdr,
        NETWORK_PASSPHRASE
      );

      // Wallet just returned a signed tx — switch the progress modal from
      // "waiting on you" to an animated "confirming on-chain" fill.
      markTxSubmitted();

      let result = await server.sendTransaction(signedTx as StellarSdk.Transaction);

      // TRY_AGAIN_LATER means the RPC's submission queue declined this
      // attempt without judging the transaction itself (unlike `ERROR`, a
      // real rejection) — seen live on a dual-borrow/one-click's second
      // borrow, submitted moments after the first leg confirmed, while the
      // RPC node is still catching up with that prior ledger close. The
      // already-signed tx is still valid, so resubmitting the SAME signed
      // tx after a short pause (not rebuilding) is the correct recovery.
      for (let attempt = 0; result.status === 'TRY_AGAIN_LATER' && attempt < 3; attempt++) {
        console.warn(`⚠️ Borrow submission returned TRY_AGAIN_LATER; resubmitting (attempt ${attempt + 1}/3).`);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        result = await server.sendTransaction(signedTx as StellarSdk.Transaction);
      }

      if (result.status === 'PENDING') {
        const finalResult = await this.pollTransactionStatus(server, result.hash);
        
        if (finalResult.status === 'SUCCESS') {
          return {
            success: true,
            hash: result.hash,
            nextSequence
          };
        } else {
          // NOT necessarily a real failure yet: this is exactly the
          // read-after-write footprint race stellar-utils.ts's
          // isFootprintRaceError exists for (see its doc comment) —
          // borrowTokens() transparently
          // retries once when this matches, which is the common case for a
          // dual borrow's second leg. console.warn, not .error: in dev mode
          // Next.js's overlay intercepts every console.error as a crash
          // popup, which falsely alarmed the user for a case that silently
          // self-heals on retry. A genuine, unretried final failure still
          // reaches the user via the caller's own toast.error(...).
          console.warn('⚠️ Borrow transaction not confirmed after polling (may be retried):', finalResult);
          return {
            success: false,
            error: this.parseBorrowNotAllowedMessage(finalResult, contractTokenSymbol),
          };
        }
      } else if (result.status === 'ERROR') {
        const resultCode = describeSendError(result);
        console.error(`❌ Borrow transaction failed immediately with ERROR status (${resultCode})`);
        console.error('Error details:', {
          resultCode,
          diagnosticEvents: result.diagnosticEvents
        });

        // txBadSeq (stale sequence number — see describeSendError's doc
        // comment) is the common case for a dual-borrow/one-click second
        // leg submitted right after the first leg's tx. Surface it through
        // the same footprint-race text pattern so borrowTokens()'s outer
        // retry (which rebuilds with a freshly-fetched account/sequence)
        // catches it, instead of an opaque one-shot failure.
        const errorMessage =
          resultCode !== 'unknown'
            ? `Transaction failed with result: ${resultCode}`
            : this.parseBorrowNotAllowedMessage(result, contractTokenSymbol);

        return {
          success: false,
          error: errorMessage
        };
      } else {
        console.error('❌ Borrow transaction failed with unexpected status:', result.status);
        return {
          success: false,
          error: `Borrow transaction failed with status: ${result.status}`
        };
      }
    } catch (error: any) {
      console.error('❌ Error borrowing tokens:', error);
      return {
        success: false,
        error: error?.message || 'Failed to borrow tokens'
      };
    }
  }

  /**
   * One-time admin bootstrap: sets the max asset cap and enables XLM, BLUSDC,
   * AQUSDC and SOUSDC as collateral on the AccountManager.
   *
   * Each step is a separate signed transaction (Soroban allows one host-fn op
   * per tx), executed sequentially with a fresh sequence number and a 1s gap to
   * avoid sequence collisions. Aborts on the first failed step. Intended for
   * admin/dev setup, not the trader flow — the connected wallet must be the
   * contract admin or the calls will revert.
   *
   * @returns `{ success, error?, transactionHashes? }` listing the hashes of
   *          the steps that completed.
   */
  static async setupContractConfiguration(): Promise<{ success: boolean; error?: string; transactionHashes?: string[] }> {
    try {
      
      const userAddress = await getAddress();
      if (userAddress.error) {
        return {
          success: false,
          error: 'Failed to get user address'
        };
      }

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);
      const transactionHashes: string[] = [];
      
      // Define setup operations
      const setupOperations = [
        {
          name: 'Set max asset cap',
          call: contract.call(
            'set_max_asset_cap',
            StellarSdk.nativeToScVal('10', { type: 'u256' })
          )
        },
        {
          name: 'Allow XLM as collateral',
          call: contract.call(
            'set_iscollateral_allowed',
            StellarSdk.nativeToScVal('XLM', { type: 'symbol' })
          )
        },
        {
          name: 'Allow BLUSDC as collateral',
          call: contract.call(
            'set_iscollateral_allowed',
            StellarSdk.nativeToScVal('BLUSDC', { type: 'symbol' })
          )
        },
        {
          name: 'Allow AQUSDC as collateral',
          call: contract.call(
            'set_iscollateral_allowed',
            StellarSdk.nativeToScVal('AQUSDC', { type: 'symbol' })
          )
        },
        {
          name: 'Allow SOUSDC as collateral',
          call: contract.call(
            'set_iscollateral_allowed',
            StellarSdk.nativeToScVal('SOUSDC', { type: 'symbol' })
          )
        }
      ];

      // Execute each operation in a separate transaction
      for (const operation of setupOperations) {
        try {
          
          // Get fresh account for each transaction
          const sourceAccount = await server.getAccount(userAddress.address);
          
          const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
            fee: StellarSdk.BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
          })
            .addOperation(operation.call)
            .setTimeout(30)
            .build();

          const preparedTx = await server.prepareTransaction(transaction);
          
          const signResult = await signTransaction(preparedTx.toXDR(), {
            networkPassphrase: NETWORK_PASSPHRASE,
          });

          const signedTx = StellarSdk.TransactionBuilder.fromXDR(
            signResult.signedTxXdr,
            NETWORK_PASSPHRASE
          );

          // Wallet just returned a signed tx — switch the progress modal from
          // "waiting on you" to an animated "confirming on-chain" fill.
          markTxSubmitted();

          const result = await server.sendTransaction(signedTx as StellarSdk.Transaction);
          
          if (result.status === 'PENDING') {
            const finalResult = await this.pollTransactionStatus(server, result.hash);
            
            if (finalResult.status === 'SUCCESS') {
              transactionHashes.push(result.hash);
            } else {
              console.error(`❌ ${operation.name} failed with status: ${finalResult.status}`);
              return {
                success: false,
                error: `${operation.name} failed with status: ${finalResult.status}`
              };
            }
          } else {
            console.error(`❌ ${operation.name} failed immediately with status: ${result.status}`);
            return {
              success: false,
              error: `${operation.name} failed immediately with status: ${result.status}`
            };
          }
          
          // Wait between transactions to avoid sequence number issues
          await new Promise(resolve => setTimeout(resolve, 1000));
          
        } catch (operationError: any) {
          console.error(`❌ Error in ${operation.name}:`, operationError);
          return {
            success: false,
            error: `${operation.name} failed: ${operationError?.message || 'Unknown error'}`
          };
        }
      }

      return {
        success: true
      };
      
    } catch (error: any) {
      console.error('❌ Error setting up contract configuration:', error);
      return {
        success: false,
        error: error?.message || 'Failed to setup contract configuration'
      };
    }
  }

  /**
   * Lightweight liveness probe for a margin account: simulates
   * `is_account_active` and reports whether the call simulated without error.
   * Used as a borrow pre-check.
   *
   * @param marginAccountAddress - SmartAccount C-address to probe.
   * @returns true if the simulation succeeded (account reachable/active),
   *          false on any error or missing wallet.
   */
  static async testContractInteraction(marginAccountAddress: string): Promise<boolean> {
    try {
      
      const userAddress = await getAddress();
      if (userAddress.error) return false;

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(userAddress.address);
      
      // Simple test: check if margin account is active
      const contract = new StellarSdk.Contract(marginAccountAddress);
      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('is_account_active'))
        .setTimeout(30)
        .build();

      const result = await server.simulateTransaction(transaction);
      return !('error' in result);
    } catch (error) {
      console.warn('🔧 Contract test failed:', error);
      return false;
    }
  }

  /**
   * Read a margin account's current per-token debt.
   *
   * Lists the account's borrowed symbols (`get_all_borrowed_tokens`), then reads
   * each one's `get_borrowed_token_debt` (a WAD value, divided by 1e18 here) and
   * prices it via the on-chain Reflector oracle so event-driven callers see live
   * USD values without re-running the store's recompute. USDC/BLUSDC aliases are
   * mirrored so both keys stay populated for the UI.
   *
   * @param marginAccountAddress - SmartAccount C-address (validated for shape).
   * @returns `{ success, data?, error? }` where `data` maps token symbol →
   *          `{ amount, usdValue }`; an account with no debt yields `{}`.
   */
  static async getCurrentBorrowedBalances(
    marginAccountAddress: string,
    options: { includePrices?: boolean } = {},
  ): Promise<{ success: boolean; data?: Record<string, { amount: string; usdValue: string }>; error?: string }> {
    try {
      // Validate address before making any blockchain calls
      if (!marginAccountAddress || typeof marginAccountAddress !== 'string' || marginAccountAddress.length < 10) {
        return {
          success: false,
          error: 'Invalid margin account address'
        };
      }
      
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      // Read-only sim source: connected wallet on client, public fallback on
      // server / pre-connect (source doesn't affect the view result).
      const sourceAddr = await getReadSourceAddress();
      const sourceAccount = await server.getAccount(sourceAddr);
      const contract = new StellarSdk.Contract(marginAccountAddress);

      // Get all borrowed tokens
      const getAllBorrowedTokensTx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'get_all_borrowed_tokens'
          )
        )
        .setTimeout(30)
        .build();
      
      // prepareTransaction already simulates; doing prepare + simulate doubled
      // every read RPC. A view call only needs one direct simulation.
      const simulationResult = await server.simulateTransaction(getAllBorrowedTokensTx);
      
      if ('error' in simulationResult) {
        console.error('❌ Failed to get borrowed tokens:', simulationResult.error);
        return {
          success: false,
          error: 'Failed to get borrowed tokens from margin account'
        };
      }
      
      if (!('result' in simulationResult) || !simulationResult.result) {
        return { success: true, data: {} };
      }

      const borrowedTokensRaw = StellarSdk.scValToNative(simulationResult.result.retval) as any;
      const borrowedTokens = Array.isArray(borrowedTokensRaw)
        ? borrowedTokensRaw.map((t) => String(t))
        : [];

      if (borrowedTokens.length === 0) {
        return { success: true, data: {} };
      }

      const borrowedBalances: Record<string, { amount: string; usdValue: string }> = {};
      const sourceSequence = sourceAccount.sequenceNumber();

      // Every token debt is independent. Run the simulations (and optional
      // price lookups) concurrently instead of one token at a time.
      const rows = await Promise.allSettled(borrowedTokens.map(async (token) => {
          const readSource = new StellarSdk.Account(sourceAddr, sourceSequence);
          const getBalanceTx = new StellarSdk.TransactionBuilder(readSource, {
            fee: StellarSdk.BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
          })
            .addOperation(
              contract.call(
                'get_borrowed_token_debt',
                StellarSdk.nativeToScVal(token, { type: 'symbol' })
              )
            )
            .setTimeout(30)
            .build();
          
          const balanceResult = await server.simulateTransaction(getBalanceTx);
          
          if (!('error' in balanceResult) && 'result' in balanceResult && balanceResult.result) {
            const balanceWad = StellarSdk.scValToNative(balanceResult.result.retval) as string;
            const balanceNumber = parseFloat(balanceWad) / Math.pow(10, 18); // Convert from WAD

            if (balanceNumber > 0) {
              const price = options.includePrices === false ? 0 : await fetchTokenPrice(token);
              const usdValue = (balanceNumber * price).toFixed(2);
              return { token, balance: {
                amount: balanceNumber.toFixed(6),
                usdValue
              } };
            }
          }
          return null;
      }));

      rows.forEach((row, index) => {
        if (row.status === 'fulfilled' && row.value) {
          borrowedBalances[row.value.token] = row.value.balance;
        } else if (row.status === 'rejected') {
          console.warn(`⚠️ Failed to get balance for token ${borrowedTokens[index]}:`, row.reason);
        }
      });
      
      return {
        success: true,
        data: this.addUsdcAliases(borrowedBalances)
      };
      
    } catch (error: any) {
      console.error('❌ Error getting borrowed balances:', error);
      return {
        success: false,
        error: error?.message || 'Failed to get borrowed balances'
      };
    }
  }

  /**
   * Read the exact outstanding debt for one token at full WAD precision.
   *
   * The repay flow needs the unrounded value: passing a human-rounded amount can
   * overshoot the live debt (interest accrues every ledger) and trap on-chain.
   *
   * @param marginAccountAddress - SmartAccount C-address (validated for shape).
   * @param tokenSymbol - Token symbol or UI alias; normalized before the read.
   * @returns `{ success, debtWad?, amount?, error? }` — `debtWad` is the raw
   *          u256 WAD string; `amount` is the same value divided by 1e18 for
   *          display. Errors are mapped with 'repay' context.
   */
  static async getBorrowedTokenDebtWad(
    marginAccountAddress: string,
    tokenSymbol: string
  ): Promise<{ success: boolean; debtWad?: string; amount?: string; error?: string }> {
    try {
      if (!marginAccountAddress || typeof marginAccountAddress !== 'string' || marginAccountAddress.length < 10) {
        return { success: false, error: 'Invalid margin account address' };
      }

      const contractTokenSymbol = this.normalizeContractTokenSymbol(tokenSymbol);
      const userAddress = await getAddress();
      if (userAddress.error) {
        return { success: false, error: 'Failed to get user address' };
      }

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(userAddress.address);
      const contract = new StellarSdk.Contract(marginAccountAddress);

      const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'get_borrowed_token_debt',
            StellarSdk.nativeToScVal(contractTokenSymbol, { type: 'symbol' })
          )
        )
        .setTimeout(30)
        .build();

      const preparedTx = await server.prepareTransaction(tx);
      const sim = await server.simulateTransaction(preparedTx);

      if ('error' in sim || !('result' in sim) || !sim.result?.retval) {
        return { success: false, error: 'Failed to fetch token debt' };
      }

      const debtRaw = StellarSdk.scValToNative(sim.result.retval);
      const debtWad = debtRaw?.toString?.() ?? String(debtRaw ?? '0');
      const debtAmount = (parseFloat(debtWad) / Math.pow(10, 18)).toFixed(7);

      return {
        success: true,
        debtWad,
        amount: debtAmount,
      };
    } catch (error: any) {
      return {
        success: false,
        error: this.formatUserFacingContractError(error?.message || error, 'repay'),
      };
    }
  }

  /**
   * Read how much of `tokenSymbol` the margin (smart) account actually holds,
   * returned as a u256 WAD string (token is 7-dec stroops → WAD = stroops * 1e11).
   *
   * Repay pulls the funds FROM the smart account, so a "repay all" must be capped
   * at this — the accrued-interest portion of the debt isn't held by the account,
   * and repaying the raw debt overspends → Error(Contract,#10) "balance is not
   * sufficient to spend". Returns null on any read failure (caller then doesn't cap).
   */
  static async getMarginAccountTokenBalanceWad(
    marginAccountAddress: string,
    tokenSymbol: string,
  ): Promise<string | null> {
    try {
      const norm = this.normalizeContractTokenSymbol(tokenSymbol);
      const tokenIdBySymbol: Record<string, string> = {
        XLM: CONTRACT_ADDRESSES.BLEND_XLM,
        USDC: CONTRACT_ADDRESSES.BLEND_USDC,
        AQUSDC: CONTRACT_ADDRESSES.AQUARIUS_USDC,
        SOUSDC: CONTRACT_ADDRESSES.SOROSWAP_USDC,
      };
      const tokenId = tokenIdBySymbol[norm];
      if (!tokenId) return null;

      const userAddress = await getAddress();
      if (userAddress.error || !userAddress.address) return null;

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(userAddress.address);
      const token = new StellarSdk.Contract(tokenId);
      const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(token.call('balance', StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' })))
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if ('error' in sim || !('result' in sim) || !sim.result?.retval) return null;
      const stroops = BigInt(StellarSdk.scValToNative(sim.result.retval).toString());
      return (stroops * BigInt(100_000_000_000)).toString(); // stroops (1e7) → WAD (1e18)
    } catch {
      return null;
    }
  }

  /**
   * Read a margin account's collateral holdings, priced in USD.
   *
   * Lists collateral symbols (`get_all_collateral_tokens`), reads each
   * `get_collateral_token_balance` (WAD ÷ 1e18) and prices it via the oracle,
   * then merges in farm-tracking collateral (assets deployed to external
   * venues, tracked separately on-chain) and mirrors USDC/BLUSDC aliases.
   *
   * @param marginAccountAddress - SmartAccount C-address (validated for shape).
   * @returns `{ success, data?, error? }` where `data` maps token symbol →
   *          `{ amount, usdValue }`; empty collateral yields `{}`.
   */
  static async getCollateralBalances(
    marginAccountAddress: string,
    options: { includeFarm?: boolean; includePrices?: boolean } = {},
  ): Promise<{ success: boolean; data?: Record<string, { amount: string; usdValue: string }>; error?: string }> {
    try {
      if (!marginAccountAddress || typeof marginAccountAddress !== 'string' || marginAccountAddress.length < 10) {
        return {
          success: false,
          error: 'Invalid margin account address'
        };
      }

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      // Read-only sim source: wallet on client, public fallback on server / pre-connect.
      const sourceAddr = await getReadSourceAddress();
      const sourceAccount = await server.getAccount(sourceAddr);
      const contract = new StellarSdk.Contract(marginAccountAddress);

      const listTx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('get_all_collateral_tokens'))
        .setTimeout(30)
        .build();

      const listSim = await server.simulateTransaction(listTx);

      if ('error' in listSim) {
        console.error('❌ Failed to get collateral token list:', listSim.error);
        return {
          success: false,
          error: 'Failed to get collateral tokens from margin account'
        };
      }

      if (!('result' in listSim) || !listSim.result) {
        return { success: true, data: {} };
      }

      const collateralTokensRaw = StellarSdk.scValToNative(listSim.result.retval) as unknown;
      const collateralTokens = Array.isArray(collateralTokensRaw)
        ? collateralTokensRaw.map((t) => String(t))
        : [];

      if (collateralTokens.length === 0) {
        return { success: true, data: {} };
      }

      const balances: Record<string, { amount: string; usdValue: string }> = {};
      const sourceSequence = sourceAccount.sequenceNumber();

      const rows = await Promise.allSettled(collateralTokens.map(async (token) => {
          const readSource = new StellarSdk.Account(sourceAddr, sourceSequence);
          const balTx = new StellarSdk.TransactionBuilder(readSource, {
            fee: StellarSdk.BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
          })
            .addOperation(
              contract.call(
                'get_collateral_token_balance',
                StellarSdk.nativeToScVal(token, { type: 'symbol' })
              )
            )
            .setTimeout(30)
            .build();

          const balSim = await server.simulateTransaction(balTx);

          if (!('error' in balSim) && 'result' in balSim && balSim.result) {
            const rawBal = StellarSdk.scValToNative(balSim.result.retval);
            const balanceWad = rawBal?.toString?.() ?? String(rawBal ?? '0');
            const balanceNumber = parseFloat(balanceWad) / Math.pow(10, 18);

            if (balanceNumber > 0) {
              const price = options.includePrices === false ? 0 : await fetchTokenPrice(token);
              const usdValue = (balanceNumber * price).toFixed(2);
              return { token, balance: {
                amount: balanceNumber.toFixed(7),
                usdValue
              } };
            }
          }
          return null;
      }));

      rows.forEach((row, index) => {
        if (row.status === 'fulfilled' && row.value) {
          balances[row.value.token] = row.value.balance;
        } else if (row.status === 'rejected') {
          console.warn(`⚠️ Failed to read collateral balance for ${collateralTokens[index]}:`, row.reason);
        }
      });

      const withFarm = options.includeFarm === false
        ? balances
        : await mergeFarmTrackingCollateralIntoBalances(marginAccountAddress, balances);
      return { success: true, data: this.addUsdcAliases(withFarm) };
    } catch (error: any) {
      console.error('❌ Error getting collateral balances:', error);
      return {
        success: false,
        error: error?.message || 'Failed to get collateral balances'
      };
    }
  }

  /**
   * Repay debt on a margin account via AccountManager `repay` (50x BASE_FEE).
   *
   * The V2 ledger keys debt by token contract ADDRESS, not symbol — BLUSDC and
   * USDC both resolve to the same Blend USDC token address, so the symbol
   * passed on-chain no longer needs to differ from the deposit path. Uses the
   * same normalized symbol (USDC) everywhere, same as deposit/borrow.
   *
   * @param marginAccountAddress - SmartAccount C-address being repaid.
   * @param tokenSymbol - Token symbol or UI alias; normalized before the call.
   * @param repayAmountWad - Repay amount as a u256 WAD (18-decimal) string;
   *                         use {@link getBorrowedTokenDebtWad} to avoid overpay.
   * @returns `{ success, hash?, error? }`. On-chain failures log the full result
   *          (incl. tx hash) and surface 'repay'-context messages — an
   *          ArithDomain/u256_sub error typically means the amount edged just
   *          above the live debt.
   *
   * A repay amount that exactly clears an on-chain debt (a "repay 100%") is
   * exposed to a real timing race: `prepareTransaction`'s resource footprint
   * is sized against a simulation taken BEFORE the wallet-signing popup opens,
   * but by the time the signed tx actually executes, a little more interest
   * may have accrued — tipping the repay from "clears the debt" (a bigger
   * remove-the-ledger-entry write) or vice versa, into a DIFFERENT storage
   * write path than what was simulated. The host then rejects with
   * `scecExceededLimit` ("operation byte-write resources exceeds amount
   * specified") — confirmed live on a 2000 XLM same-asset full repay — even
   * though the account plainly had enough spendable balance. Retrying with a
   * fresh simulation (not resubmitting the same prepared tx) reliably fixes
   * it, same as {@link borrowTokens}'s existing footprint-race retry.
   */
  static async repayLoan(
    marginAccountAddress: string,
    tokenSymbol: string,
    repayAmountWad: string
  ): Promise<{ success: boolean; hash?: string; error?: string; repaidAmountWad?: string }> {
    return withFootprintRaceRetry(
      () => this.repayLoanAttempt(marginAccountAddress, tokenSymbol, repayAmountWad),
      'Repay',
    );
  }

  private static async repayLoanAttempt(
    marginAccountAddress: string,
    tokenSymbol: string,
    repayAmountWad: string
  ): Promise<{ success: boolean; hash?: string; error?: string; repaidAmountWad?: string }> {
    try {
      // The V2 ledger keys debt by token contract ADDRESS, not symbol — BLUSDC
      // and USDC both resolve to the same Blend USDC token address, so which
      // symbol string is passed no longer matters on-chain. Use the same
      // normalized symbol every other call site (deposit, borrow) uses,
      // rather than special-casing repay to send the display symbol BLUSDC.
      const contractTokenSymbol = this.normalizeContractTokenSymbol(tokenSymbol);

      const userAddress = await getAddress();
      if (userAddress.error) {
        return {
          success: false,
          error: 'Failed to get user address'
        };
      }

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const currentAccount = await server.getAccount(userAddress.address);

      // Create contract instance for AccountManager
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);

      // Repay pulls the requested amount directly from the margin account's
      // own SAC balance — a single transaction, no wallet top-up. If the
      // margin account doesn't hold enough (interest ticked the debt above
      // what's actually there, or debt is just bigger than the account's
      // balance), the token contract's own transfer rejects it and that
      // surfaces as a clean "insufficient balance" error below — same as any
      // other DEX (Aave included): you repay what the account has, no
      // automatic wallet-side rescue. The caller decides whether to bring
      // more of this asset into the margin account (Transfer Collateral)
      // first, rather than that decision being made silently for them here.
      const repayAmountDisplay = (Number(repayAmountWad) / 1e18).toFixed(7);
      showTxStep(`Repaying ${repayAmountDisplay} ${tokenSymbol}`);
      const transaction = new StellarSdk.TransactionBuilder(currentAccount, {
        fee: (parseInt(StellarSdk.BASE_FEE) * 50).toString(),
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'repay',
            StellarSdk.nativeToScVal(repayAmountWad, { type: 'u256' }),
            StellarSdk.nativeToScVal(contractTokenSymbol, { type: 'symbol' }),
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
          ),
        )
        .setTimeout(30)
        .build();

      let preparedTx = await server.prepareTransaction(transaction);

      // Pad the simulated write-byte ceiling with a safety margin. A repay
      // whose amount lands right at (or just above) the live debt can tip
      // into a bigger storage write than what simulation — taken BEFORE the
      // wallet-signing popup opens — predicted, once a little more interest
      // accrues in that gap (see this method's doc comment). Confirmed live:
      // simulation declared a 2092-byte write ceiling, real execution needed
      // 2132 — the host then rejects with `scecExceededLimit: operation
      // byte-write resources exceeds amount specified` even on a retry with
      // a fresh simulation, since the SAME small shortfall recurs every
      // time the account is this close to the boundary. Widening the
      // declared ceiling (not just the fee, which `borrowTokensAttempt`
      // already pads) removes the boundary instead of racing it.
      const WRITE_BYTES_SAFETY_MARGIN = 2048;
      const RESOURCE_FEE_SAFETY_MARGIN_STROOPS = BigInt(5000);
      const currentSorobanData = preparedTx.toEnvelope().v1().tx().ext().sorobanData();
      const resources = currentSorobanData.resources();
      const currentResourceFee = BigInt(currentSorobanData.resourceFee().toString());
      const currentTotalFee = BigInt(preparedTx.fee);
      const paddedSorobanData = new StellarSdk.SorobanDataBuilder(currentSorobanData)
        .setResources(
          resources.instructions(),
          resources.diskReadBytes(),
          resources.writeBytes() + WRITE_BYTES_SAFETY_MARGIN
        )
        .setResourceFee((currentResourceFee + RESOURCE_FEE_SAFETY_MARGIN_STROOPS).toString())
        .build();
      preparedTx = StellarSdk.TransactionBuilder.cloneFrom(preparedTx, {
        fee: (currentTotalFee + RESOURCE_FEE_SAFETY_MARGIN_STROOPS).toString(),
      })
        .setSorobanData(paddedSorobanData)
        .build();

      const signResult = await signTransaction(preparedTx.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      const signedTx = StellarSdk.TransactionBuilder.fromXDR(
        signResult.signedTxXdr,
        NETWORK_PASSPHRASE
      );

      // Wallet just returned a signed tx — switch the progress modal from
      // "waiting on you" to an animated "confirming on-chain" fill.
      markTxSubmitted();

      const result = await server.sendTransaction(signedTx as StellarSdk.Transaction);

      if (result.status === 'PENDING') {
        const finalResult = await this.pollTransactionStatus(server, result.hash);

        if (finalResult.status === 'SUCCESS') {
          return {
            success: true,
            hash: result.hash,
            repaidAmountWad: repayAmountWad,
          };
        } else {
          // Surface the hash + log the full result (resultMetaXdr/diagnostics) so the
          // real on-chain reason is inspectable instead of a generic "failed".
          const reason = describeFailedTx(finalResult);
          console.error('❌ Repay tx did not succeed:', {
            hash: result.hash,
            status: finalResult.status,
            reason,
            result: JSON.stringify(finalResult, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
          });
          return {
            success: false,
            // `reason` (when decodable) carries the real diagnostic text —
            // e.g. "scecExceededLimit: ..." — which isFootprintRaceError
            // checks for in the retry wrapper above.
            error: `Repay failed on-chain (${finalResult.status})${reason ? `: ${reason}` : ''}. Tx: ${result.hash}`
          };
        }
      } else if (result.status === 'ERROR') {
        // Bare "ERROR status" with no decoded reason meant a transient
        // submission-time rejection here — most plausibly `txBadSeq` (a
        // multi-node RPC sequence-number race, same class of issue documented
        // on isFootprintRaceError) — never got a chance to retry: the outer
        // withFootprintRaceRetry wrapper only retries when the error text
        // matches a known race pattern, and a bare generic string matches
        // none of them. Decoding the real result code (same pattern as the
        // borrow/deposit flows above) lets that retry actually fire.
        const resultCode = describeSendError(result);
        console.error(`❌ Repay transaction failed immediately with ERROR status (${resultCode})`);
        return {
          success: false,
          error: resultCode !== 'unknown'
            ? `Repay transaction failed with result: ${resultCode}`
            : 'Repay transaction failed with ERROR status',
        };
      } else {
        return {
          success: false,
          error: `Unexpected status: ${result.status}`
        };
      }
    } catch (error: any) {
      console.error('❌ Error repaying loan:', error);
      return {
        success: false,
        error: this.formatUserFacingContractError(error?.message || error, 'repay')
      };
    }
  }

  /**
   * Liquidate an undercollateralised margin account.
   *
   * The caller (liquidator) must:
   *   - Hold enough of each borrowed token in their wallet to repay every open debt.
   *   - Have approved the AccountManager to spend those tokens (handled by Soroban auth).
   *
   * On success the liquidator pays all outstanding debt and receives the smart account's
   * entire collateral balance as profit.  The transaction must be signed by the liquidator.
   *
   * @param liquidatorAddress  Stellar address that will pay the debt and receive collateral.
   * @param marginAccountAddress  The smart-account (margin account) address to liquidate.
   */
  static async liquidateMarginAccount(
    liquidatorAddress: string,
    marginAccountAddress: string
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(liquidatorAddress);

      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);

      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: (parseInt(StellarSdk.BASE_FEE) * 100).toString(), // higher fee — multi-token repay
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'liquidate',
            StellarSdk.nativeToScVal(liquidatorAddress, { type: 'address' }),
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' })
          )
        )
        .setTimeout(30)
        .build();

      const preparedTx = await server.prepareTransaction(transaction);

      const signResult = await signTransaction(preparedTx.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      const signedTx = StellarSdk.TransactionBuilder.fromXDR(
        signResult.signedTxXdr,
        NETWORK_PASSPHRASE
      );

      // Wallet just returned a signed tx — switch the progress modal from
      // "waiting on you" to an animated "confirming on-chain" fill.
      markTxSubmitted();

      const result = await server.sendTransaction(signedTx as StellarSdk.Transaction);

      if (result.status === 'PENDING') {
        const finalResult = await this.pollTransactionStatus(server, result.hash);

        if (finalResult.status === 'SUCCESS') {
          return { success: true, hash: result.hash };
        } else {
          console.error('❌ Liquidate tx did not succeed:', {
            hash: result.hash,
            status: finalResult.status,
            result: JSON.stringify(finalResult, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
          });
          return {
            success: false,
            error: `Liquidation failed on-chain (${finalResult.status}). Tx: ${result.hash}`,
          };
        }
      } else if (result.status === 'ERROR') {
        return { success: false, error: 'Liquidate transaction failed with ERROR status' };
      } else {
        return { success: false, error: `Unexpected status: ${result.status}` };
      }
    } catch (error: any) {
      console.error('❌ Error liquidating margin account:', error);
      return {
        success: false,
        error: this.formatUserFacingContractError(error?.message || error, 'generic'),
      };
    }
  }

  /**
   * Fetch a margin account's recent borrow/repay history from contract events.
   *
   * Pulls `Trader_Borrow` and `Trader_Repay_Event` from the AccountManager over
   * roughly the last ~30 days of ledgers (capped by Soroban testnet's event
   * retention), filters to this account, sorts newest-first and returns at most
   * 50 entries. Borrow events carry no amount on-chain, so `amount` is `'—'` for
   * borrows; repay amounts are WAD-decoded to human units. Tolerant of malformed
   * events and RPC hiccups — returns `[]` rather than throwing.
   *
   * @param marginAccountAddress - SmartAccount C-address to filter events by.
   * @returns Up to 50 `{ type, asset, amount, timestamp, hash }` rows.
   */
  static async getMarginTransactionHistory(
    marginAccountAddress: string
  ): Promise<{ type: 'borrow' | 'repay'; asset: string; amount: string; timestamp: number; hash: string }[]> {
    const WAD = BigInt('1000000000000000000');

    const wadToHuman = (raw: unknown): number => {
      try {
        const bi = BigInt(raw!.toString());
        return Number(bi / WAD) + Number(bi % WAD) / 1e18;
      } catch {
        return 0;
      }
    };

    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const ledgerResp = await server.getLatestLedger();
      const startLedger = Math.max(1, ledgerResp.sequence - 518400);

      const borrowTopic = StellarSdk.xdr.ScVal.scvSymbol('Trader_Borrow').toXDR('base64');
      const repayTopic = StellarSdk.xdr.ScVal.scvSymbol('Trader_Repay_Event').toXDR('base64');

      const safeGetEvents = async (topic: string) => {
        try {
          const resp = await (server as any).getEvents({
            startLedger,
            filters: [{
              type: 'contract',
              contractIds: [CONTRACT_ADDRESSES.ACCOUNT_MANAGER],
              topics: [[topic]],
            }],
            limit: 200,
          });
          if (resp?.error) return [];
          return resp?.events ?? [];
        } catch {
          return [];
        }
      };

      const [borrowEvents, repayEvents] = await Promise.all([
        safeGetEvents(borrowTopic),
        safeGetEvents(repayTopic),
      ]);

      const results: { type: 'borrow' | 'repay'; asset: string; amount: string; timestamp: number; hash: string }[] = [];

      for (const ev of borrowEvents ?? []) {
        try {
          const topics = (ev.topic ?? []).map((t: any) => StellarSdk.scValToNative(t));
          const accountAddr = topics[1] as string;
          if (!accountAddr || accountAddr !== marginAccountAddress) continue;

          const tokenSymbol = StellarSdk.scValToNative(ev.value) as string;
          results.push({
            type: 'borrow',
            asset: String(tokenSymbol ?? ''),
            amount: '—',
            timestamp: ev.ledgerClosedAt ? new Date(ev.ledgerClosedAt).getTime() : 0,
            hash: ev.txHash ?? '',
          });
        } catch { /* skip malformed events */ }
      }

      for (const ev of repayEvents ?? []) {
        try {
          const topics = (ev.topic ?? []).map((t: any) => StellarSdk.scValToNative(t));
          const accountAddr = topics[1] as string;
          if (!accountAddr || accountAddr !== marginAccountAddress) continue;

          const data = ev.value ? StellarSdk.scValToNative(ev.value) : null;
          if (!data || typeof data !== 'object') continue;

          const rawData = data as Record<string, unknown>;
          results.push({
            type: 'repay',
            asset: String(rawData.token_symbol ?? ''),
            amount: wadToHuman(rawData.token_amount).toFixed(7),
            timestamp: ev.ledgerClosedAt ? new Date(ev.ledgerClosedAt).getTime() : 0,
            hash: ev.txHash ?? '',
          });
        } catch { /* skip malformed events */ }
      }

      results.sort((a, b) => b.timestamp - a.timestamp);
      return results.slice(0, 50);
    } catch (err: any) {
      console.warn('[MarginAccountService] getMarginTransactionHistory error:', err?.message ?? err);
      return [];
    }
  }

  /**
   * One-signature "open position" for Blend single-asset pools: deposit
   * collateral, optionally borrow, and deploy the combined amount into Blend —
   * all inside one Soroban op (`deposit_borrow_and_deploy_blend`).
   *
   * Because Soroban permits only one host-function op per tx, the three steps
   * must live behind a single contract wrapper; this also reads the Blend pool
   * address from the Registry and pre-builds the external-protocol call bytes.
   * Uses 120x BASE_FEE. Human amounts are converted to WAD via an intermediate
   * 1e6 floor × 1e12 (i.e. 6-dp precision scaled to 18) to avoid float drift.
   *
   * Gotcha: the chained deposit→borrow→deploy can exceed Soroban's per-tx CPU
   * budget on populated pools. On a budget error this returns
   * `success: false` (warning, not error) so the caller in one-click-strategy.ts
   * can fall back to its 2-tx split flow.
   *
   * @param marginAccountAddress - SmartAccount C-address to open the position on.
   * @param collateralAmount - Collateral to deposit, in token units (> 0).
   * @param borrowAmount - Amount to borrow, in token units (0 = deposit-only 1x).
   * @param tokenSymbol - Token symbol or UI alias (default 'XLM'); normalized.
   * @returns `{ success, hash?, error? }`.
   */
  static async depositBorrowAndDeployBlendAtomic(
    marginAccountAddress: string,
    collateralAmount: number,
    borrowAmount: number,
    tokenSymbol: string = 'XLM'
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
    try {
      const contractTokenSymbol = this.normalizeContractTokenSymbol(tokenSymbol);

      if (!collateralAmount || collateralAmount <= 0) {
        return { success: false, error: 'Please enter a valid collateral amount' };
      }

      const userAddress = await getAddress();
      if (userAddress.error || !userAddress.address) {
        return { success: false, error: 'Failed to get user address' };
      }

      const isCollateralAllowed = await this.isCollateralAllowed(contractTokenSymbol);
      if (!isCollateralAllowed) {
        return {
          success: false,
          error: `${contractTokenSymbol} is not allowed as collateral. Please ask the contract admin to enable this token first.`,
        };
      }

      const blendPoolAddress = await BlendService.getBlendPoolAddressFromRegistry();
      if (!blendPoolAddress) {
        return {
          success: false,
          error:
            'Blend pool is not configured in the Registry. Ask the admin to run set_blend_pool_address before deploying.',
        };
      }

      const depositAmountWad = (
        BigInt(Math.floor(collateralAmount * 1_000_000)) * BigInt(1_000_000_000_000)
      ).toString();
      const borrowAmountWadBigInt =
        borrowAmount > 0
          ? BigInt(Math.floor(borrowAmount * 1_000_000)) * BigInt(1_000_000_000_000)
          : BigInt(0);
      const totalDeployAmount = collateralAmount + Math.max(0, borrowAmount);
      const totalDeployAmountWad =
        BigInt(Math.floor(totalDeployAmount * 1_000_000)) * BigInt(1_000_000_000_000);

      const callBytes = BlendService.buildExternalProtocolCallBytes(
        blendPoolAddress,
        'Deposit',
        contractTokenSymbol,
        totalDeployAmountWad,
        marginAccountAddress
      );

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(userAddress.address);
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);

      // Single Soroban op calling the contract-side wrapper that does
      // deposit_collateral_tokens + borrow + execute(blend) internally.
      // Soroban allows only one host-function op per Stellar tx, so the
      // collapsed flow has to live behind a single contract function.
      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: (parseInt(StellarSdk.BASE_FEE) * 120).toString(),
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'deposit_borrow_and_deploy_blend',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
            StellarSdk.nativeToScVal(depositAmountWad, { type: 'u256' }),
            StellarSdk.nativeToScVal(borrowAmountWadBigInt.toString(), { type: 'u256' }),
            StellarSdk.nativeToScVal(contractTokenSymbol, { type: 'symbol' }),
            StellarSdk.xdr.ScVal.scvBytes(callBytes)
          )
        )
        .setTimeout(90)
        .build();

      const preparedTx = await server.prepareTransaction(transaction);
      const signResult = await signTransaction(preparedTx.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      const signedTx = StellarSdk.TransactionBuilder.fromXDR(
        signResult.signedTxXdr,
        NETWORK_PASSPHRASE
      );

      // Wallet just returned a signed tx — switch the progress modal from
      // "waiting on you" to an animated "confirming on-chain" fill.
      markTxSubmitted();

      const result = await server.sendTransaction(signedTx as StellarSdk.Transaction);
      if (result.status !== 'PENDING') {
        return {
          success: false,
          error: `Atomic strategy transaction failed immediately with status: ${result.status}`,
        };
      }

      const finalResult = await this.pollTransactionStatus(server, result.hash);
      if (finalResult.status === 'SUCCESS') {
        return { success: true, hash: result.hash };
      }

      return {
        success: false,
        error: `Atomic strategy failed with status: ${finalResult.status}`,
      };
    } catch (error: any) {
      // Soroban currently caps a single tx at ~100M CPU instructions, and the
      // chained deposit→borrow→Blend deploy can exceed that on populated pools.
      // Use console.warn (not error) so the Next.js dev overlay stays quiet —
      // the caller in one-click-strategy.ts has a 2-tx fallback that runs next.
      const msg = String(error?.message || error || '');
      const isBudget = msg.includes('Budget, ExceededLimit') || msg.includes('budget') || msg.includes('Budget');
      if (isBudget) {
        console.warn('[Atomic Blend] tx exceeded Soroban budget — falling back to split flow');
      } else {
        console.warn('[Atomic Blend] open-position pre-flight failed; falling back to split flow:', msg);
      }
      return {
        success: false,
        error: this.formatUserFacingContractError(error, 'generic'),
      };
    }
  }

  /**
   * Combined deposit and borrow operation (leverage). Single wallet signature.
   *
   *  - Same-asset (deposit XLM, borrow XLM): calls the contract's
   *    `deposit_and_borrow(smart_account, deposit_wad, borrow_wad, token)` wrapper.
   *  - Cross-asset (deposit XLM, borrow BLUSDC): calls the contract's
   *    `deposit_and_borrow_cross(smart_account, deposit_wad, deposit_token,
   *    borrow_wad, borrow_token)` wrapper.
   *
   * `borrowAmount` is computed by the caller — for same-asset leverage it's
   * `depositAmount × (multiplier - 1)`. For cross-asset the caller supplies an
   * explicit borrow amount in `borrow_token` units (USD-equivalent priced by
   * the caller).
   *
   * Runs config/collateral/wallet-balance pre-flight checks before signing, and
   * uses 50x BASE_FEE. Like the atomic Blend flow, a Soroban budget overflow is
   * returned as a budget-identifiable error (deliberately not collapsed by the
   * generic formatter) so the caller can fall back to a 2-tx split.
   *
   * @param marginAccountAddress - SmartAccount C-address.
   * @param depositAmount - Collateral to deposit, in deposit-token units.
   * @param multiplier - Leverage multiplier; borrow defaults to
   *                      `depositAmount × (multiplier - 1)` when no explicit
   *                      `borrowAmountTokens` is given.
   * @param tokenSymbol - Deposit token symbol or UI alias (default 'XLM').
   * @param options.borrowTokenSymbol - Borrow token when it differs from the
   *                      deposit token (triggers the cross-asset path).
   * @param options.borrowAmountTokens - Explicit borrow amount in borrow-token
   *                      units; overrides the multiplier-derived amount.
   * @returns `{ success, hash?, error? }`.
   */
  static async depositAndBorrow(
    marginAccountAddress: string,
    depositAmount: number,
    multiplier: number,
    tokenSymbol: string = 'XLM',
    options?: { borrowTokenSymbol?: string; borrowAmountTokens?: number }
  ): Promise<{ success: boolean; hash?: string; error?: string; nextSequence?: string }> {
    try {
      const contractDepositSymbol = this.normalizeContractTokenSymbol(tokenSymbol);
      const contractBorrowSymbol = options?.borrowTokenSymbol
        ? this.normalizeContractTokenSymbol(options.borrowTokenSymbol)
        : contractDepositSymbol;
      const isCrossAsset = contractDepositSymbol !== contractBorrowSymbol;


      const depositAmountWad = (BigInt(Math.floor(depositAmount * 1_000_000)) * BigInt(1_000_000_000_000)).toString();
      const borrowAmountTokens = options?.borrowAmountTokens != null
        ? options.borrowAmountTokens
        : (multiplier > 1 ? depositAmount * (multiplier - 1) : 0);
      const borrowAmountWad = (BigInt(Math.floor(borrowAmountTokens * 1_000_000)) * BigInt(1_000_000_000_000)).toString();

      // Pre-flight checks (cheap reads, surface admin/config issues before signing)
      const configCheck = await this.isTokenConfigured(contractDepositSymbol);
      if (!configCheck.configured) {
        return {
          success: false,
          error: `⚠️ Configuration Issue: ${configCheck.error}\n\n` +
                 `The ${contractDepositSymbol} token contract address needs to be set in the Registry contract.\n` +
                 `Please contact the admin to configure the new Registry deployment.`,
        };
      }
      const isCollateralAllowed = await this.isCollateralAllowed(contractDepositSymbol);
      if (!isCollateralAllowed) {
        return {
          success: false,
          error: `${contractDepositSymbol} is not allowed as collateral. Please ask the contract admin to enable this token first.`,
        };
      }

      const userAddress = await getAddress();
      if (userAddress.error || !userAddress.address) {
        return { success: false, error: 'Failed to get user address' };
      }

      const walletCheck = await this.checkWalletBalanceForDeposit(
        userAddress.address,
        contractDepositSymbol,
        depositAmount,
      );
      if (!walletCheck.ok) {
        return { success: false, error: walletCheck.error };
      }

      if (borrowAmountTokens > 0) {
        const liquidityCheck = await this.checkPoolLiquidity(contractBorrowSymbol, borrowAmountTokens);
        if (!liquidityCheck.ok) {
          return { success: false, error: liquidityCheck.error };
        }
      }

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(userAddress.address);
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);

      // Pick the matching contract function based on whether deposit and
      // borrow tokens are the same. Argument orders match account_manager.rs.
      const operation = isCrossAsset
        ? contract.call(
            'deposit_and_borrow_cross',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
            StellarSdk.nativeToScVal(depositAmountWad, { type: 'u256' }),
            StellarSdk.nativeToScVal(contractDepositSymbol, { type: 'symbol' }),
            StellarSdk.nativeToScVal(borrowAmountWad, { type: 'u256' }),
            StellarSdk.nativeToScVal(contractBorrowSymbol, { type: 'symbol' })
          )
        : contract.call(
            'deposit_and_borrow',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
            StellarSdk.nativeToScVal(depositAmountWad, { type: 'u256' }),
            StellarSdk.nativeToScVal(borrowAmountWad, { type: 'u256' }),
            StellarSdk.nativeToScVal(contractDepositSymbol, { type: 'symbol' })
          );

      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: (parseInt(StellarSdk.BASE_FEE) * 50).toString(),
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(operation)
        .setTimeout(60)
        .build();

      // See borrowTokensAttempt's matching comment: `sourceAccount` is
      // mutated in place by `.build()`, so this is the exact sequence the
      // account will have once this tx confirms — a dual-borrow's standalone
      // second-leg `borrow()` call (right after this atomic tx) should use
      // it instead of racing a fresh `getAccount()` read.
      const nextSequence = sourceAccount.sequenceNumber();

      const preparedTx = await server.prepareTransaction(transaction);
      const signResult = await signTransaction(preparedTx.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
      });
      const signedTx = StellarSdk.TransactionBuilder.fromXDR(
        signResult.signedTxXdr,
        NETWORK_PASSPHRASE
      );

      // Wallet just returned a signed tx — switch the progress modal from
      // "waiting on you" to an animated "confirming on-chain" fill.
      markTxSubmitted();

      const result = await server.sendTransaction(signedTx as StellarSdk.Transaction);
      if (result.status !== 'PENDING') {
        return { success: false, error: `deposit_and_borrow rejected: ${result.status}` };
      }

      const finalResult = await this.pollTransactionStatus(server, result.hash);
      if (finalResult.status === 'SUCCESS') {
        console.log(`[depositAndBorrow] confirmed, nextSequence=${nextSequence} (source account: ${userAddress.address})`);
        return { success: true, hash: result.hash, nextSequence };
      }
      return {
        success: false,
        error: `deposit_and_borrow failed on-chain (status ${finalResult.status}). ` +
               `If the borrow leg was rejected by the Risk Engine, try a lower leverage or more collateral.`,
      };
    } catch (error: any) {
      const raw = String(error?.message ?? error ?? '');
      // Budget overflow is expected on populated pools — the chained deposit→borrow
      // can exceed Soroban's per-tx CPU cap. Surface a BUDGET-IDENTIFIABLE error
      // (not formatUserFacingContractError, which collapses HostError into a generic
      // string and would hide the signal) so the WB caller can fall back to the
      // 2-tx split flow. Warn, not error — it's recoverable via the fallback.
      if (/Budget|ExceededLimit|resource/i.test(raw)) {
        console.warn('[deposit_and_borrow] Soroban budget exceeded; caller will split into 2 txs:', raw);
        return { success: false, error: `Budget exceeded — ${raw}` };
      }
      console.error('❌ Error in deposit_and_borrow:', error);
      return {
        success: false,
        error: this.formatUserFacingContractError(error?.message || error, 'borrow'),
      };
    }
  }
}
