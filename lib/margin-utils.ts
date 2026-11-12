/**
 * Margin-account integration layer for the Vanna lending protocol.
 *
 * Wraps the credit-layer contracts (testnet redeploy 2026-11-06, see
 * lib/credit-layer.ts) behind one service class (`MarginAccountService`):
 * account discovery/creation, collateral deposit/withdraw, borrow/repay, and
 * the "open position" flows (deposit + borrow + deploy to Blend). Reads go
 * through simulated transactions; writes are signed via the wallet adapter
 * (Freighter or Privy) inside `invokeWrite`.
 *
 * Old -> new:
 *   AccountManager.create_account            -> CreditLayer.create_margin (returns the margin address)
 *   Registry/AccountManager discovery         -> CreditLayer.margin_of(trader)
 *   deposit_collateral_tokens(sa, sym, wad)   -> CreditLayer.deposit_collateral(margin, token, wad)
 *   withdraw_collateral_balance               -> CreditLayer.withdraw_collateral
 *   borrow(sa, wad, sym)                      -> CreditLayer.borrow(margin, token, wad)
 *   repay(wad, sym, sa)                       -> CreditLayer.repay(margin, token, wad) — pays from the
 *                                                margin account's own balance; any shortfall is first
 *                                                deposited from the wallet
 *   deposit_and_borrow / _cross / deposit_borrow_and_deploy_blend
 *                                             -> sequential txs (deposit, borrow, margin_execute)
 *   RiskEngine health                         -> CreditLayer.margin_value / is_healthy (threshold 1.2)
 *   get_all_collateral_tokens / balances      -> margin.assets() + token.balance(margin), LP + Blend reads
 *   get_all_borrowed_tokens / debt            -> margin.debts() + reserve.debt_of(margin)
 *
 * Amount conventions are deliberate and load-bearing:
 *   - The contract accepts amounts in WAD (18-decimal fixed point); all
 *     `*_wad` params/returns use this scale.
 *   - SAC tokens on this deployment are 7-decimal (stroops), so a stroop→WAD
 *     conversion multiplies by 1e11 (see `getMarginAccountTokenBalanceWad`).
 *   - Symbol normalization (`normalizeContractTokenSymbol`) maps the several UI
 *     aliases (USDC/BLUSDC, AQUSDC, SOUSDC) onto one symbol per asset; the
 *     token ADDRESS sent on-chain comes from `tokenAddressFor`.
 *
 * Discovery is a single permanent storage read (`margin_of`), so there is no
 * event-retention limit and no "inactive account" concept any more.
 */
import * as StellarSdk from '@stellar/stellar-sdk';
import {
  CreditLayer,
  CREDIT_ASSETS,
  CREDIT_LAYER_ADDRESSES,
  creditAssetForToken,
  marginAssets,
  marginDebts,
  marginValue,
  rpc,
  HEALTH_THRESHOLD,
  getHealthLimits,
  connectedAddress,
  invokeWrite,
  marginOf,
  ownerOf,
  readOr,
  reserveStats,
  sc,
  simulateRead,
  stroopsToWad,
  toCreditAsset,
  tokenAddressFor,
  tokenBalance,
  wadToNumber,
  type TxResult,
} from './credit-layer';
import { CONTRACT_ADDRESSES } from './stellar-utils';
import {
  addUsdcAliases,
  maxBorrowUsd,
  maxWithdrawUsd,
  priceUsd,
  readMarginPortfolio,
  type BalanceMap,
} from './margin-credit-reads';
import { getMarginHistoryFromRpc } from './margin-history-rpc';
import { showTxStep } from './tx-progress';
import { numberAmountToWad } from './utils/sanitize-amount';

// Types
/**
 * A trader's deployed margin account, as tracked client-side.
 *
 * `address` is the on-chain MarginAccount C-address; `owner` is the trader's
 * G-address. `accountManagerAddress` records which CreditLayer deployment
 * minted it — used to invalidate cached accounts after a redeploy (a stale
 * account points at a dead credit layer). The field name is kept for callers.
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

type WriteResult = { success: boolean; hash?: string; error?: string; nextSequence?: string };

/**
 * Service for managing a trader's margin account against the on-chain
 * CreditLayer. All methods are static; the class holds no instance state
 * beyond the runtime account cache.
 *
 * Read methods simulate transactions (no signature, no fee); write methods go
 * through `invokeWrite` (simulate → sign → submit → poll, retrying on a stale
 * sequence / footprint race). Account discovery is always authoritative
 * on-chain; the in-memory map below only avoids duplicate lookups during the
 * current runtime.
 */
export class MarginAccountService {
  private static marginAccountCache = new Map<string, MarginAccount>();

