// Aquarius (AMM) integration: multi-pool stats (live from the Aquarius AMM API
// with an on-chain fallback), LP positions/events, swap quotes, and add/remove-
// liquidity + chained swaps from both the margin account (AccountManager.execute,
// amounts in WAD 1e18) and the user's wallet. On-chain reserves/LP shares are
// 7-decimal (SCALAR_7). Pool reserve order is sorted by contract address, so
// reserves are re-mapped onto each pool config's token order before display.

import * as StellarSdk from '@stellar/stellar-sdk';
import { signTransaction } from '@/lib/wallet-adapter';
import {
  CONTRACT_ADDRESSES,
  HORIZON_URL,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
  ASSET_ISSUERS,
} from './stellar-utils';
import { floorAmountToStroops, stroopsToWad } from './utils/swap-amount';

// ── Aquarius Swap constants ─────────────────────────────────────────────────
// XLM Soroban token contract (wrapped native XLM on testnet)
const XLM_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
// Pool token order (sorted): TokenA = Aquarius USDC, TokenB = XLM
const POOL_SORTED_TOKENS = [CONTRACT_ADDRESSES.AQUARIUS_USDC, XLM_CONTRACT];

/** Build the swap_chained swaps_chain ScVal for a single-hop XLM↔USDC swap. */
function buildSwapsChain(tokenInContract: string, poolIndexBytes?: Buffer): StellarSdk.xdr.ScVal {
  const tokenOutContract = tokenInContract === XLM_CONTRACT
    ? CONTRACT_ADDRESSES.AQUARIUS_USDC
    : XLM_CONTRACT;
  const idxBytes = poolIndexBytes ?? Buffer.from(CONTRACT_ADDRESSES.AQUARIUS_POOL_INDEX_HEX, 'hex');

  // A single tuple: (Vec<Address>, BytesN<32>, Address)
  const hop = StellarSdk.xdr.ScVal.scvVec([
    StellarSdk.xdr.ScVal.scvVec(
      POOL_SORTED_TOKENS.map((a) => StellarSdk.nativeToScVal(a, { type: 'address' }))
    ),
    StellarSdk.xdr.ScVal.scvBytes(idxBytes),
    StellarSdk.nativeToScVal(tokenOutContract, { type: 'address' }),
  ]);
  return StellarSdk.xdr.ScVal.scvVec([hop]);
}

/** Aquarius action enum variant — must match the SmartAccount handler on-chain. */
export type AquariusAction = 'AddLiquidity' | 'RemoveLiquidity' | 'Swap';

/**
 * Per-pool stats. `reserveA`/`reserveB` are ordered to match the pool config's
 * `tokens`, NOT the on-chain sort. The `apy`/`volumeUsd`/etc. fields are only
 * populated when stats come from the Aquarius AMM API; the on-chain fallback
 * leaves them undefined.
 */
export interface AquariusPoolStats {
  /** Matches `AquariusPoolConfig.tokens[0]` (human-readable, 7 decimals). */
  reserveA: string;
  /** Matches `AquariusPoolConfig.tokens[1]`. */
  reserveB: string;
  totalShares: string; // total LP shares, human-readable
  feeFraction: string; // e.g., "0.30%"
  feeRaw: number;      // raw fee fraction (30 = 0.30%)
  // Optional API-sourced fields (populated when stats come from the
  // Aquarius AMM API; on-chain-only fallback paths leave these undefined).
  apy?: string;        // base trading APY, decimal string (e.g. "0.0234")
  totalApy?: string;   // base + incentive + rewards APY, decimal string
  volumeUsd?: string;  // aggregate USD volume (whatever window the API ships)
  liquidityUsd?: string; // pool TVL in USD
  poolType?: string;   // "constant_product" | "stable" | "concentrated"
}

/** A historical Aquarius deposit/withdraw-liquidity event (7-decimal strings). */
export interface AquariusLpEvent {
  type: 'deposit' | 'withdraw';
  shareAmount: string;  // LP shares minted/burned
  amountA: string;      // token A amount
  amountB: string;      // token B amount
  timestamp: number;    // unix ms
  txHash: string;
  ledger: number;
}

/** Static config for one Aquarius pool, including on-chain reserve index order. */
export interface AquariusPoolConfig {
  id: string;
  tokens: [string, string];
  /**
   * `get_reserves()` index order on the pool contract (sorted by token address).
   * When omitted, assumed equal to `tokens` (legacy — wrong for XLM/USDC).
   */
  onChainReserveSymbols?: [string, string];
  feeFraction: number; // 30 = 0.30%
  displayName: string;
  poolAddress: string;
}

/** Supported Aquarius pools (XLM/USDC, XLM/AQUA, XLM/USDT) with fee + addresses. */
export const AQUARIUS_POOLS: AquariusPoolConfig[] = [
  {
    id: 'aquarius-xlm-usdc',
    tokens: ['XLM', 'USDC'],
    onChainReserveSymbols: ['USDC', 'XLM'],
    feeFraction: 30,
    displayName: 'XLM / USDC',
    poolAddress: CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_POOL,
  },
  {
    id: 'aquarius-xlm-aqua',
    tokens: ['XLM', 'AQUA'],
    feeFraction: 30,
    displayName: 'XLM / AQUA',
    poolAddress: CONTRACT_ADDRESSES.AQUARIUS_XLM_AQUA_POOL,
  },
  {
    id: 'aquarius-xlm-usdt',
    tokens: ['XLM', 'USDT'],
    feeFraction: 30,
    displayName: 'XLM / USDT',
    poolAddress: CONTRACT_ADDRESSES.AQUARIUS_XLM_USDT_POOL,
  },
] as const;

/** Outcome of an Aquarius tx: success plus the hash, or an error message. */
export interface AquariusTransactionResult {
  success: boolean;
  hash?: string;
  error?: string;
}

const WAD = 1e18;
const LP_SHARE_SCALE = 1e7;
const AQUARIUS_AMM_API_BASE = 'https://amm-api-testnet.aqua.network';
const AQUARIUS_API_CACHE_TTL_MS = 60_000;
/** Bump when reserve→config mapping changes so stale cache is not reused. */
const AQUARIUS_API_POOL_STATS_CACHE_VERSION = 3;

interface AquariusApiPoolsResponse {
  items?: AquariusApiPoolItem[];
}

interface AquariusApiPoolItem {
  address?: string;
  reserves?: [string, string] | string[];
  // tokens_str is the API's ordered list of token symbols, matching the
  // alphabetical-by-contract-address sort of `reserves`. We use it to map
  // each AQUARIUS_POOLS config's token order onto the API's reserve order.
  tokens_str?: string[];
  fee?: string;
  total_share?: string;
  apy?: string;            // base trading APY (decimal string)
  total_apy?: string;      // base + incentives + rewards
  volume_usd?: string;     // aggregate USD volume
  liquidity_usd?: string;  // pool TVL in USD
  pool_type?: string;      // "constant_product" | "stable" | "concentrated"
}

