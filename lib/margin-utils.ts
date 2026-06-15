import * as StellarSdk from '@stellar/stellar-sdk';
import { getAddress, signTransaction } from '@stellar/freighter-api';
import { CONTRACT_ADDRESSES, NETWORK_PASSPHRASE, SOROBAN_RPC_URL, ContractService } from './stellar-utils';
import { BlendService } from './blend-utils';
import { mergeFarmTrackingCollateralIntoBalances } from '@/lib/analytics/stellar/farmTrackingCollateral';
import { fetchTokenPrice, getCachedTokenPrice } from './oracle-price';

// Types
export interface MarginAccount {
  address: string;
  owner: string;
  isActive: boolean;
  createdAt: number;
  accountManagerAddress?: string;
}

export interface MarginAccountCreationResult {
  success: boolean;
  marginAccountAddress?: string;
  hash?: string;
  error?: string;
}

// Margin account management class
export class MarginAccountService {
  // Local storage key for margin accounts
  private static STORAGE_KEY = 'vanna_margin_accounts';

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
      return `Borrow simulation exceeded Soroban resource limits for ${tokenSymbol}. Please retry once; if it persists, reduce borrow size slightly or increase transaction resources.`;
    }

    if (text.includes('InvalidAction') || text.includes('UnreachableCodeReached')) {
      return `Borrow action rejected for ${tokenSymbol}. This usually means borrow constraints are not satisfied (health factor, debt limit, or collateral requirements).`;
    }

    return `Borrow failed for ${tokenSymbol}. Please check collateral, existing debt, and risk limits, then retry.`;
  }

  private static formatUserFacingContractError(raw: any, action: 'repay' | 'borrow' | 'withdraw' | 'generic' = 'generic'): string {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
    const compact = text.split('\nEvent log')[0]?.trim() || text;

    if (action === 'repay') {
      if (
        compact.includes('Error(Object, ArithDomain)') ||
        compact.includes('ArithDomain') ||
        compact.includes('collect_from') ||
        compact.includes('u256_sub')
      ) {
        return 'Repay amount is slightly above the live outstanding debt (rounding/interest update). Please retry with 100% again or use a slightly lower amount.';
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
   * Get stored margin account for a user
   */
  static getStoredMarginAccount(userAddress: string): MarginAccount | null {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (!stored) return null;
      
      const accounts: Record<string, MarginAccount> = JSON.parse(stored);
      const account = accounts[userAddress] || null;
      if (!account) return null;

      // Safety: invalidate accounts stored under an older AccountManager deployment.
      if (account.accountManagerAddress !== CONTRACT_ADDRESSES.ACCOUNT_MANAGER) {
        return null;
      }
      return account;
    } catch (error) {
      console.error('Error reading margin account from storage:', error);
      return null;
    }
  }

  /**
   * Store margin account for a user
   */
  static storeMarginAccount(userAddress: string, marginAccount: MarginAccount): void {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY) || '{}';
      const accounts: Record<string, MarginAccount> = JSON.parse(stored);
      
      accounts[userAddress] = {
        ...marginAccount,
        accountManagerAddress: CONTRACT_ADDRESSES.ACCOUNT_MANAGER,
      };
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(accounts));
    } catch (error) {
      console.error('Error storing margin account:', error);
    }
  }

  /**
   * Check if user has a margin account
   */
  static hasMarginAccount(userAddress: string): boolean {
    const account = this.getStoredMarginAccount(userAddress);
    return account !== null && account.isActive;
  }

  /**
   * Create a new margin account by calling the smart contract
   * STRICT ENFORCEMENT: Only creates if no existing account found
   */
  static async createMarginAccount(
    userAddress: string
  ): Promise<MarginAccountCreationResult> {
    try {
      
      // STEP 1: Check localStorage first
      const existingAccount = this.getStoredMarginAccount(userAddress);
      if (existingAccount && existingAccount.isActive) {
        return {
          success: true,
          marginAccountAddress: existingAccount.address,
          error: 'User already has an active margin account (localStorage)'
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

      // Step 3: filter by activity. Newest-first so we prefer the most recent
      // account when a trader has reused inactive slots.
      for (let i = candidates.length - 1; i >= 0; i--) {
        const accountAddress = candidates[i];
        try {
          const isActive = await this.isAccountActive(accountAddress, server, userAddress);

          if (isActive) {
            const marginAccount: MarginAccount = {
              address: accountAddress,
              owner: userAddress,
              isActive: true,
              createdAt: Date.now(),
            };

            this.storeMarginAccount(userAddress, marginAccount);
            return accountAddress;
          }
        } catch (accountError) {
          console.warn('⚠️ Error checking account activity for:', accountAddress, accountError);
        }
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
   * always returned []. This is the only path that recovers a margin account
   * for a wallet on a fresh origin (no localStorage), e.g. when the user
   * connects on the deployed URL after creating their account on localhost.
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
  private static async isAccountActive(
    accountAddress: string,
    server: StellarSdk.rpc.Server,
    sourceUserAddress: string,
  ): Promise<boolean> {
    try {

      // Create contract client for the smart account
      const contract = new StellarSdk.Contract(accountAddress);
      const call = contract.call('is_account_active');

      // Create a transaction to simulate the call
      const transaction = new StellarSdk.TransactionBuilder(
        new StellarSdk.Account(sourceUserAddress, '0'),
        { fee: '100', networkPassphrase: NETWORK_PASSPHRASE }
      )
      .addOperation(call)
      .setTimeout(30)
      .build();
      
      const result = await server.simulateTransaction(transaction);
      
      // Check for simulation errors
      if ('error' in result && result.error) {
        console.warn('⚠️ Contract simulation failed for account:', accountAddress, result.error);
        return false;
      }
      
      // Check for successful simulation result
      if ('result' in result && result.result) {
        const isActive = StellarSdk.scValToNative(result.result.retval) === true;
        return isActive;
      }
      
      console.warn('⚠️ No valid result from account activity check');
      return false;
    } catch (error) {
      console.error('❌ Error checking account active status:', error);
      return false;
    }
  }

  /**
   * Get recent ledger for event querying with better range
   */
  private static async getRecentLedger(server: StellarSdk.rpc.Server): Promise<number> {
    try {
      const latestLedger = await server.getLatestLedger();
      // Soroban testnet RPC retains events for ~7 days; go back as far as we
      // can so accounts created earlier in the deployment lifetime are still
      // discoverable on a fresh origin (deployed URL without localStorage).
      const lookBackLedgers = 17280 * 7; // ~7 days of ledgers (5s blocks)
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
   * Public method to discover existing margin account from blockchain
   * Used when localStorage is empty but user might have account on blockchain
   */
  static async discoverExistingAccount(userAddress: string): Promise<string | null> {
    return await this.getMarginAccountFromRegistry(userAddress);
  }

  /**
   * Get margin account info (for display)
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
   * Format margin account address for display
   */
  static formatAccountAddress(address: string): string {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  /**
   * Clear stored margin account (for testing/reset)
   */
  static clearMarginAccount(userAddress: string): void {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY) || '{}';
      const accounts: Record<string, MarginAccount> = JSON.parse(stored);
      
      delete accounts[userAddress];
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(accounts));
    } catch (error) {
      console.error('Error clearing margin account:', error);
    }
  }

  /**
   * Check if a token is allowed as collateral
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
   * Get max asset cap from contract
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
   * Check if a token is properly configured in the Registry
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

      // Build function name based on token
      let functionName: string;
      if (contractTokenSymbol === 'XLM') {
        functionName = 'get_xlm_contract_adddress'; // Note: typo in contract
      } else if (contractTokenSymbol === 'BLUSDC' || contractTokenSymbol === 'USDC') {
        functionName = 'get_usdc_contract_address';
      } else if (contractTokenSymbol === 'AQUSDC') {
        functionName = 'get_aquarius_usdc_addr';
      } else if (contractTokenSymbol === 'SOUSDC') {
        functionName = 'get_soroswap_usdc_addr';
      } else {
        return { configured: false, error: `Unknown token: ${contractTokenSymbol}` };
      }

      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call(functionName))
        .setTimeout(30)
        .build();

      const simulationResult = await server.simulateTransaction(transaction);

      if ('error' in simulationResult && simulationResult.error) {
        console.warn(`⚠️ ${contractTokenSymbol} not configured in Registry:`, simulationResult.error);
        return { 
          configured: false, 
          error: `${contractTokenSymbol} token contract address not set in Registry. Please configure it first.` 
        };
      }

      if ('result' in simulationResult && simulationResult.result) {
        return { configured: true };
      }

      return { configured: false, error: 'Unable to verify token configuration' };
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
   * Deposit collateral tokens to margin account
   */
  static async depositCollateralTokens(
    marginAccountAddress: string,
    tokenSymbol: string,
    amountWad: string
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
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
      const sourceAccount = await server.getAccount(userAddress.address);

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

      const preparedTx = await server.prepareTransaction(transaction);
      
      // Sign the transaction
      const signResult = await signTransaction(preparedTx.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      const signedTx = StellarSdk.TransactionBuilder.fromXDR(
        signResult.signedTxXdr,
        NETWORK_PASSPHRASE
      );

      const result = await server.sendTransaction(signedTx as StellarSdk.Transaction);
      
      if (result.status === 'PENDING') {
        const finalResult = await this.pollTransactionStatus(server, result.hash);
        
        if (finalResult.status === 'SUCCESS') {
          return {
            success: true,
            hash: result.hash
          };
        } else {
          return {
            success: false,
            error: `Deposit transaction failed with status: ${finalResult.status}`
          };
        }
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
   * Withdraw collateral tokens from margin account back to trader wallet
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
        // Prepare also failed - this is also somewhat normal for budget-constrained operations
        console.warn('⚠️ Prepare transaction also encountered issues, but will attempt to send anyway');
        // Just use the original transaction envelope
        preparedTx = transaction;
      }

      const signResult = await signTransaction(preparedTx.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      const signedTx = StellarSdk.TransactionBuilder.fromXDR(
        signResult.signedTxXdr,
        NETWORK_PASSPHRASE
      );

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
   * Borrow tokens from lending pool to margin account - SIMPLIFIED VERSION
   */
  static async borrowTokens(
    marginAccountAddress: string,
    tokenSymbol: string,
    borrowAmountWad: string
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
    try {
      const contractTokenSymbol = this.normalizeContractTokenSymbol(tokenSymbol);
      
      const userAddress = await getAddress();
      if (userAddress.error) {
        return {
          success: false,
          error: 'Failed to get user address'
        };
      }

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(userAddress.address);

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
        const assembleTransaction = (StellarSdk as any)?.rpc?.assembleTransaction;
        if (typeof assembleTransaction === 'function' && 'result' in simulationResult && simulationResult.result) {
          const assembled = assembleTransaction(transaction, simulationResult);
          preparedTx = assembled.build();
        } else {
          preparedTx = await server.prepareTransaction(transaction);
        }
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

      const result = await server.sendTransaction(signedTx as StellarSdk.Transaction);
      
      
      if (result.status === 'PENDING') {
        const finalResult = await this.pollTransactionStatus(server, result.hash);
        
        if (finalResult.status === 'SUCCESS') {
          return {
            success: true,
            hash: result.hash
          };
        } else {
          console.error('❌ Borrow transaction failed after polling:', finalResult);
          return {
            success: false,
            error: `Borrow transaction failed with final status: ${finalResult.status}. Details: ${JSON.stringify(finalResult)}`
          };
        }
      } else if (result.status === 'ERROR') {
        console.error('❌ Borrow transaction failed immediately with ERROR status');
        console.error('Error details:', {
          errorResultXdr: result.errorResult?.toXDR(),
          diagnosticEvents: result.diagnosticEvents
        });
        
        // Try to extract more meaningful error information
        let errorMessage = this.parseBorrowNotAllowedMessage(result, contractTokenSymbol);
        
        if (result.errorResult) {
          try {
            const errorResult = result.errorResult;
            console.error('Detailed error result:', errorResult);
            errorMessage = `Transaction failed: ${errorResult.toXDR()}`;
          } catch (e) {
            console.error('Could not parse error result:', e);
          }
        }
        
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
   * Helper function to setup contract configuration (for admin use)
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
   * Test if basic contract interaction works with minimal operations
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
   * Get current borrowed token balances for a margin account
   * @param marginAccountAddress - The margin account address
   * @returns Object with borrowed token balances
   */
  static async getCurrentBorrowedBalances(
    marginAccountAddress: string
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
      const userAddress = await getAddress();
      if (userAddress.error) {
        return {
          success: false,
          error: 'Failed to get user address'
        };
      }
      
      const sourceAccount = await server.getAccount(userAddress.address);
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
      
      const preparedTx = await server.prepareTransaction(getAllBorrowedTokensTx);
      const simulationResult = await server.simulateTransaction(preparedTx);
      
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

      // Read debt only for tokens present in SmartAccount borrowed list.
      for (const token of borrowedTokens) {
        try {
          const getBalanceTx = new StellarSdk.TransactionBuilder(sourceAccount, {
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
          
          const preparedBalanceTx = await server.prepareTransaction(getBalanceTx);
          const balanceResult = await server.simulateTransaction(preparedBalanceTx);
          
          if (!('error' in balanceResult) && 'result' in balanceResult && balanceResult.result) {
            const balanceWad = StellarSdk.scValToNative(balanceResult.result.retval) as string;
            const balanceNumber = parseFloat(balanceWad) / Math.pow(10, 18); // Convert from WAD

            if (balanceNumber > 0) {
              // USD value comes straight from the on-chain Reflector oracle so
              // event-based callers that don't run the store's recompute still
              // see live prices instead of a 1:1 placeholder.
              const price = await fetchTokenPrice(token);
              const usdValue = (balanceNumber * price).toFixed(2);
              borrowedBalances[token] = {
                amount: balanceNumber.toFixed(6),
                usdValue
              };
            }
          }
        } catch (error) {
          console.warn(`⚠️ Failed to get balance for token ${token}:`, error);
        }
      }
      
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
   * Get exact borrowed debt for a token in raw WAD precision.
   * This is used by repay flow to avoid rounded overpay values.
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
        BLUSDC: CONTRACT_ADDRESSES.BLEND_USDC,
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
   * Get collateral balances for a margin account
   * @param marginAccountAddress - The margin account address
   * @returns Object with collateral token balances
   */
  static async getCollateralBalances(
    marginAccountAddress: string
  ): Promise<{ success: boolean; data?: Record<string, { amount: string; usdValue: string }>; error?: string }> {
    try {
      if (!marginAccountAddress || typeof marginAccountAddress !== 'string' || marginAccountAddress.length < 10) {
        return {
          success: false,
          error: 'Invalid margin account address'
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
      const contract = new StellarSdk.Contract(marginAccountAddress);

      const listTx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('get_all_collateral_tokens'))
        .setTimeout(30)
        .build();

      const preparedList = await server.prepareTransaction(listTx);
      const listSim = await server.simulateTransaction(preparedList);

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

      for (const token of collateralTokens) {
        try {
          const balTx = new StellarSdk.TransactionBuilder(sourceAccount, {
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

          const preparedBal = await server.prepareTransaction(balTx);
          const balSim = await server.simulateTransaction(preparedBal);

          if (!('error' in balSim) && 'result' in balSim && balSim.result) {
            const rawBal = StellarSdk.scValToNative(balSim.result.retval);
            const balanceWad = rawBal?.toString?.() ?? String(rawBal ?? '0');
            const balanceNumber = parseFloat(balanceWad) / Math.pow(10, 18);

            if (balanceNumber > 0) {
              const price = await fetchTokenPrice(token);
              const usdValue = (balanceNumber * price).toFixed(2);
              balances[token] = {
                amount: balanceNumber.toFixed(7),
                usdValue
              };
            }
          }
        } catch (err) {
          console.warn(`⚠️ Failed to read collateral balance for ${token}:`, err);
        }
      }

      const withFarm = await mergeFarmTrackingCollateralIntoBalances(marginAccountAddress, balances);
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
   * Repay borrowed tokens to margin account
   * @param marginAccountAddress - The margin account address
  * @param tokenSymbol - Token symbol to repay (XLM, USDC)
   * @param repayAmountWad - Amount to repay in WAD format
   * @returns Result with success status and transaction hash
   */
  static async repayLoan(
    marginAccountAddress: string,
    tokenSymbol: string,
    repayAmountWad: string
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
    try {
      // The contract's borrow() always stores the BLEND USDC pool's debt under the
      // BLUSDC symbol (account_manager.rs:329), regardless of whether the caller
      // passed USDC or BLUSDC. repay() then validates token_symbol against the
      // stored borrowed-tokens list, so we must pass BLUSDC for that pool — not
      // USDC, even though deposit_collateral_tokens prefers USDC.
      const normalized = this.normalizeContractTokenSymbol(tokenSymbol);
      const contractTokenSymbol = normalized === 'USDC' ? 'BLUSDC' : normalized;

      const userAddress = await getAddress();
      if (userAddress.error) {
        return {
          success: false,
          error: 'Failed to get user address'
        };
      }

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(userAddress.address);

      // Create contract instance for AccountManager
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);

      // Build the transaction to call repay
      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: (parseInt(StellarSdk.BASE_FEE) * 50).toString(),
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'repay',
            StellarSdk.nativeToScVal(repayAmountWad, { type: 'u256' }),
            StellarSdk.nativeToScVal(contractTokenSymbol, { type: 'symbol' }),
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

      const result = await server.sendTransaction(signedTx as StellarSdk.Transaction);

      if (result.status === 'PENDING') {
        const finalResult = await this.pollTransactionStatus(server, result.hash);

        if (finalResult.status === 'SUCCESS') {
          return {
            success: true,
            hash: result.hash
          };
        } else {
          // Surface the hash + log the full result (resultMetaXdr/diagnostics) so the
          // real on-chain reason is inspectable instead of a generic "failed".
          console.error('❌ Repay tx did not succeed:', {
            hash: result.hash,
            status: finalResult.status,
            result: JSON.stringify(finalResult, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
          });
          return {
            success: false,
            error: `Repay failed on-chain (${finalResult.status}). Tx: ${result.hash}`
          };
        }
      } else if (result.status === 'ERROR') {
        return {
          success: false,
          error: 'Repay transaction failed with ERROR status'
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
   * Get on-chain borrow/repay transaction history for a margin account.
   * Queries Trader_Borrow and Trader_Repay_Event events from the ACCOUNT_MANAGER contract.
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
   * Atomic one-click flow for Blend single-asset pools:
   * deposit collateral + optional borrow + deploy to Blend in one wallet signature.
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
   */
  static async depositAndBorrow(
    marginAccountAddress: string,
    depositAmount: number,
    multiplier: number,
    tokenSymbol: string = 'XLM',
    options?: { borrowTokenSymbol?: string; borrowAmountTokens?: number }
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
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

      const preparedTx = await server.prepareTransaction(transaction);
      const signResult = await signTransaction(preparedTx.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
      });
      const signedTx = StellarSdk.TransactionBuilder.fromXDR(
        signResult.signedTxXdr,
        NETWORK_PASSPHRASE
      );

      const result = await server.sendTransaction(signedTx as StellarSdk.Transaction);
      if (result.status !== 'PENDING') {
        return { success: false, error: `deposit_and_borrow rejected: ${result.status}` };
      }

      const finalResult = await this.pollTransactionStatus(server, result.hash);
      if (finalResult.status === 'SUCCESS') {
        return { success: true, hash: result.hash };
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