  private static normalizeContractTokenSymbol(tokenSymbol: string): string {
    const normalized = tokenSymbol?.toUpperCase();
    if (normalized === 'BLUSDC' || normalized === 'BLEND_USDC' || normalized === 'USDC') {
      // One symbol for Blend USDC across the app; the token address is what
      // goes on-chain (tokenAddressFor maps USDC and BLUSDC to the same token).
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

  private static displaySymbol(contractSymbol: string): string {
    return contractSymbol === 'USDC' ? 'BLUSDC' : contractSymbol;
  }

  /** Wallet holds at least `depositAmount` of the token (XLM skipped: fees come out of it too). */
  private static async checkWalletBalanceForDeposit(
    walletAddress: string,
    contractTokenSymbol: string,
    depositAmount: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (contractTokenSymbol === 'XLM') return { ok: true };
    if (!toCreditAsset(contractTokenSymbol)) return { ok: true };

    const displaySymbol = this.displaySymbol(contractTokenSymbol);
    let available: number;
    try {
      const bal = await simulateRead<bigint>(tokenAddressFor(contractTokenSymbol), 'balance', [sc.address(walletAddress)]);
      available = Number(BigInt(bal)) / 1e7;
    } catch {
      // Failed simulation must not be mistaken for an empty wallet
      return { ok: true };
    }
    if (available + 1e-7 < depositAmount) {
      if (available <= 1e-7) {
        const faucetHint =
          displaySymbol === 'BLUSDC'
            ? 'Blend USDC'
            : displaySymbol === 'AQUSDC'
              ? 'Aquarius USDC'
              : displaySymbol === 'SOUSDC'
                ? 'Soroswap USDC'
                : displaySymbol;
        return {
          ok: false,
          error: `You have no ${displaySymbol} in your wallet. Use the Faucet to mint ${faucetHint} (establishes the required trustline), then retry.`,
        };
      }
      return {
        ok: false,
        error: `Insufficient ${displaySymbol} wallet balance. Available: ${available.toFixed(2)} ${displaySymbol}.`,
      };
    }
    return { ok: true };
  }

  /**
   * Reserve has the cash and stays under its 95% utilization cap
   * (reserve.rs MAX_UTILIZATION_WAD). 94% here leaves room for interest
   * accruing between this read and execution.
   */
  private static async checkPoolLiquidity(
    contractBorrowSymbol: string,
    borrowAmountTokens: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!toCreditAsset(contractBorrowSymbol)) return { ok: true };
    const displayName =
      contractBorrowSymbol === 'USDC' ? 'USDC' : contractBorrowSymbol === 'AQUSDC' ? 'Aquarius USDC' : contractBorrowSymbol === 'SOUSDC' ? 'Soroswap USDC' : contractBorrowSymbol;
    const MAX_UTILIZATION = 0.94;
    try {
      const s = await reserveStats(contractBorrowSymbol);
      const cash = wadToNumber(s.cashWad);
      const debt = wadToNumber(s.totalDebtWad);
      const total = wadToNumber(s.totalAssetsWad);
      if (borrowAmountTokens > cash) {
        return {
          ok: false,
          error:
            `The ${displayName} lending reserve does not have enough liquidity. ` +
            `Available: ${cash.toFixed(2)} ${displayName}, you need: ${borrowAmountTokens.toFixed(2)} ${displayName}. ` +
            `Please reduce your leverage or wait for more liquidity to be supplied.`,
        };
      }
      if (total > 0 && (debt + borrowAmountTokens) / total > MAX_UTILIZATION) {
        const maxAdditional = Math.max(0, total * MAX_UTILIZATION - debt);
        return {
          ok: false,
          error:
            `The ${displayName} lending reserve is already at ${((debt / total) * 100).toFixed(1)}% utilization ` +
            `and can only safely lend ${maxAdditional.toFixed(2)} more ${displayName} right now ` +
            `(you requested ${borrowAmountTokens.toFixed(2)}). Please reduce your borrow amount, ` +
            `or wait for more liquidity to be supplied.`,
        };
      }
      return { ok: true };
    } catch {
      return { ok: true };
    }
  }

  private static parseBorrowNotAllowedMessage(raw: any, tokenSymbol: string): string {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});

    if (
      text.includes('would leave the margin account unhealthy') ||
      (text.includes('is_borrow_allowed') && text.includes('false')) ||
      text.includes('Borrowing is not allowed for this user')
    ) {
      return `Borrow not allowed for ${tokenSymbol}: it would push your health factor below ${HEALTH_THRESHOLD}. Your account collateral/debt ratio is too low for this borrow amount. Please repay existing debt or add more collateral, then try again.`;
    }

    if (text.includes('utilization past the maximum') || text.includes('InsufficientLiquidity') || text.includes('Not enough liquidity')) {
      return `Borrow failed for ${tokenSymbol}: the lending reserve does not have enough free liquidity. Reduce the amount or retry later.`;
    }

    if (text.includes('price not available') || /Oracle: /.test(text)) {
      return `Borrow failed for ${tokenSymbol} because an oracle price is missing for one of your account assets. Please retry shortly.`;
    }

    if (text.includes('trustline entry is missing for account')) {
      const match = text.match(/trustline entry is missing for account"\s*,\s*([A-Z0-9]+)/);
      const accountHint = match?.[1] ? ` (${match[1]})` : '';
      return `Borrow failed for ${tokenSymbol}: a trustline is missing${accountHint}. This is a reserve configuration issue, not your collateral ratio.`;
    }

    if (text.includes('maximum number of assets')) {
      return `Borrow failed for ${tokenSymbol}: the margin account already holds the maximum number of assets.`;
    }

    if (text.includes('Budget') || text.includes('ExceededLimit')) {
      return 'Budget exceeded.';
    }

    if (text.includes('InvalidAction') || text.includes('UnreachableCodeReached')) {
      return `Borrow action rejected for ${tokenSymbol}. This usually means borrow constraints are not satisfied (health factor, reserve liquidity, or collateral requirements).`;
    }

    return `Borrow failed for ${tokenSymbol}. Please check collateral, existing debt, and risk limits, then retry.`;
  }