const toWad = (amount: number): bigint => {
  if (!Number.isFinite(amount) || amount <= 0) return BigInt(0);
  return BigInt(Math.floor(amount * WAD));
};

const toLpShareUnits = (amount: number): bigint => {
  if (!Number.isFinite(amount) || amount <= 0) return BigInt(0);
  return BigInt(Math.floor(amount * LP_SHARE_SCALE));
};

const makeKey = (name: string) => StellarSdk.xdr.ScVal.scvSymbol(name);

const SCALAR_7 = 1e7;
const fromStroopScalar = (raw: string | undefined): string => {
  const n = parseFloat(raw ?? '0');
  return Number.isFinite(n) ? (n / SCALAR_7).toFixed(7) : '0';
};

/** Map on-chain reserve indices to `AquariusPoolConfig.tokens` order. */
export function mapAquariusReservesToConfig(
  cfg: AquariusPoolConfig | undefined,
  raw0: string | undefined,
  raw1: string | undefined,
): { reserveA: string; reserveB: string } {
  const [cfgTokenA, cfgTokenB] = cfg?.tokens ?? ['', ''];
  const onChainOrder = cfg?.onChainReserveSymbols ?? cfg?.tokens ?? ['', ''];
  const bySym: Record<string, string> = {};
  onChainOrder.forEach((sym, idx) => {
    const raw = idx === 0 ? raw0 : raw1;
    if (sym) bySym[sym.toUpperCase()] = fromStroopScalar(raw);
  });
  let reserveA = bySym[cfgTokenA?.toUpperCase()] ?? fromStroopScalar(raw0);
  let reserveB = bySym[cfgTokenB?.toUpperCase()] ?? fromStroopScalar(raw1);

  // API `tokens_str` is sometimes [XLM, USDC] while reserves stay [USDC, XLM].
  // For XLM/USDC, XLM reserve count should dwarf USDC (~96:1 on testnet).
  if (cfg?.id === 'aquarius-xlm-usdc') {
    const a = parseFloat(reserveA);
    const b = parseFloat(reserveB);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a * 10) {
      const tmp = reserveA;
      reserveA = reserveB;
      reserveB = tmp;
    }
  }

  return { reserveA, reserveB };
}

/** Pro-rata underlying token amounts for an LP position (config token order). */
export function aquariusLpUnderlyingAmounts(
  lpShares: number,
  stats: AquariusPoolStats,
  tokenA: string,
  tokenB: string,
): { amountA: number; amountB: number } {
  const totalShares = parseFloat(stats.totalShares);
  if (!(lpShares > 0) || !(totalShares > 0)) {
    return { amountA: 0, amountB: 0 };
  }
  const ratio = lpShares / totalShares;
  return {
    amountA: ratio * (parseFloat(stats.reserveA) || 0),
    amountB: ratio * (parseFloat(stats.reserveB) || 0),
  };
}

/**
 * Stateless façade over the Aquarius router + pools. Reads pool stats (live API
 * with on-chain fallback), LP balances/events, and swap quotes via simulation;
 * routes liquidity/swap writes through the margin account (AccountManager.execute,
 * WAD amounts) or the wallet directly. Resolves router/token/index from Registry
 * with hardcoded fallbacks. Caches AMM-API pool stats for
 * {@link AQUARIUS_API_CACHE_TTL_MS}. All methods are static.
 */
export class AquariusService {
  private static apiPoolStatsCache: {
    version: number;
    expiresAt: number;
    byAddress: Record<string, AquariusPoolStats>;
  } | null = null;

  private static async getAquariusApiPoolStatsByAddress(): Promise<Record<string, AquariusPoolStats>> {
    const now = Date.now();
    if (
      AquariusService.apiPoolStatsCache &&
      AquariusService.apiPoolStatsCache.version === AQUARIUS_API_POOL_STATS_CACHE_VERSION &&
      AquariusService.apiPoolStatsCache.expiresAt > now
    ) {
      return AquariusService.apiPoolStatsCache.byAddress;
    }

    const response = await fetch(`${AQUARIUS_AMM_API_BASE}/pools/?limit=200`);
    if (!response.ok) {
      throw new Error(`Aquarius API error: ${response.status}`);
    }

    const json = (await response.json()) as AquariusApiPoolsResponse;
    const byAddress: Record<string, AquariusPoolStats> = {};

    // The Aquarius API returns reserves as 7-decimal scaled raw strings
    // (e.g. "1313891897900000" = 131,389,189.79 / 1e7 = 131,389,189.79 USDC),
    // ordered alphabetically by token contract address — NOT in the order
    // that AQUARIUS_POOLS configs list their tokens. Without re-ordering,
    // the reserveA/reserveB labels would be flipped (XLM value shown under
    // USDC and vice versa). We map by symbol via `tokens_str` so the
    // returned reserveA always matches AQUARIUS_POOLS config tokens[0].
    for (const pool of json.items ?? []) {
      const address = (pool.address ?? '').trim().toUpperCase();
      if (!address) continue;

      const cfg = AQUARIUS_POOLS.find((p) => p.poolAddress.toUpperCase() === address);

      // Always map via on-chain reserve index order when we know it (XLM/USDC).
      // Do not trust tokens_str index alignment — API often lists symbols in
      // display order while reserves[] stays sorted by contract address.
      let mapped = mapAquariusReservesToConfig(
        cfg,
        pool.reserves?.[0],
        pool.reserves?.[1],
      );

      const totalShare = fromStroopScalar(pool.total_share);
      const feeRaw = Math.round((parseFloat(pool.fee ?? '0.003') || 0.003) * 10_000);

      byAddress[address] = {
        reserveA: mapped.reserveA,
        reserveB: mapped.reserveB,
        totalShares: totalShare,
        feeFraction: `${(feeRaw / 100).toFixed(2)}%`,
        feeRaw,
        apy: pool.apy,
        totalApy: pool.total_apy,
        volumeUsd: pool.volume_usd,
        liquidityUsd: pool.liquidity_usd,
        poolType: pool.pool_type,
      };
    }

    AquariusService.apiPoolStatsCache = {
      version: AQUARIUS_API_POOL_STATS_CACHE_VERSION,
      expiresAt: now + AQUARIUS_API_CACHE_TTL_MS,
      byAddress,
    };

    return byAddress;
  }

