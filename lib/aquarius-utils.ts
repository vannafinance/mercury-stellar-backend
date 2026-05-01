import * as StellarSdk from '@stellar/stellar-sdk';
import { signTransaction } from '@stellar/freighter-api';
import {
  CONTRACT_ADDRESSES,
  HORIZON_URL,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
  ASSET_ISSUERS,
} from './stellar-utils';

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

export type AquariusAction = 'AddLiquidity' | 'RemoveLiquidity' | 'Swap';

export interface AquariusPoolStats {
  reserveA: string;   // XLM reserve, human-readable (7 decimals)
  reserveB: string;   // USDC reserve, human-readable (7 decimals)
  totalShares: string; // total LP shares, human-readable
  feeFraction: string; // e.g., "0.30%"
  feeRaw: number;      // raw fee fraction (30 = 0.30%)
}

export interface AquariusLpEvent {
  type: 'deposit' | 'withdraw';
  shareAmount: string;  // LP shares minted/burned
  amountA: string;      // token A amount
  amountB: string;      // token B amount
  timestamp: number;    // unix ms
  txHash: string;
  ledger: number;
}

export interface AquariusPoolConfig {
  id: string;
  tokens: [string, string];
  feeFraction: number; // 30 = 0.30%
  displayName: string;
  poolAddress: string;
}

export const AQUARIUS_POOLS: AquariusPoolConfig[] = [
  {
    id: 'aquarius-xlm-usdc',
    tokens: ['XLM', 'USDC'],
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

export interface AquariusTransactionResult {
  success: boolean;
  hash?: string;
  error?: string;
}

const WAD = 1e18;
const LP_SHARE_SCALE = 1e7;
const AQUARIUS_AMM_API_BASE = 'https://amm-api-testnet.aqua.network';
const AQUARIUS_API_CACHE_TTL_MS = 60_000;

interface AquariusApiPoolsResponse {
  items?: AquariusApiPoolItem[];
}

interface AquariusApiPoolItem {
  address?: string;
  reserves?: [string, string] | string[];
  fee?: string;
  total_share?: string;
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

export class AquariusService {
  private static apiPoolStatsCache: {
    expiresAt: number;
    byAddress: Record<string, AquariusPoolStats>;
  } | null = null;

  private static async getAquariusApiPoolStatsByAddress(): Promise<Record<string, AquariusPoolStats>> {
    const now = Date.now();
    if (AquariusService.apiPoolStatsCache && AquariusService.apiPoolStatsCache.expiresAt > now) {
      return AquariusService.apiPoolStatsCache.byAddress;
    }

    const response = await fetch(`${AQUARIUS_AMM_API_BASE}/pools/?limit=200`);
    if (!response.ok) {
      throw new Error(`Aquarius API error: ${response.status}`);
    }

    const json = (await response.json()) as AquariusApiPoolsResponse;
    const byAddress: Record<string, AquariusPoolStats> = {};

    for (const pool of json.items ?? []) {
      const address = (pool.address ?? '').trim().toUpperCase();
      if (!address) continue;

      const reserveA = pool.reserves?.[0] ?? '0';
      const reserveB = pool.reserves?.[1] ?? '0';
      const totalShare = pool.total_share ?? '0';
      const feeRaw = Math.round((parseFloat(pool.fee ?? '0.003') || 0.003) * 10_000);

      byAddress[address] = {
        reserveA,
        reserveB,
        totalShares: totalShare,
        feeFraction: `${(feeRaw / 100).toFixed(2)}%`,
        feeRaw,
      };
    }

    AquariusService.apiPoolStatsCache = {
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

  static async isAquariusConfigured(): Promise<boolean> {
    const [router, hasIndex] = await Promise.all([
      AquariusService.getAquariusRouterAddressFromRegistry(),
      AquariusService.hasAquariusPoolIndex(),
    ]);
    return !!router && hasIndex;
  }

  // Always returns true — we always have hardcoded fallback addresses.
  static isAquariusUsable(): boolean {
    return true;
  }

  // Returns router address from static protocol config.
  static async getEffectiveRouterAddress(): Promise<string> {
    const registryRouter = await AquariusService.getAquariusRouterAddressFromRegistry();
    if (registryRouter) return registryRouter;
    return CONTRACT_ADDRESSES.AQUARIUS_ROUTER;
  }

  static getLpTrackingSymbol(tokenA: string, tokenB: string): string | null {
    const a = tokenA.toUpperCase();
    const b = tokenB.toUpperCase();
    if ((a === 'XLM' && b === 'USDC') || (a === 'USDC' && b === 'XLM')) {
      return 'AQ_XLM_USDC';
    }
    return null;
  }

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

  // Fetch pool reserves, fee, and total shares directly from the Aquarius pool contract.
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

      let reserveA = '0';
      let reserveB = '0';
      if (StellarSdk.rpc.Api.isSimulationSuccess(resSim) && resSim.result?.retval) {
        const resNative = StellarSdk.scValToNative(resSim.result.retval) as any[];
        if (Array.isArray(resNative) && resNative.length >= 2) {
          reserveA = (Number(resNative[0].toString()) / 1e7).toFixed(7);
          reserveB = (Number(resNative[1].toString()) / 1e7).toFixed(7);
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

  // Get user's LP share balance directly from the pool contract.
  // Falls back to tracking token approach first (for Registry-configured setups).
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

  // Fetch deposit_liquidity / withdraw_liquidity events from the Aquarius pool contract.
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

    const tokensOutVal = StellarSdk.xdr.ScVal.scvVec(
      tokensOut.map((t) => StellarSdk.xdr.ScVal.scvSymbol(t))
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
   * Get expected output amount from pool reserves.
   * Tries all available XLM/USDC pools on Aquarius and returns the best (highest) quote.
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

      // Discover all pools for this pair and pick the one giving the best (highest) quote.
      // This ensures we always match the most liquid Aquarius pool (same as their UI).
      const poolIndices = await AquariusService.getAquariusPoolIndices();

      let bestAmount = 0;
      let bestQuote: string | null = null;

      for (const poolIndexBytes of poolIndices) {
        const amount = await AquariusService.getQuotedOutForPoolIndex(
          tokenInContract,
          amountInStroops,
          poolIndexBytes,
        );
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
    const tokensInVal = StellarSdk.xdr.ScVal.scvVec([]);
    const tokensOutVal = StellarSdk.xdr.ScVal.scvVec([
      StellarSdk.xdr.ScVal.scvSymbol(tokenInSymbol),
      StellarSdk.xdr.ScVal.scvSymbol(tokenOutSymbol),
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

      const callBytes = AquariusService.buildSwapCallBytesForMargin(
        routerAddress,
        tokenInSymbol,
        tokenOutSymbol,
        toWad(amountIn),
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