  private static formatUserFacingContractError(raw: any, action: 'repay' | 'borrow' | 'withdraw' | 'generic' = 'generic'): string {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
    const compact = text.split('\nEvent log')[0]?.trim() || text;

    // Diagnostic clues often live INSIDE the "Event log" section, which
    // `compact` cuts off. Match keyword checks against the FULL `text`.
    if (/budget|exceededlimit|network resource limit/i.test(text)) {
      return 'Budget exceeded.';
    }

    if (/rejected in the wallet/i.test(text)) return 'Transaction was rejected in the wallet.';

    if (action === 'repay') {
      // Repay pulls from the margin account's own balance; any token transfer
      // shortfall surfaces as an insufficient-balance error.
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
        text.includes('would leave the margin account unhealthy') ||
        compact.includes('is_withdraw_allowed') ||
        compact.includes('InvalidAction') ||
        compact.includes('UnreachableCodeReached')
      ) {
        return `Withdraw is blocked by the health check (health factor must stay above ${HEALTH_THRESHOLD}). You likely have active debt, and this transfer would make your account unsafe. Repay some debt or withdraw a smaller amount.`;
      }

      if (
        text.includes("exceeds the margin account's balance") ||
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

  /** Margin-account balance of one asset, WAD. 0 on failure. */
  private static async getMarginCollateralBalanceWad(marginAccountAddress: string, tokenSymbol: string): Promise<bigint> {
    try {
      return stroopsToWad(await tokenBalance(tokenAddressFor(tokenSymbol), marginAccountAddress));
    } catch {
      return BigInt(0);
    }
  }

  /** Polls until the margin account's balance of `tokenSymbol` reaches `minExpectedWad` (RPC read-after-write lag). */
  private static async waitForCollateralSync(
    marginAccountAddress: string,
    tokenSymbol: string,
    minExpectedWad: bigint,
  ): Promise<boolean> {
    for (let i = 0; i < 10; i += 1) {
      const current = await this.getMarginCollateralBalanceWad(marginAccountAddress, tokenSymbol);
      if (current >= minExpectedWad) return true;
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    return false;
  }

  /**
   * Read the runtime-cached margin account for a trader.
   *
   * @param userAddress - Trader's G-address.
   * The cache is deliberately memory-only: financial/account state must never
   * be restored from browser storage. The layout hydrator first discovers the
   * account with `margin_of` and then fills this map.
   */
  static getStoredMarginAccount(userAddress: string): MarginAccount | null {
    return this.marginAccountCache.get(userAddress) ?? null;
  }

  /**
   * Cache a chain-resolved margin account for this runtime only.
   *
   * @param userAddress - Trader's G-address (map key).
   * @param marginAccount - Account to cache; its `accountManagerAddress` is
   *                        overwritten with the live CreditLayer deployment.
   */
  static storeMarginAccount(userAddress: string, marginAccount: MarginAccount): void {
    this.marginAccountCache.set(userAddress, {
      ...marginAccount,
      accountManagerAddress: CONTRACT_ADDRESSES.CREDIT_LAYER,
    });
  }

  /**
   * Whether the trader has a runtime-cached margin account.
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
   * Create a margin account for a trader via CreditLayer `create_margin`
   * (one per trader, enforced on-chain).
   *
   * Idempotent by design: checks the runtime cache, then `margin_of`, and
   * returns the existing account if found — only signs/submits a creation tx
   * when none exists. The new address is the call's return value (also emitted
   * as `margin_created`); `margin_of` is re-read as a fallback.
   *
   * @param userAddress - Trader's G-address; becomes the account owner and the
   *                       tx source (the wallet will prompt for a signature).
   */
  static async createMarginAccount(userAddress: string): Promise<MarginAccountCreationResult> {
    try {
      const existingAccount = this.getStoredMarginAccount(userAddress);
      if (existingAccount && existingAccount.isActive) {
        return { success: true, marginAccountAddress: existingAccount.address, error: 'User already has an active margin account' };
      }

      const onChain = await this.discoverExistingAccount(userAddress);
      if (onChain) {
        return {
          success: true,
          marginAccountAddress: onChain,
          error: 'User already has an active margin account (recovered from blockchain)',
        };
      }

      const res = await CreditLayer.createMargin(userAddress);
      if (!res.success) {
        return { success: false, error: res.error || 'Failed to create margin account' };
      }

      let marginAccountAddress: string | null = typeof res.returnValue === 'string' ? res.returnValue : null;
      if (!marginAccountAddress) marginAccountAddress = await marginOf(userAddress);
      if (!marginAccountAddress) {
        return { success: false, error: 'Failed to extract margin account address from transaction result' };
      }

      this.storeMarginAccount(userAddress, {
        address: marginAccountAddress,
        owner: userAddress,
        isActive: true,
        createdAt: Date.now(),
      });
      return { success: true, marginAccountAddress, hash: res.hash };
    } catch (error: any) {
      console.error('Create margin account error:', error);
      return { success: false, error: error?.message || 'Failed to create margin account' };
    }
  }

  /**
   * Resolve a trader's margin account from chain: CreditLayer `margin_of`
   * (permanent storage, no event-retention limit). Caches the result.
   *
   * @param userAddress - Trader's G-address.
   * @returns The MarginAccount C-address, or null if the trader has none.
   */
  static async discoverExistingAccount(userAddress: string): Promise<string | null> {
    if (!userAddress) return null;
    const margin = await marginOf(userAddress);
    if (margin) {
      const cached = this.getStoredMarginAccount(userAddress);
      if (!cached || cached.address !== margin) {
        this.storeMarginAccount(userAddress, { address: margin, owner: userAddress, isActive: true, createdAt: Date.now() });
      }
    }
    return margin;
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
    if (!account) return { hasAccount: false };
    return {
      hasAccount: true,
      accountAddress: account.address,
      isActive: account.isActive,
      createdAt: account.createdAt,
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

  /** CreditLayer `collateral_allowed(token)`. `known: false` when the read failed. */
  static async checkCollateralAllowed(tokenSymbol: string): Promise<{ allowed: boolean; known: boolean; symbol: string }> {
    const contractTokenSymbol = this.normalizeContractTokenSymbol(tokenSymbol);
    if (!toCreditAsset(contractTokenSymbol)) return { allowed: false, known: true, symbol: contractTokenSymbol };
    try {
      const allowed = await simulateRead<boolean>(CREDIT_LAYER_ADDRESSES.CREDIT_LAYER, 'collateral_allowed', [
        sc.address(tokenAddressFor(contractTokenSymbol)),
      ]);
      return { allowed: allowed === true, known: true, symbol: contractTokenSymbol };
    } catch (error) {
      console.error('❌ Error checking collateral allowed status:', error);
      return { allowed: false, known: false, symbol: contractTokenSymbol };
    }
  }

  /** @deprecated Prefer checkCollateralAllowed — this fail-closed boolean hid wallet bugs. */
  static async isCollateralAllowed(tokenSymbol: string): Promise<boolean> {
    const r = await this.checkCollateralAllowed(tokenSymbol);
    // Only return false when the chain definitively said no.
    if (!r.known) return true;
    return r.allowed;
  }

  /**
   * CreditLayer `max_assets()` — how many distinct assets one margin account
   * may hold (10 on testnet).
   *
   * @returns The cap, or 0 when the read fails. Callers treat 0 as "unknown —
   *          let the contract enforce limits on execute".
   */
  static async getMaxAssetCap(): Promise<number> {
    const v = await readOr<number | bigint>(CREDIT_LAYER_ADDRESSES.CREDIT_LAYER, 'max_assets', [], 0);
    return Number(v) || 0;
  }

  /**
   * Whether the credit layer knows a token: it must be one of the four credit
   * assets with a reserve (`reserve_for`). Replaces the old Registry lookup.
   */
  static async isTokenConfigured(tokenSymbol: string): Promise<{ configured: boolean; error?: string }> {
    const contractTokenSymbol = this.normalizeContractTokenSymbol(tokenSymbol);
    if (!toCreditAsset(contractTokenSymbol)) {
      return { configured: false, error: `${contractTokenSymbol} is not supported by the credit layer.` };
    }
    return { configured: true };
  }

  /**
   * Deposit collateral from the wallet into a margin account via CreditLayer
   * `deposit_collateral(margin, token, wad)`.
   *
   * @param marginAccountAddress - Target MarginAccount C-address.
   * @param tokenSymbol - Token symbol or UI alias; normalized before use.
   * @param amountWad - Deposit amount as a u256 WAD (18-decimal) string.
   * @param _knownSequence - Ignored (kept for callers); invokeWrite reads a
   *                         fresh sequence and retries on txBadSeq.
   */
  static async depositCollateralTokens(
    marginAccountAddress: string,
    tokenSymbol: string,
    amountWad: string,
    _knownSequence?: string,
  ): Promise<WriteResult> {
    try {
      const sym = this.normalizeContractTokenSymbol(tokenSymbol);
      if (!toCreditAsset(sym)) return { success: false, error: `${sym} cannot be deposited as collateral.` };
      if (BigInt(amountWad) <= BigInt(0)) return { success: false, error: 'Please enter a valid amount' };

      const allowed = await this.checkCollateralAllowed(sym);
      if (allowed.known && !allowed.allowed) {
        return { success: false, error: `${this.displaySymbol(sym)} is not allowed as collateral.` };
      }

      const res = await CreditLayer.depositCollateral(marginAccountAddress, sym, amountWad);
      return this.toWriteResult(res, 'generic');
    } catch (error: any) {
      console.error('❌ Error depositing collateral tokens:', error);
      return { success: false, error: error?.message || 'Failed to deposit collateral tokens' };
    }
  }

  /**
   * Withdraw collateral from a margin account back to the trader's wallet via
   * CreditLayer `withdraw_collateral`. The contract allows it while the
   * account stays above the 1.2 health factor (Trade prices) — always when
   * there is no debt.
   *
   * @param marginAccountAddress - Source MarginAccount C-address.
   * @param tokenSymbol - Token symbol or UI alias; normalized before use.
   * @param amountWad - Withdraw amount as a u256 WAD (18-decimal) string.
   */
  static async withdrawCollateralBalance(
    marginAccountAddress: string,
    tokenSymbol: string,
    amountWad: string,
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
    try {
      const sym = this.normalizeContractTokenSymbol(tokenSymbol);
      if (!toCreditAsset(sym)) return { success: false, error: `${sym} cannot be withdrawn here.` };
      const res = await CreditLayer.withdrawCollateral(marginAccountAddress, sym, amountWad);
      return this.toWriteResult(res, 'withdraw');
    } catch (error: any) {
      console.error('❌ Error withdrawing collateral tokens:', error);
      return { success: false, error: this.formatUserFacingContractError(error?.message || error, 'withdraw') };
    }
  }

  /**
   * Borrow from a reserve into a margin account via CreditLayer `borrow`.
   * The borrowed funds land in the margin account; the contract then requires
   * health factor > 1.2 at Trade prices. Pre-checks reserve liquidity and the
   * 95% utilization cap so a doomed borrow never prompts for a signature.
   *
   * @param marginAccountAddress - Borrowing MarginAccount C-address.
   * @param tokenSymbol - Token symbol or UI alias; normalized before use.
   * @param borrowAmountWad - Borrow amount as a u256 WAD (18-decimal) string.
   * @param _knownSequence - Ignored (kept for callers).
   */
  static async borrowTokens(
    marginAccountAddress: string,
    tokenSymbol: string,
    borrowAmountWad: string,
    _knownSequence?: string,
  ): Promise<WriteResult> {
    const sym = this.normalizeContractTokenSymbol(tokenSymbol);
    try {
      if (!toCreditAsset(sym)) return { success: false, error: `${sym} cannot be borrowed.` };
      const liquidityCheck = await this.checkPoolLiquidity(sym, Number(borrowAmountWad) / 1e18);
      if (!liquidityCheck.ok) return { success: false, error: liquidityCheck.error };

      // Health pre-check (the release contract's panic text is stripped, so a
      // failed health assert would only surface as a generic InvalidAction).
      // Borrowed funds land in the account: allowed while
      // (C + B) / (D + B) > L  =>  B < (C - L·D) / (L - 1), L = live borrow_limit.
      const [health, px, limits] = await Promise.all([
        this.getMarginHealth(marginAccountAddress),
        priceUsd(tokenAddressFor(sym)),
        getHealthLimits(),
      ]);
      if (health && px > 0) {
        const borrowUsd = (Number(borrowAmountWad) / 1e18) * px;
        // Per-account debt cap (CreditLayer max_account_debt), checked on-chain after the borrow.
        if (limits.maxAccountDebtUsd !== null && health.debtUsd + borrowUsd > limits.maxAccountDebtUsd) {
          const left = Math.max(0, limits.maxAccountDebtUsd - health.debtUsd);
          return {
            success: false,
            error:
              `Borrow not allowed: one account can owe at most ${limits.maxAccountDebtUsd.toFixed(2)} USD. ` +
              `You can borrow about ${left.toFixed(2)} USD (${(left / px).toFixed(4)} ${this.displaySymbol(sym)}) more.`,
          };
        }
        const roomUsd = maxBorrowUsd(health.collateralUsd, health.debtUsd, 0, limits.borrowLimit);
        if (borrowUsd > roomUsd) {
          return {
            success: false,
            error:
              `Borrow not allowed for ${this.displaySymbol(sym)}: it would push your health factor below ${limits.borrowLimit}. ` +
              `You can borrow at most about ${roomUsd.toFixed(2)} USD (${(roomUsd / px).toFixed(4)} ${this.displaySymbol(sym)}) right now. ` +
              `Add collateral or repay debt first.`,
          };
        }
      }

      const res = await CreditLayer.borrow(marginAccountAddress, sym, borrowAmountWad);
      if (res.success) return { success: true, hash: res.hash };
      if (/rejected in the wallet/i.test(res.error || '')) return { success: false, error: res.error };
      return { success: false, hash: res.hash, error: this.parseBorrowNotAllowedMessage(res.error, this.displaySymbol(sym)) };
    } catch (error: any) {
      console.error('❌ Error borrowing tokens:', error);
      return { success: false, error: error?.message || 'Failed to borrow tokens' };
    }
  }

  /**
   * Old one-time admin bootstrap (max asset cap + collateral allow-list on the
   * AccountManager). The credit layer is configured by its deploy script
   * (deploy/deploy.sh), so this is a no-op kept for callers.
   */
  static async setupContractConfiguration(): Promise<{ success: boolean; error?: string; transactionHashes?: string[] }> {
    return {
      success: true,
      error: 'Nothing to configure: the credit layer is configured at deploy time (collateral allow-list and max assets are set by the deploy script).',
      transactionHashes: [],
    };
  }

  /**
   * Liveness probe for a margin account: `owner_of(margin)` on the credit
   * layer resolves only for accounts it created.
   */
  static async testContractInteraction(marginAccountAddress: string): Promise<boolean> {
    try {
      return Boolean(await ownerOf(marginAccountAddress));
    } catch {
      return false;
    }
  }

  /**
   * Read a margin account's current per-token debt: `margin.debts()` then each
   * reserve's `debt_of(margin)` (WAD), priced via the oracle. USDC/BLUSDC
   * aliases are mirrored so both keys stay populated for the UI.
   *
   * @returns `{ success, data?, error?, partial? }` where `data` maps token
   *          symbol → `{ amount, usdValue }`; an account with no debt yields `{}`.
   */
  static async getCurrentBorrowedBalances(
    marginAccountAddress: string,
    options: { includePrices?: boolean } = {},
  ): Promise<{
    success: boolean;
    data?: Record<string, { amount: string; usdValue: string }>;
    error?: string;
    /** true when `data` is missing one or more debt legs that failed to read
     *  even after retry — never trust `data` as the account's complete debt
     *  when this is set (see the caller-side handling in account-snapshot.ts). */
    partial?: boolean;
  }> {
    if (!marginAccountAddress || typeof marginAccountAddress !== 'string' || marginAccountAddress.length < 10) {
      return { success: false, error: 'Invalid margin account address' };
    }
    try {
      const p = await readMarginPortfolio(marginAccountAddress, {
        includePrices: options.includePrices,
        includeVenues: false,
        includeValue: false,
      });
      if (p.debtsPartial) {
        return {
          success: false,
          data: p.debts,
          error: 'One or more debt reads failed after retries — this data is incomplete',
          partial: true,
        };
      }
      return { success: true, data: p.debts };
    } catch (error: any) {
      console.error('❌ Error getting borrowed balances:', error);
      return { success: false, error: error?.message || 'Failed to get borrowed balances' };
    }
  }

  /**
   * Read the exact outstanding debt for one token at full WAD precision
   * (reserve `debt_of(margin)`, includes accrued interest up to now).
   *
   * @returns `{ success, debtWad?, amount?, error? }` — `debtWad` is the raw
   *          u256 WAD string; `amount` is the same value divided by 1e18.
   */
  static async getBorrowedTokenDebtWad(
    marginAccountAddress: string,
    tokenSymbol: string,
  ): Promise<{ success: boolean; debtWad?: string; amount?: string; error?: string }> {
    try {
      if (!marginAccountAddress || typeof marginAccountAddress !== 'string' || marginAccountAddress.length < 10) {
        return { success: false, error: 'Invalid margin account address' };
      }
      const sym = this.normalizeContractTokenSymbol(tokenSymbol);
      const asset = toCreditAsset(sym);
      if (!asset) return { success: false, error: `Unsupported asset: ${tokenSymbol}` };
      const wad = BigInt(
        await simulateRead<bigint>(CREDIT_ASSETS[asset].reserve, 'debt_of', [sc.address(marginAccountAddress)]),
      );
      return { success: true, debtWad: wad.toString(), amount: wadToNumber(wad).toFixed(7) };
    } catch (error: any) {
      return { success: false, error: this.formatUserFacingContractError(error?.message || error, 'repay') };
    }
  }

  /**
   * Read how much of `tokenSymbol` the margin account actually holds,
   * returned as a u256 WAD string (token is 7-dec stroops → WAD = stroops * 1e11).
   * Returns null on any read failure (caller then doesn't cap).
   */
  static async getMarginAccountTokenBalanceWad(marginAccountAddress: string, tokenSymbol: string): Promise<string | null> {
    try {
      const sym = this.normalizeContractTokenSymbol(tokenSymbol);
      if (!toCreditAsset(sym)) return null;
      const stroops = BigInt(
        await simulateRead<bigint>(tokenAddressFor(sym), 'balance', [sc.address(marginAccountAddress)]),
      );
      return stroopsToWad(stroops).toString();
    } catch {
      return null;
    }
  }

  /**
   * Read a margin account's holdings, priced in USD: plain tokens
   * (token.balance(margin)), plus — unless `includeFarm: false` — the Soroswap
   * LP pair token and the Aquarius share token held by the account and its
   * Blend supply (BLEND_VALUER.positions). USDC/BLUSDC aliases are mirrored.
   *
   * @returns `{ success, data?, error? }` where `data` maps symbol →
   *          `{ amount, usdValue }`; empty collateral yields `{}`.
   */
  static async getCollateralBalances(
    marginAccountAddress: string,
    options: { includeFarm?: boolean; includePrices?: boolean } = {},
  ): Promise<{ success: boolean; data?: Record<string, { amount: string; usdValue: string }>; error?: string }> {
    if (!marginAccountAddress || typeof marginAccountAddress !== 'string' || marginAccountAddress.length < 10) {
      return { success: false, error: 'Invalid margin account address' };
    }
    try {
      const p = await readMarginPortfolio(marginAccountAddress, {
        includePrices: options.includePrices,
        includeVenues: options.includeFarm !== false,
        includeValue: false,
      });
      const data: BalanceMap = options.includeFarm === false ? p.tokens : p.collateral;
      return { success: true, data: addUsdcAliases(data) };
    } catch (error: any) {
      console.error('❌ Error getting collateral balances:', error);
      return { success: false, error: error?.message || 'Failed to get collateral balances' };
    }
  }

  /**
   * Contract-side health: CreditLayer `margin_value(margin)` (Liquidation
   * prices). HF = collateral / debt; healthy iff HF > 1.2. Borrowed funds stay
   * in the account, so they count as collateral too — the max-borrow figure
   * accounts for that (see margin-credit-reads.ts maxBorrowUsd).
   */
  static async getMarginHealth(marginAccountAddress: string): Promise<{
    collateralUsd: number;
    debtUsd: number;
    healthFactor: number;
    healthy: boolean;
    maxBorrowUsd: number;
    maxWithdrawUsd: number;
  } | null> {
    try {
      const [v, limits] = await Promise.all([marginValue(marginAccountAddress), getHealthLimits()]);
      const collateralUsd = wadToNumber(v.collateralWad);
      const debtUsd = wadToNumber(v.debtWad);
      const healthFactor = debtUsd > 0 ? collateralUsd / debtUsd : Infinity;
      return {
        collateralUsd,
        debtUsd,
        healthFactor,
        // Liquidatable at HF <= liquidation_threshold; new debt needs HF > borrow_limit.
        healthy: !(debtUsd > 0) || healthFactor > limits.liquidationThreshold,
        maxBorrowUsd: maxBorrowUsd(collateralUsd, debtUsd, 0.005, limits.borrowLimit),
        maxWithdrawUsd: maxWithdrawUsd(collateralUsd, debtUsd, 0.005, limits.borrowLimit),
      };
    } catch {
      return null;
    }
  }

  /**
   * Repay debt on a margin account via CreditLayer `repay(margin, token, wad)`.
   *
   * The contract pays from the MARGIN ACCOUNT's own balance of the token and
   * caps the payment at the live debt (so a padded "repay all" amount is
   * safe). If the account holds less than what this repay needs, the shortfall
   * is first deposited from the wallet (`deposit_collateral`, its own
   * signature), then the repay is sent.
   *
   * @param repayAmountWad - Repay amount as a u256 WAD string; may exceed the
   *                         debt (capped on-chain).
   * @returns `{ success, hash?, error?, repaidAmountWad? }`.
   */
  static async repayLoan(
    marginAccountAddress: string,
    tokenSymbol: string,
    repayAmountWad: string,
    /** Progress-step display override, in token units (e.g. "500.03"). Use
     *  when `repayAmountWad` has been padded above the caller's intended
     *  amount — the contract clamps it back down to the debt. */
    displayAmountOverride?: string,
  ): Promise<{ success: boolean; hash?: string; error?: string; repaidAmountWad?: string }> {
    try {
      const sym = this.normalizeContractTokenSymbol(tokenSymbol);
      if (!toCreditAsset(sym)) return { success: false, error: `Unsupported asset: ${tokenSymbol}` };
      const requested = BigInt(repayAmountWad);
      if (requested <= BigInt(0)) return { success: false, error: 'Nothing to repay for this token' };

      const [debtRes, balWadStr] = await Promise.all([
        this.getBorrowedTokenDebtWad(marginAccountAddress, sym),
        this.getMarginAccountTokenBalanceWad(marginAccountAddress, sym),
      ]);
      const debtWad = debtRes.success && debtRes.debtWad ? BigInt(debtRes.debtWad) : null;
      if (debtWad !== null && debtWad === BigInt(0)) {
        return { success: false, error: `No ${this.displaySymbol(sym)} debt to repay.` };
      }

      // What this repay will pull from the account: the requested amount, but
      // never more than the debt plus a small interest margin (5 bps, min 1 stroop).
      let needWad = requested;
      if (debtWad !== null) {
        const margin = debtWad / BigInt(2000) > BigInt(1e11) ? debtWad / BigInt(2000) : BigInt(1e11);
        const cap = debtWad + margin;
        if (needWad > cap) needWad = cap;
      }
      const balWad = balWadStr != null ? BigInt(balWadStr) : null;

      if (balWad !== null && balWad < needWad) {
        // Top up the shortfall from the wallet, rounded up to whole stroops.
        const unit = BigInt(1e11);
        const shortWad = ((needWad - balWad + unit - BigInt(1)) / unit) * unit;
        const wallet = await connectedAddress();
        if (!wallet) return { success: false, error: 'Wallet not connected' };
        const check = await this.checkWalletBalanceForDeposit(wallet, sym, Number(shortWad) / 1e18);
        if (!check.ok) {
          return {
            success: false,
            error: `Your margin account holds less ${this.displaySymbol(sym)} than this repay needs, and the wallet cannot cover the ${(Number(shortWad) / 1e18).toFixed(7)} shortfall. ${check.error}`,
          };
        }
        showTxStep(`Moving ${(Number(shortWad) / 1e18).toFixed(7)} ${this.displaySymbol(sym)} from your wallet to the margin account`);
        const dep = await CreditLayer.depositCollateral(marginAccountAddress, sym, shortWad);
        if (!dep.success) {
          return { success: false, error: `Could not move the repay shortfall into the margin account: ${dep.error}. Nothing was repaid.` };
        }
        await this.waitForCollateralSync(marginAccountAddress, sym, needWad);
      }

      const repayAmountDisplay = displayAmountOverride ?? (Number(repayAmountWad) / 1e18).toFixed(7);
      showTxStep(`Repaying ${repayAmountDisplay} ${tokenSymbol}`);
      const res = await CreditLayer.repay(marginAccountAddress, sym, requested);
      if (!res.success) {
        console.error('❌ Repay tx did not succeed:', res);
        return { success: false, hash: res.hash, error: this.formatUserFacingContractError(res.error, 'repay') };
      }
      const paid = debtWad !== null && requested > debtWad ? debtWad : requested;
      return { success: true, hash: res.hash, repaidAmountWad: paid.toString() };
    } catch (error: any) {
      console.error('❌ Error repaying loan:', error);
      return { success: false, error: this.formatUserFacingContractError(error?.message || error, 'repay') };
    }
  }

  /**
   * Liquidate an unhealthy margin account (HF ≤ 1.2 at Liquidation prices).
   *
   * Two steps, each its own signature (liquidate.rs):
   *   1. If the account has venue positions (Blend), `liquidate(liquidator,
   *      margin, close_venues=true)` unwinds them back into the account.
   *   2. For each debt token, approve the CreditLayer to pull the debt from
   *      the liquidator's wallet (`token.approve`), then
   *      `liquidate(liquidator, margin, false)` repays ALL debt via
   *      transfer_from and sweeps everything the account holds to the
   *      liquidator. There is no bonus; profit = collateral − debt.
   *
   * @param liquidatorAddress  Wallet that pays the debt and receives collateral (must sign).
   * @param marginAccountAddress  The margin account to liquidate.
   */
  static async liquidateMarginAccount(
    liquidatorAddress: string,
    marginAccountAddress: string,
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
    try {
      const healthy = await readOr<boolean | null>(CREDIT_LAYER_ADDRESSES.CREDIT_LAYER, 'is_healthy', [sc.address(marginAccountAddress)], null);
      if (healthy === true) return { success: false, error: 'This margin account is healthy and cannot be liquidated.' };

      const assets = await marginAssets(marginAccountAddress);
      if (assets.venues.length > 0) {
        showTxStep('Liquidation step 1: closing venue positions');
        const r1 = await CreditLayer.liquidate(liquidatorAddress, marginAccountAddress, true);
        if (!r1.success) return { success: false, hash: r1.hash, error: `Closing venue positions failed: ${r1.error}` };
      }

      // Approve each debt token for the CreditLayer (debt + 1% for interest).
      const debts = await marginDebts(marginAccountAddress);
      const latest = await rpc().getLatestLedger();
      for (const token of debts) {
        const asset = creditAssetForToken(token);
        if (!asset) continue;
        const wad = BigInt(await simulateRead<bigint>(CREDIT_ASSETS[asset].reserve, 'debt_of', [sc.address(marginAccountAddress)]));
        if (wad <= BigInt(0)) continue;
        const native = wad / BigInt(1e11) + BigInt(1);
        const allowance = native + native / BigInt(100) + BigInt(10);
        showTxStep(`Approving ${asset} for liquidation`);
        const ap = await invokeWrite(
          token,
          'approve',
          [sc.address(liquidatorAddress), sc.address(CREDIT_LAYER_ADDRESSES.CREDIT_LAYER), StellarSdk.nativeToScVal(allowance, { type: 'i128' }), StellarSdk.nativeToScVal(latest.sequence + 1000, { type: 'u32' })],
          'Approve',
        );
        if (!ap.success) return { success: false, error: `Approving ${asset} failed: ${ap.error}` };
      }

      showTxStep('Liquidation: repaying debt and sweeping collateral');
      const r2 = await CreditLayer.liquidate(liquidatorAddress, marginAccountAddress, false);
      if (!r2.success) {
        return {
          success: false,
          hash: r2.hash,
          error: `Liquidation failed${assets.venues.length > 0 ? ' after venue positions were closed' : ''}: ${r2.error}`,
        };
      }
      return { success: true, hash: r2.hash };
    } catch (error: any) {
      console.error('❌ Error liquidating margin account:', error);
      return { success: false, error: this.formatUserFacingContractError(error?.message || error, 'generic') };
    }
  }

  /**
   * Recent borrow/repay history for a margin account from CreditLayer
   * `borrowed` / `repaid` events (RPC retention, ~7 days), newest-first, at
   * most 50. Full history (Mercury + RPC, incl. deposits/withdrawals) lives in
   * hooks/use-margin.ts → useMarginHistory.
   */
  static async getMarginTransactionHistory(
    marginAccountAddress: string,
  ): Promise<{ type: 'borrow' | 'repay'; asset: string; amount: string; timestamp: number; hash: string }[]> {
    try {
      const rows = await getMarginHistoryFromRpc(marginAccountAddress);
      return rows
        .filter((r): r is typeof r & { type: 'borrow' | 'repay' } => r.type === 'borrow' || r.type === 'repay')
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 50);
    } catch (err: any) {
      console.warn('[MarginAccountService] getMarginTransactionHistory error:', err?.message ?? err);
      return [];
    }
  }

  /**
   * "Open position" for Blend: deposit collateral, optionally borrow, then
   * supply the combined amount to Blend through CreditLayer `margin_execute`
   * (target BLEND_POOL, action Supply). The credit layer has no combined
   * entry point, so these are up to three transactions, each with its own
   * signature; a failure after the first one reports exactly what already
   * happened.
   *
   * @param collateralAmount - Collateral to deposit, in token units (> 0).
   * @param borrowAmount - Amount to borrow, in token units (0 = deposit-only 1x).
   * @param tokenSymbol - Token symbol or UI alias (default 'XLM'); normalized.
   */
  static async depositBorrowAndDeployBlendAtomic(
    marginAccountAddress: string,
    collateralAmount: number,
    borrowAmount: number,
    tokenSymbol: string = 'XLM',
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
    const sym = this.normalizeContractTokenSymbol(tokenSymbol);
    const disp = this.displaySymbol(sym);
    if (!collateralAmount || collateralAmount <= 0) {
      return { success: false, error: 'Please enter a valid collateral amount' };
    }
    if (sym !== 'XLM' && sym !== 'USDC') {
      return { success: false, error: `Blend supply supports XLM and USDC only (got ${disp}).` };
    }

    const dep = await this.depositAndBorrow(marginAccountAddress, collateralAmount, 1, sym, {
      borrowTokenSymbol: sym,
      borrowAmountTokens: Math.max(0, borrowAmount),
    });
    if (!dep.success) return { success: false, hash: dep.hash, error: dep.error };

    const totalWad = numberAmountToWad(collateralAmount + Math.max(0, borrowAmount));
    showTxStep(`Supplying ${(collateralAmount + Math.max(0, borrowAmount)).toFixed(7)} ${disp} to Blend`);
    const ex = await CreditLayer.execute(marginAccountAddress, CONTRACT_ADDRESSES.BLEND_POOL, 'Supply', [tokenAddressFor(sym)], [totalWad]);
    if (!ex.success) {
      return {
        success: false,
        hash: dep.hash,
        error:
          `Deposit${borrowAmount > 0 ? ' and borrow' : ''} succeeded, but supplying to Blend failed: ${ex.error}. ` +
          `The funds are in your margin account; you can supply them from the Farm page or withdraw them.`,
      };
    }
    return { success: true, hash: ex.hash };
  }

  /**
   * Deposit then borrow (leverage), as two sequential transactions (deposit,
   * then borrow — each its own signature). Same-asset or cross-asset.
   *
   * `borrowAmount` is `depositAmount × (multiplier - 1)` unless the caller
   * passes an explicit `borrowAmountTokens` (cross-asset callers price it).
   * A failed borrow after a successful deposit is reported as a partial
   * success: the collateral stays in the margin account.
   *
   * @returns `{ success, hash?, error? }` — `hash` is the last confirmed tx.
   */
  static async depositAndBorrow(
    marginAccountAddress: string,
    depositAmount: number,
    multiplier: number,
    tokenSymbol: string = 'XLM',
    options?: { borrowTokenSymbol?: string; borrowAmountTokens?: number },
  ): Promise<WriteResult> {
    try {
      const depositSym = this.normalizeContractTokenSymbol(tokenSymbol);
      const borrowSym = options?.borrowTokenSymbol ? this.normalizeContractTokenSymbol(options.borrowTokenSymbol) : depositSym;

      const borrowAmountTokens =
        options?.borrowAmountTokens != null ? options.borrowAmountTokens : multiplier > 1 ? depositAmount * (multiplier - 1) : 0;

      const configCheck = await this.isTokenConfigured(depositSym);
      if (!configCheck.configured) return { success: false, error: configCheck.error };
      const allowed = await this.checkCollateralAllowed(depositSym);
      if (allowed.known && !allowed.allowed) {
        return { success: false, error: `${this.displaySymbol(depositSym)} is not allowed as collateral.` };
      }

      const wallet = await connectedAddress();
      if (!wallet) return { success: false, error: 'Failed to get user address' };
      const walletCheck = await this.checkWalletBalanceForDeposit(wallet, depositSym, depositAmount);
      if (!walletCheck.ok) return { success: false, error: walletCheck.error };

      if (borrowAmountTokens > 0) {
        const liquidityCheck = await this.checkPoolLiquidity(borrowSym, borrowAmountTokens);
        if (!liquidityCheck.ok) return { success: false, error: liquidityCheck.error };
      }

      let lastHash: string | undefined;
      if (depositAmount > 0) {
        showTxStep(`Depositing ${depositAmount} ${this.displaySymbol(depositSym)}`);
        const dep = await this.depositCollateralTokens(marginAccountAddress, depositSym, numberAmountToWad(depositAmount).toString());
        if (!dep.success) return { success: false, error: `Deposit failed: ${dep.error}` };
        lastHash = dep.hash;
      }

      if (borrowAmountTokens > 0) {
        showTxStep(`Borrowing ${borrowAmountTokens.toFixed(7)} ${this.displaySymbol(borrowSym)}`);
        const br = await this.borrowTokens(marginAccountAddress, borrowSym, numberAmountToWad(borrowAmountTokens).toString());
        if (!br.success) {
          return {
            success: false,
            hash: lastHash,
            error:
              (depositAmount > 0
                ? `Your deposit of ${depositAmount} ${this.displaySymbol(depositSym)} succeeded (tx ${lastHash}), but the borrow failed: `
                : 'Borrow failed: ') + (br.error || 'unknown error'),
          };
        }
        lastHash = br.hash;
      }

      return { success: true, hash: lastHash };
    } catch (error: any) {
      console.error('❌ Error in depositAndBorrow:', error);
      return { success: false, error: this.formatUserFacingContractError(error?.message || error, 'borrow') };
    }
  }

  /** Maps an invokeWrite result onto the service's `{ success, hash, error }` shape with friendly errors. */
  private static toWriteResult(res: TxResult, action: 'repay' | 'borrow' | 'withdraw' | 'generic'): WriteResult {
    if (res.success) return { success: true, hash: res.hash };
    return { success: false, hash: res.hash, error: this.formatUserFacingContractError(res.error, action) };
  }
}