  private static async pollTransactionStatus(
    server: StellarSdk.rpc.Server,
    hash: string
  ): Promise<void> {
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      const transaction = await server.getTransaction(hash);
      if (transaction.status !== 'NOT_FOUND') {
        if (transaction.status === 'SUCCESS') {
          return;
        }

        const txText = JSON.stringify(transaction);
        if (txText.includes('Error(Auth, InvalidAction)') || txText.includes('authorize_as_current_contract')) {
          throw new Error(
            'Aquarius add-liquidity authorization failed for this margin account. This smart account is likely using a legacy contract build that cannot authorize nested Aquarius pool calls. Create/use a fresh margin account (new SmartAccount hash), re-borrow funds there, then retry.'
          );
        }

        throw new Error(`Transaction failed with status: ${transaction.status}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
      attempts++;
    }

    throw new Error('Transaction timed out waiting for confirmation');
  }

  /**
   * Get the actual XLM or USDC token balance held by a margin account (contract address).
   * Uses Soroban RPC to call the token contract's balance() function directly,
   * since margin accounts are contracts (C...) not regular Stellar accounts.
   */
  static async getMarginAccountTokenBalance(
    marginAccountAddress: string,
    token: 'XLM' | 'USDC',
  ): Promise<string> {
    try {
      const tokenContractId = token === 'XLM' ? XLM_CONTRACT : CONTRACT_ADDRESSES.AQUARIUS_USDC;
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      const tokenContract = new StellarSdk.Contract(tokenContractId);

      const tx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          tokenContract.call(
            'balance',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
          )
        )
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if ('error' in sim || !('result' in sim) || !sim.result) return '0';

      const raw = StellarSdk.scValToNative(sim.result.retval) as bigint;
      // Both XLM and USDC use 7 decimal places on Stellar
      const balance = Number(raw) / 1e7;
      return balance.toFixed(7);
    } catch {
      return '0';
    }
  }

  /**
   * Wallet's Aquarius-issued USDC balance (matched by issuer), via Horizon.
   * Returns "0" if there is no such trustline or on error.
   */
  static async getAquariusUsdcWalletBalance(walletAddress: string): Promise<string> {
    try {
      const server = new StellarSdk.Horizon.Server(HORIZON_URL);
      const account = await server.loadAccount(walletAddress);

      const usdcLine = account.balances.find((balance) => {
        if (balance.asset_type !== 'credit_alphanum4' && balance.asset_type !== 'credit_alphanum12') {
          return false;
        }
        const assetBalance = balance as StellarSdk.Horizon.HorizonApi.BalanceLineAsset;
        return (
          assetBalance.asset_code === 'USDC' &&
          assetBalance.asset_issuer === ASSET_ISSUERS.USDC_AQUARIUS
        );
      }) as StellarSdk.Horizon.HorizonApi.BalanceLineAsset | undefined;

      if (!usdcLine) return '0';
      return parseFloat(usdcLine.balance).toFixed(7);
    } catch (error) {
      console.error('[AquariusService] getAquariusUsdcWalletBalance error:', error);
      return '0';
    }
  }

  /**
   * Whether the wallet holds the Aquarius USDC trustline — required before an
   * XLM→USDC wallet swap can settle. Returns false on error.
   */
  static async hasAquariusUsdcTrustline(walletAddress: string): Promise<boolean> {
    try {
      const server = new StellarSdk.Horizon.Server(HORIZON_URL);
      const account = await server.loadAccount(walletAddress);

      return account.balances.some((balance) => {
        if (balance.asset_type !== 'credit_alphanum4' && balance.asset_type !== 'credit_alphanum12') {
          return false;
        }
        const assetBalance = balance as StellarSdk.Horizon.HorizonApi.BalanceLineAsset;
        return (
          assetBalance.asset_code === 'USDC' &&
          assetBalance.asset_issuer === ASSET_ISSUERS.USDC_AQUARIUS
        );
      });
    } catch {
      return false;
    }
  }

  private static formatAquariusSwapError(raw: any): string {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});

    if (text.includes('trustline entry is missing for account')) {
      return 'USDC trustline is missing in your wallet. Please add Aquarius USDC trustline, then retry swap.';
    }

    if (text.includes('Error(Contract, #13)')) {
      return 'Swap failed because destination token trustline is missing. Please add USDC trustline in your wallet and retry.';
    }

    if (text.includes('HostError')) {
      return 'Aquarius swap failed on-chain. Please retry in a moment.';
    }

    return text || 'Swap failed';
  }

  /** Registry-configured USDC contract address, or null if unset/unreadable. */
  static async getRegistryUsdcAddress(): Promise<string | null> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.REGISTRY);

      const tx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('get_usdc_contract_address'))
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
        return null;
      }

      const address = StellarSdk.scValToNative(sim.result.retval);
      return address as string;
    } catch {
      return null;
    }
  }

  /**
   * Aquarius router address from Registry (checks `has_…` first, then `get_…`),
   * or null if not configured/unreadable. Prefer {@link getEffectiveRouterAddress},
   * which falls back to the hardcoded address.
   */
  static async getAquariusRouterAddressFromRegistry(): Promise<string | null> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.REGISTRY);

      const hasTx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('has_aquarius_router_address'))
        .setTimeout(30)
        .build();

      const hasSim = await server.simulateTransaction(hasTx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(hasSim) || !hasSim.result?.retval) {
        console.warn('[AquariusService] has_aquarius_router_address simulation failed');
        return null;
      }

      const hasRouter = StellarSdk.scValToNative(hasSim.result.retval);
      if (!hasRouter) {
        console.warn('[AquariusService] Aquarius router is not configured in Registry');
        return null;
      }

      const getTx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('get_aquarius_router_address'))
        .setTimeout(30)
        .build();

      const getSim = await server.simulateTransaction(getTx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(getSim) || !getSim.result?.retval) {
        console.warn('[AquariusService] get_aquarius_router_address simulation failed');
        return null;
      }

      const address = StellarSdk.scValToNative(getSim.result.retval);
      return address as string;
    } catch (error: any) {
      console.error('[AquariusService] getAquariusRouterAddressFromRegistry error:', error);
      return null;
    }
  }

  /** Whether the Registry has an Aquarius pool index configured. False on error. */
  static async hasAquariusPoolIndex(): Promise<boolean> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.REGISTRY);

      const tx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('get_aquarius_pool_index'))
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      return StellarSdk.rpc.Api.isSimulationSuccess(sim) && !!sim.result?.retval;
    } catch (error) {
      return false;
    }
  }

  /**
   * Tracking-token contract address from Registry (the contract that stores LP
   * share balances for margin accounts), or null if unset/unreadable.
   */
  static async getTrackingTokenAddressFromRegistry(): Promise<string | null> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.REGISTRY);

      const hasTx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('has_tracking_token_contract_addr'))
        .setTimeout(30)
        .build();

      const hasSim = await server.simulateTransaction(hasTx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(hasSim) || !hasSim.result?.retval) {
        return null;
      }

      const hasTracking = StellarSdk.scValToNative(hasSim.result.retval);
      if (!hasTracking) return null;

      const getTx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('get_tracking_token_contract_addr'))
        .setTimeout(30)
        .build();

      const getSim = await server.simulateTransaction(getTx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(getSim) || !getSim.result?.retval) {
        return null;
      }

      const address = StellarSdk.scValToNative(getSim.result.retval);
      return address as string;
    } catch (error) {
      console.error('[AquariusService] getTrackingTokenAddressFromRegistry error:', error);
      return null;
    }
  }

  /** True only when BOTH the router address and pool index are set in Registry. */
  static async isAquariusConfigured(): Promise<boolean> {
    const [router, hasIndex] = await Promise.all([
      AquariusService.getAquariusRouterAddressFromRegistry(),
      AquariusService.hasAquariusPoolIndex(),
    ]);
    return !!router && hasIndex;
  }

  /** Always true: hardcoded fallback addresses make Aquarius usable even unconfigured. */
  static isAquariusUsable(): boolean {
    return true;
  }

  /** Effective router address: Registry value if present, else the hardcoded fallback. */
  static async getEffectiveRouterAddress(): Promise<string> {
    const registryRouter = await AquariusService.getAquariusRouterAddressFromRegistry();
    if (registryRouter) return registryRouter;
    return CONTRACT_ADDRESSES.AQUARIUS_ROUTER;
  }

  /**
   * Registry tracking-token symbol for a pair (e.g. "AQ_XLM_USDC"), order-
   * insensitive. Returns null for pairs without a tracking token (only XLM/USDC).
   */
  static getLpTrackingSymbol(tokenA: string, tokenB: string): string | null {
    const a = tokenA.toUpperCase();
    const b = tokenB.toUpperCase();
    if ((a === 'XLM' && b === 'USDC') || (a === 'USDC' && b === 'XLM')) {
      return 'AQ_XLM_USDC';
    }
    return null;
  }

  /**
   * Margin account's LP balance via the Registry tracking token (7-decimal share
   * units, not WAD). Returns "0" when the pair has no tracking token, none is
   * configured, or on error. See {@link getUserLpBalance} for the pool-contract fallback.
   */
  static async getLpBalance(
    marginAccountAddress: string,
    tokenA: string,
    tokenB: string
  ): Promise<string> {
    try {
      const trackingSymbol = AquariusService.getLpTrackingSymbol(tokenA, tokenB);
      if (!trackingSymbol) return '0';

      const trackingAddress = await AquariusService.getTrackingTokenAddressFromRegistry();
      if (!trackingAddress) return '0';

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      const contract = new StellarSdk.Contract(trackingAddress);

      const tx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'balance',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
            StellarSdk.nativeToScVal(trackingSymbol, { type: 'symbol' })
          )
        )
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
        return '0';
      }

      const balance = StellarSdk.scValToNative(sim.result.retval);
      // LP tracking tokens are stored in Aquarius LP share units (7 decimals), not WAD (1e18)
      const lp = Number(balance?.toString?.() ?? balance ?? 0) / 1e7;
      return Number.isFinite(lp) && lp > 0 ? lp.toFixed(7) : '0';
    } catch (error) {
      return '0';
    }
  }

  /**
   * Pool stats for one pool address. Prefers the Aquarius AMM API (cached, gives
   * APY/volume/TVL), falling back to a direct on-chain read of reserves/fee/total
   * shares (no API-only fields). Reserves are mapped to config token order.
   * Returns null if both paths fail.
   */
  static async getAquariusPoolStats(poolAddress: string): Promise<AquariusPoolStats | null> {
    try {
      // Prefer Aquarius AMM API for live pool values shown on aqua.network.
      const apiPools = await AquariusService.getAquariusApiPoolStatsByAddress();
      const fromApi = apiPools[poolAddress.trim().toUpperCase()];
      if (fromApi) return fromApi;
    } catch (error) {
      console.warn('[AquariusService] AMM API pool stats fetch failed, falling back to contract read:', error);
    }

    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      const contract = new StellarSdk.Contract(poolAddress);

      const makeSim = (method: string) =>
        server.simulateTransaction(
          new StellarSdk.TransactionBuilder(tempAccount, {
            fee: StellarSdk.BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
          })
            .addOperation(contract.call(method))
            .setTimeout(30)
            .build()
        );

      const [resSim, feeSim, sharesSim] = await Promise.all([
        makeSim('get_reserves'),
        makeSim('get_fee_fraction'),
        makeSim('get_total_shares'),
      ]);

      const cfg = AQUARIUS_POOLS.find(
        (p) => p.poolAddress.toUpperCase() === poolAddress.trim().toUpperCase(),
      );
      let reserveA = '0';
      let reserveB = '0';
      if (StellarSdk.rpc.Api.isSimulationSuccess(resSim) && resSim.result?.retval) {
        const resNative = StellarSdk.scValToNative(resSim.result.retval) as any[];
        if (Array.isArray(resNative) && resNative.length >= 2) {
          const mapped = mapAquariusReservesToConfig(
            cfg,
            resNative[0]?.toString?.() ?? String(resNative[0]),
            resNative[1]?.toString?.() ?? String(resNative[1]),
          );
          reserveA = mapped.reserveA;
          reserveB = mapped.reserveB;
        }
      }

      let feeRaw = 30;
      if (StellarSdk.rpc.Api.isSimulationSuccess(feeSim) && feeSim.result?.retval) {
        feeRaw = Number(StellarSdk.scValToNative(feeSim.result.retval)) || 30;
      }

      let totalShares = '0';
      if (StellarSdk.rpc.Api.isSimulationSuccess(sharesSim) && sharesSim.result?.retval) {
        const sharesNative = StellarSdk.scValToNative(sharesSim.result.retval);
        totalShares = (Number(sharesNative?.toString?.() ?? sharesNative ?? 0) / 1e7).toFixed(7);
      }

      return {
        reserveA,
        reserveB,
        totalShares,
        feeFraction: `${(feeRaw / 100).toFixed(2)}%`,
        feeRaw,
      };
    } catch (error) {
      console.error('[AquariusService] getAquariusPoolStats error:', error);
      return null;
    }
  }

  /**
   * Margin account's LP share balance (7-decimal). Tries the Registry tracking
   * token first ({@link getLpBalance}); if zero/unavailable, falls back to the
   * pool's own `get_user_shares`. Returns "0" on error.
   */
  static async getUserLpBalance(
    marginAccountAddress: string,
    poolAddress: string,
    tokenA = 'XLM',
    tokenB = 'USDC'
  ): Promise<string> {
    try {
      // Try tracking token from Registry first
      const tracked = await AquariusService.getLpBalance(marginAccountAddress, tokenA, tokenB);
      if (tracked && tracked !== '0') return tracked;

      // Fallback: read directly from pool's get_user_shares()
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      const contract = new StellarSdk.Contract(poolAddress);

      const tx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'get_user_shares',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' })
          )
        )
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) return '0';

      const shares = StellarSdk.scValToNative(sim.result.retval);
      const sharesNum = Number(shares?.toString?.() ?? shares ?? 0) / 1e7;
      return Number.isFinite(sharesNum) && sharesNum > 0 ? sharesNum.toFixed(7) : '0';
    } catch {
      return '0';
    }
  }

  /**
   * Fetch deposit/withdraw-liquidity events for a pool over the last ~30 days
   * (518400 ledgers) via Soroban `getEvents`, newest first. When `userAddress`
   * is given, keeps only events whose topics include it (events with no decodable
   * address topic are kept, since the depositor topic index varies by version).
   */
  static async getAquariusEvents(
    poolAddress: string,
    userAddress?: string,
  ): Promise<AquariusLpEvent[]> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const latest = await server.getLatestLedger();
      const startLedger = Math.max(0, latest.sequence - 518400); // ~30 days

      // Topics must be XDR-encoded ScVal base64 strings, not plain strings.
      const depositTopic  = StellarSdk.xdr.ScVal.scvSymbol('deposit_liquidity').toXDR('base64');
      const withdrawTopic = StellarSdk.xdr.ScVal.scvSymbol('withdraw_liquidity').toXDR('base64');

      const safeGet = async (topic: string) => {
        try {
          const resp = await (server as any).getEvents({
            startLedger,
            filters: [{ type: 'contract', contractIds: [poolAddress], topics: [[topic]] }],
            limit: 200,
          });
          return resp?.events ?? [];
        } catch {
          return [];
        }
      };

      const [depositEvs, withdrawEvs] = await Promise.all([
        safeGet(depositTopic),
        safeGet(withdrawTopic),
      ]);

      const parseEv = (ev: any, type: 'deposit' | 'withdraw'): AquariusLpEvent | null => {
        try {
          if (userAddress && Array.isArray(ev.topic)) {
            // Topic index for depositor can vary by contract/version.
            // Keep events if no decodable address topics are present, otherwise require a match.
            const topicAddresses = ev.topic
              .map((t: any) => {
                try {
                  return StellarSdk.scValToNative(t) as string;
                } catch {
                  return null;
                }
              })
              .filter((v: string | null): v is string => typeof v === 'string' && v.length > 0);
            if (topicAddresses.length > 0 && !topicAddresses.includes(userAddress)) {
              return null;
            }
          }
          // body: [share_amount, amountA, amountB]
          const body = ev.value ? (StellarSdk.scValToNative(ev.value) as any[]) : null;
          if (!Array.isArray(body) || body.length < 3) return null;
          const toHuman = (v: any) => (Number(v?.toString?.() ?? v ?? 0) / 1e7).toFixed(7);
          return {
            type,
            shareAmount: toHuman(body[0]),
            amountA: toHuman(body[1]),
            amountB: toHuman(body[2]),
            timestamp: ev.ledgerClosedAt ? new Date(ev.ledgerClosedAt).getTime() : 0,
            txHash: ev.txHash ?? '',
            ledger: ev.ledger ?? 0,
          };
        } catch {
          return null;
        }
      };

      const all: AquariusLpEvent[] = [
        ...depositEvs.map((ev: any) => parseEv(ev, 'deposit')),
        ...withdrawEvs.map((ev: any) => parseEv(ev, 'withdraw')),
      ].filter((e): e is AquariusLpEvent => e !== null);

      return all.sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      console.error('[AquariusService] getAquariusEvents error:', error);
      return [];
    }
  }

  /**
   * Build the XDR `ExternalProtocolCall` payload bytes for AccountManager.execute().
   * Serialized as an alphabetically-keyed ScVal::Map; `type_action` is encoded as
   * `Vec([Symbol(action)])` (the Soroban unit-variant encoding — a bare symbol
   * fails to decode). `amountsOutWad` is WAD (1e18) for AddLiquidity/Swap but
   * 7-decimal LP share units for RemoveLiquidity (see {@link removeLiquidity}).
   */
  static buildExternalProtocolCallBytes(
    routerAddress: string,
    action: AquariusAction,
    tokensOut: string[],
    amountsOutWad: bigint[],
    marginAccountAddress: string,
    feeFraction: number,
    isTokenPair: boolean
  ): Buffer {
    const amountOut = StellarSdk.xdr.ScVal.scvVec(
      amountsOutWad.map((amt) => StellarSdk.nativeToScVal(amt, { type: 'u256' }))
    );

    // Testnet has 3 genuinely distinct USDC tokens (one per DEX's own pool) —
    // the generic "USDC" symbol resolves to Blend's token, not Aquarius's own,
    // so it fails this Controller's can_call check. Map it to the real
    // on-chain symbol here rather than trusting every caller to know that.
    const tokensOutVal = StellarSdk.xdr.ScVal.scvVec(
      tokensOut.map((t) => StellarSdk.xdr.ScVal.scvSymbol(t === 'USDC' ? 'AQUSDC' : t))
    );

    const amountIn = StellarSdk.xdr.ScVal.scvVec([]);
    const tokensIn = StellarSdk.xdr.ScVal.scvVec([]);

    const scvMap = StellarSdk.xdr.ScVal.scvMap([
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('amount_in'), val: amountIn }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('amount_out'), val: amountOut }),
      new StellarSdk.xdr.ScMapEntry({
        key: makeKey('fee_fraction'),
        val: StellarSdk.xdr.ScVal.scvU32(feeFraction),
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: makeKey('is_token_pair'),
        val: StellarSdk.xdr.ScVal.scvBool(isTokenPair),
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: makeKey('margin_account'),
        val: StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: makeKey('min_liquidity_out'),
        val: StellarSdk.nativeToScVal(BigInt(0), { type: 'u256' }),
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: makeKey('protocol_address'),
        val: StellarSdk.nativeToScVal(routerAddress, { type: 'address' }),
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: makeKey('token_pair_ratio'),
        val: StellarSdk.xdr.ScVal.scvU64(StellarSdk.xdr.Uint64.fromString('0')),
      }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('tokens_in'), val: tokensIn }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('tokens_out'), val: tokensOutVal }),
      new StellarSdk.xdr.ScMapEntry({
        key: makeKey('type_action'),
        val: StellarSdk.xdr.ScVal.scvVec([StellarSdk.xdr.ScVal.scvSymbol(action)]),
      }),
    ]);

    return Buffer.from(scvMap.toXDR());
  }

  /**
   * Add liquidity to the Aquarius XLM/USDC pool from the margin account.
   *
   * Routes through AccountManager.execute() → SmartAccount AddLiquidity handler,
   * which pulls Aquarius USDC + XLM from the margin account and deposits them into
   * the Aquarius pool.
   */
  static async addLiquidity(
    walletAddress: string,
    marginAccountAddress: string,
    tokenA: string,
    tokenB: string,
    amountA: number,
    amountB: number,
  ): Promise<AquariusTransactionResult> {
    try {
      if (!marginAccountAddress) {
        return { success: false, error: 'Margin account required for add liquidity' };
      }

      const routerAddress = await AquariusService.getEffectiveRouterAddress();

      // Build callbytes for AccountManager → SmartAccount AddLiquidity.
      // Amounts in WAD (1e18) — SmartAccount converts to token decimals internally.
      const callBytes = AquariusService.buildExternalProtocolCallBytes(
        routerAddress,
        'AddLiquidity',
        [tokenA.toUpperCase(), tokenB.toUpperCase()],
        [toWad(amountA), toWad(amountB)],
        marginAccountAddress,
        30,
        true,
      );

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(walletAddress);
      const accountManager = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);

      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: (parseInt(StellarSdk.BASE_FEE) * 100).toString(),
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          accountManager.call(
            'execute',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
            StellarSdk.xdr.ScVal.scvBytes(callBytes),
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
        await AquariusService.pollTransactionStatus(server, result.hash);
        return { success: true, hash: result.hash };
      }
      return { success: false, error: `Network rejected (status: ${result.status})` };
    } catch (error: any) {
      console.error('[AquariusService] addLiquidity error:', error);
      const errText = `${error?.message ?? ''} ${error?.toString?.() ?? ''}`;
      if (errText.includes('Error(Auth, InvalidAction)') || errText.includes('authorize_as_current_contract')) {
        return {
          success: false,
          error:
            'Aquarius add liquidity failed due to smart-account authorization chain (Auth InvalidAction).',
        };
      }
      if (errText.includes('Error(Contract, #404)') || errText.includes('pool not found')) {
        return {
          success: false,
          error: 'Aquarius pool not found for current token/router configuration.',
        };
      }
      return { success: false, error: error?.message || 'Add liquidity failed' };
    }
  }

  /**
   * Remove liquidity from an Aquarius pool from the margin account via
   * AccountManager.execute(). `lpAmount` is in LP share units (7 decimals, not
   * WAD). Returns once the tx is accepted (PENDING); does not poll to SUCCESS.
   */
  static async removeLiquidity(
    walletAddress: string,
    marginAccountAddress: string,
    tokenA: string,
    tokenB: string,
    lpAmount: number
  ): Promise<AquariusTransactionResult> {
    try {
      const routerAddress = await AquariusService.getEffectiveRouterAddress();

      const pool = AQUARIUS_POOLS.find(
        (p) =>
          (p.tokens[0] === tokenA && p.tokens[1] === tokenB) ||
          (p.tokens[0] === tokenB && p.tokens[1] === tokenA)
      );
      const feeFraction = pool?.feeFraction ?? 30;

      const callBytes = AquariusService.buildExternalProtocolCallBytes(
        routerAddress,
        'RemoveLiquidity',
        [tokenA, tokenB],
        // RemoveLiquidity expects Aquarius LP share units (7 decimals), not WAD.
        [toLpShareUnits(lpAmount)],
        marginAccountAddress,
        feeFraction,
        true
      );

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(walletAddress);
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);

      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: (parseInt(StellarSdk.BASE_FEE) * 20).toString(),
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'execute',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
            StellarSdk.xdr.ScVal.scvBytes(callBytes)
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
        return { success: true, hash: result.hash };
      }
      return { success: false, error: 'Transaction rejected by network' };
    } catch (error: any) {
      console.error('[AquariusService] removeLiquidity error:', error);
      return { success: false, error: error?.message || 'Remove liquidity failed' };
    }
  }

  /**
   * Query the Aquarius router for all pool indices for the XLM/USDC pair.
   * Falls back to the hardcoded index if the call fails.
   */
  private static async getAquariusPoolIndices(): Promise<Buffer[]> {
    const fallback = [Buffer.from(CONTRACT_ADDRESSES.AQUARIUS_POOL_INDEX_HEX, 'hex')];
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      const routerContract = new StellarSdk.Contract(CONTRACT_ADDRESSES.AQUARIUS_ROUTER);

      const tx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          routerContract.call(
            'get_pools',
            StellarSdk.xdr.ScVal.scvVec(
              POOL_SORTED_TOKENS.map((a) => StellarSdk.nativeToScVal(a, { type: 'address' }))
            )
          )
        )
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
        return fallback;
      }

      const raw = StellarSdk.scValToNative(sim.result.retval);
      if (!Array.isArray(raw) || raw.length === 0) return fallback;

      const indices = raw.map((r: any) => {
        if (r instanceof Uint8Array) return Buffer.from(r);
        if (Buffer.isBuffer(r)) return r as Buffer;
        return null;
      }).filter((b): b is Buffer => b !== null);

      return indices.length > 0 ? indices : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Read pool reserves + fee and compute constant-product amount out for one pool index.
   * This avoids simulating swap execution, so quotes remain available in both wallet/margin modes.
   */
  private static async getQuotedOutForPoolIndex(
    tokenInContract: string,
    amountInStroops: bigint,
    poolIndexBytes: Buffer,
  ): Promise<number | null> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      const routerContract = new StellarSdk.Contract(CONTRACT_ADDRESSES.AQUARIUS_ROUTER);

      const getPoolTx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          routerContract.call(
            'get_pool',
            StellarSdk.xdr.ScVal.scvVec(
              POOL_SORTED_TOKENS.map((a) => StellarSdk.nativeToScVal(a, { type: 'address' }))
            ),
            StellarSdk.xdr.ScVal.scvBytes(poolIndexBytes),
          )
        )
        .setTimeout(30)
        .build();

      const poolSim = await server.simulateTransaction(getPoolTx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(poolSim) || !poolSim.result?.retval) return null;
      const poolAddress = StellarSdk.scValToNative(poolSim.result.retval) as string;
      if (!poolAddress) return null;

      const poolContract = new StellarSdk.Contract(poolAddress);
      const makeSim = (method: string) =>
        server.simulateTransaction(
          new StellarSdk.TransactionBuilder(tempAccount, {
            fee: StellarSdk.BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
          })
            .addOperation(poolContract.call(method))
            .setTimeout(30)
            .build()
        );

      const [resSim, feeSim] = await Promise.all([
        makeSim('get_reserves'),
        makeSim('get_fee_fraction'),
      ]);

      if (!StellarSdk.rpc.Api.isSimulationSuccess(resSim) || !resSim.result?.retval) return null;
      const reserves = StellarSdk.scValToNative(resSim.result.retval) as [bigint, bigint];
      if (!Array.isArray(reserves) || reserves.length < 2) return null;

      // Token order on Aquarius pool is sorted: [USDC, XLM]
      const reserveUsdc = BigInt(reserves[0] as unknown as bigint);
      const reserveXlm = BigInt(reserves[1] as unknown as bigint);

      const feeRaw = (StellarSdk.rpc.Api.isSimulationSuccess(feeSim) && feeSim.result?.retval)
        ? Number(StellarSdk.scValToNative(feeSim.result.retval))
        : 30;

      const reserveIn = tokenInContract === XLM_CONTRACT ? reserveXlm : reserveUsdc;
      const reserveOut = tokenInContract === XLM_CONTRACT ? reserveUsdc : reserveXlm;
      if (reserveIn <= BigInt(0) || reserveOut <= BigInt(0) || amountInStroops <= BigInt(0)) return null;

      // feeRaw=30 means 0.30% => denominator 10000
      const feeDenom = BigInt(10000);
      const feeNumer = feeDenom - BigInt(Math.max(0, Math.min(9999, feeRaw)));
      const amountInAfterFee = (amountInStroops * feeNumer) / feeDenom;
      if (amountInAfterFee <= BigInt(0)) return null;

      const numerator = amountInAfterFee * reserveOut;
      const denominator = reserveIn + amountInAfterFee;
      if (denominator <= BigInt(0)) return null;

      const amountOutRaw = numerator / denominator;
      const amountOut = Number(amountOutRaw) / 1e7;
      return Number.isFinite(amountOut) && amountOut > 0 ? amountOut : null;
    } catch {
      return null;
    }
  }

  /**
   * Ask the Aquarius router for the swap output via its `estimate_swap_routed` view.
   * Mirrors the exact swaps_chain that `swap_chained` would execute, so the returned
   * amount is what the actual swap will produce (no off-chain math drift).
   * Returns human-readable amount (7 decimals), or null if the router rejects/lacks the method.
   */
  private static async estimateSwapRouted(
    tokenInContract: string,
    amountInStroops: bigint,
    poolIndexBytes: Buffer,
  ): Promise<number | null> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      const router = new StellarSdk.Contract(CONTRACT_ADDRESSES.AQUARIUS_ROUTER);
      const swapsChain = buildSwapsChain(tokenInContract, poolIndexBytes);

      const tx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          router.call(
            'estimate_swap_routed',
            swapsChain,
            StellarSdk.nativeToScVal(tokenInContract, { type: 'address' }),
            StellarSdk.nativeToScVal(amountInStroops, { type: 'u128' }),
          )
        )
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) return null;

      const raw = StellarSdk.scValToNative(sim.result.retval) as bigint;
      const amountOut = Number(raw) / 1e7;
      return Number.isFinite(amountOut) && amountOut > 0 ? amountOut : null;
    } catch {
      return null;
    }
  }

  /**
   * Get expected output amount for the swap.
   * Primary path: ask the Aquarius router (`estimate_swap_routed`) — guarantees the quote
   *   matches what `swap_chained` will actually return at execution.
   * Fallback path: read pool reserves and compute the constant-product output locally.
   * Returns the output amount in human-readable form (7 decimals), or null on error.
   */
  static async getSwapQuote(
    amountIn: number,
    tokenInSymbol: 'XLM' | 'USDC',
    _simulatorAddress: string,
  ): Promise<string | null> {
    try {
      void _simulatorAddress;
      const tokenInContract = tokenInSymbol === 'XLM' ? XLM_CONTRACT : CONTRACT_ADDRESSES.AQUARIUS_USDC;
      const amountInStroops = BigInt(Math.round(amountIn * 1e7));

      const poolIndices = await AquariusService.getAquariusPoolIndices();

      let bestAmount = 0;
      let bestQuote: string | null = null;

      for (const poolIndexBytes of poolIndices) {
        // Prefer the router's own estimate; fall back to local math only if router rejects.
        let amount = await AquariusService.estimateSwapRouted(
          tokenInContract,
          amountInStroops,
          poolIndexBytes,
        );
        if (amount === null) {
          amount = await AquariusService.getQuotedOutForPoolIndex(
            tokenInContract,
            amountInStroops,
            poolIndexBytes,
          );
        }
        if (amount !== null && amount > bestAmount) {
          bestAmount = amount;
          bestQuote = amount.toFixed(7);
        }
      }

      return bestQuote;
    } catch (err) {
      console.error('[AquariusService] getSwapQuote error:', err);
      return null;
    }
  }

  /**
   * Find the pool index (Buffer) that gives the best swap output for the given pair + amount.
   * Used by aquariusSwap to ensure it uses the same pool as getSwapQuote.
   */
  private static async getBestPoolIndexBytes(
    tokenInContract: string,
    amountInStroops: bigint,
    _simulatorAddress: string,
  ): Promise<Buffer> {
    const fallback = Buffer.from(CONTRACT_ADDRESSES.AQUARIUS_POOL_INDEX_HEX, 'hex');
    try {
      void _simulatorAddress;
      const poolIndices = await AquariusService.getAquariusPoolIndices();

      let bestAmount = 0;
      let bestIndex = poolIndices[0] ?? fallback;

      for (const poolIndexBytes of poolIndices) {
        const amount = await AquariusService.getQuotedOutForPoolIndex(
          tokenInContract,
          amountInStroops,
          poolIndexBytes,
        );
        if (amount !== null && amount > bestAmount) {
          bestAmount = amount;
          bestIndex = poolIndexBytes;
        }
      }

      return bestIndex;
    } catch {
      return fallback;
    }
  }

  /**
   * Build margin swap call bytes in the format expected by AccountManager/SmartAccount:
   * - type_action: Vec([Symbol("Swap")])
   * - tokens_out: Vec<Symbol> with exactly [token_in, token_out]
   * - amount_out[0]: amount_in in WAD
   */
  private static buildSwapCallBytesForMargin(
    routerAddress: string,
    tokenInSymbol: 'XLM' | 'USDC',
    tokenOutSymbol: 'XLM' | 'USDC',
    amountIn: bigint,
    marginAccountAddress: string,
  ): Buffer {
    // Same "USDC" -> "AQUSDC" mapping as buildExternalProtocolCallBytes — the
    // generic symbol resolves to Blend's token via the Registry, which fails
    // this Controller's can_call (it only accepts XLM / its own AQUSDC).
    const onChainSymbol = (s: 'XLM' | 'USDC') => (s === 'USDC' ? 'AQUSDC' : s);
    const tokensInVal = StellarSdk.xdr.ScVal.scvVec([]);
    const tokensOutVal = StellarSdk.xdr.ScVal.scvVec([
      StellarSdk.xdr.ScVal.scvSymbol(onChainSymbol(tokenInSymbol)),
      StellarSdk.xdr.ScVal.scvSymbol(onChainSymbol(tokenOutSymbol)),
    ]);
    // IMPORTANT: SmartAccount reads the swap amount from amount_out[0] (in WAD/1e18).
    // amount_in is intentionally empty — this matches buildExternalProtocolCallBytes convention.
    const amountInVal = StellarSdk.xdr.ScVal.scvVec([]);
    const amountOutVal = StellarSdk.xdr.ScVal.scvVec([
      StellarSdk.nativeToScVal(amountIn, { type: 'u256' }),  // amount_in in WAD
      StellarSdk.nativeToScVal(BigInt(0), { type: 'u256' }),  // min_amount_out
    ]);

    const scvMap = StellarSdk.xdr.ScVal.scvMap([
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('amount_in'), val: amountInVal }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('amount_out'), val: amountOutVal }),
      new StellarSdk.xdr.ScMapEntry({
        key: makeKey('fee_fraction'),
        val: StellarSdk.xdr.ScVal.scvU32(30),
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: makeKey('is_token_pair'),
        val: StellarSdk.xdr.ScVal.scvBool(false),
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: makeKey('margin_account'),
        val: StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: makeKey('min_liquidity_out'),
        val: StellarSdk.nativeToScVal(BigInt(0), { type: 'u256' }),
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: makeKey('protocol_address'),
        val: StellarSdk.nativeToScVal(routerAddress, { type: 'address' }),
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: makeKey('token_pair_ratio'),
        val: StellarSdk.xdr.ScVal.scvU64(StellarSdk.xdr.Uint64.fromString('0')),
      }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('tokens_in'), val: tokensInVal }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('tokens_out'), val: tokensOutVal }),
      new StellarSdk.xdr.ScMapEntry({
        key: makeKey('type_action'),
        val: StellarSdk.xdr.ScVal.scvVec([StellarSdk.xdr.ScVal.scvSymbol('Swap')]),
      }),
    ]);

    return Buffer.from(scvMap.toXDR());
  }

  /**
   * Execute a swap from the margin account via AccountManager.execute() → SmartAccount Swap handler.
    * Encodes swap action payload in the exact struct shape expected by AccountManager.
   */
  static async aquariusSwapFromMargin(
    walletAddress: string,
    marginAccountAddress: string,
    tokenInSymbol: 'XLM' | 'USDC',
    amountIn: number,
  ): Promise<AquariusTransactionResult> {
    try {
      const routerAddress = await AquariusService.getEffectiveRouterAddress();

      const tokenOutSymbol: 'XLM' | 'USDC' = tokenInSymbol === 'XLM' ? 'USDC' : 'XLM';

      const amountStroops = floorAmountToStroops(amountIn);
      if (amountStroops <= BigInt(0)) {
        return { success: false, error: 'Invalid swap amount' };
      }

      const callBytes = AquariusService.buildSwapCallBytesForMargin(
        routerAddress,
        tokenInSymbol,
        tokenOutSymbol,
        stroopsToWad(amountStroops),
        marginAccountAddress,
      );

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(walletAddress);
      const accountManager = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);

      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: (parseInt(StellarSdk.BASE_FEE) * 100).toString(),
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          accountManager.call(
            'execute',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
            StellarSdk.xdr.ScVal.scvBytes(callBytes)
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
        return { success: true, hash: result.hash };
      }
      return { success: false, error: `Network rejected (status: ${result.status})` };
    } catch (error: any) {
      console.error('[AquariusService] aquariusSwapFromMargin error:', error);
      const errText = `${error?.message ?? ''} ${error?.toString?.() ?? ''}`;
      if (errText.includes('Error(Contract, #404)') || errText.includes('failing with contract error")')) {
        return {
          success: false,
          error: 'Aquarius pool not found for configured Aquarius token mapping.',
        };
      }
      return { success: false, error: error?.message || 'Margin swap failed' };
    }
  }

  /**
   * Execute a swap via the Aquarius router.
   * user = walletAddress (standard G... account — Freighter can sign directly).
   * Swap amounts come from the wallet's own XLM / Aquarius USDC balance.
   */
  static async aquariusSwap(
    walletAddress: string,
    _marginAccountAddress: string,
    tokenInSymbol: 'XLM' | 'USDC',
    amountIn: number,
    slippagePct: number = 0.5,
  ): Promise<AquariusTransactionResult> {
    try {
      // XLM -> USDC wallet swaps require an Aquarius USDC trustline on destination wallet.
      if (tokenInSymbol === 'XLM') {
        const hasTrustline = await AquariusService.hasAquariusUsdcTrustline(walletAddress);
        if (!hasTrustline) {
          return {
            success: false,
            error: 'USDC trustline is missing in your wallet. Please add Aquarius USDC trustline, then retry swap.',
          };
        }
      }

      const tokenInContract = tokenInSymbol === 'XLM' ? XLM_CONTRACT : CONTRACT_ADDRESSES.AQUARIUS_USDC;
      const amountInStroops = BigInt(Math.round(amountIn * 1e7));

      // Discover the best pool (highest output) — same pool used for the quote shown to user.
      const bestPoolIndex = await AquariusService.getBestPoolIndexBytes(
        tokenInContract,
        amountInStroops,
        walletAddress,
      );
      const swapsChain = buildSwapsChain(tokenInContract, bestPoolIndex);

      // Compute out_min from quote with slippage
      const quotedOut = await AquariusService.getSwapQuote(amountIn, tokenInSymbol, walletAddress);
      const outMin = quotedOut
        ? BigInt(Math.floor(parseFloat(quotedOut) * 1e7 * (1 - slippagePct / 100)))
        : BigInt(1);

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(walletAddress);
      const routerContract = new StellarSdk.Contract(CONTRACT_ADDRESSES.AQUARIUS_ROUTER);

      const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: (parseInt(StellarSdk.BASE_FEE) * 100).toString(),
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          routerContract.call(
            'swap_chained',
            StellarSdk.nativeToScVal(walletAddress, { type: 'address' }),
            swapsChain,
            StellarSdk.nativeToScVal(tokenInContract, { type: 'address' }),
            StellarSdk.nativeToScVal(amountInStroops, { type: 'u128' }),
            StellarSdk.nativeToScVal(outMin, { type: 'u128' }),
          )
        )
        .setTimeout(30)
        .build();

      const preparedTx = await server.prepareTransaction(tx);
      const signResult = await signTransaction(preparedTx.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      const signedTx = StellarSdk.TransactionBuilder.fromXDR(
        signResult.signedTxXdr,
        NETWORK_PASSPHRASE
      );

      const result = await server.sendTransaction(signedTx as StellarSdk.Transaction);
      if (result.status === 'PENDING') {
        return { success: true, hash: result.hash };
      }
      if (result.status === 'ERROR') {
        return {
          success: false,
          error: AquariusService.formatAquariusSwapError(result.errorResult || 'Swap failed with ERROR status'),
        };
      }
      return { success: false, error: `Network rejected (status: ${result.status})` };
    } catch (error: any) {
      console.error('[AquariusService] aquariusSwap error:', error);
      return { success: false, error: AquariusService.formatAquariusSwapError(error?.message || error) };
    }
  }
}
