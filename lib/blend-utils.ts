// Blend Capital integration: deposit/withdraw into the single shared Blend pool
// via the Vanna smart account, plus reserve-stats and position reads. APY math
// mirrors blend-sdk-js so figures match mainnet.blend.capital exactly.

import * as StellarSdk from '@stellar/stellar-sdk';
import { signTransaction } from '@/lib/wallet-adapter';
import { CONTRACT_ADDRESSES, NETWORK_PASSPHRASE, SOROBAN_RPC_URL, ContractService } from './stellar-utils';
import { getBlendPoolAddress, getProtocolConfig, getUsdcAddress, getXlmAddress } from './protocol-config';
import { execViaAccountManager } from './exec-helpers';

/** Blend exec action — Deposit mapped to on-chain ExternalAction::Supply. */
export type BlendAction = 'Supply' | 'Withdraw';

/** Asset display info (icons/UI only — pool address is fetched from Registry at runtime). */
export interface BlendPoolAsset {
  symbol: string;
  trackingSymbol: string; // symbol used in tracking token contract
  iconPath: string;
  decimals: number;
}

/**
 * Asset display configuration for Blend pools.
 * NOTE: There is ONE Blend Capital pool contract that handles all assets.
 * The pool address is NOT per-token — it is fetched dynamically from
 * Registry.get_protocol_config().blend_pool (fallback: CONTRACT_ADDRESSES.BLEND_POOL).
 */
export const BLEND_POOL_ASSETS: BlendPoolAsset[] = [
  {
    symbol: 'XLM',
    trackingSymbol: 'BLEND_XLM',
    iconPath: '/coins/xlmbg.png',
    decimals: 7,
  },
  {
    symbol: 'USDC',
    trackingSymbol: 'BLEND_USDC',
    iconPath: '/icons/usdc-icon.svg',
    decimals: 7,
  },
];

/** Outcome of a Blend tx: success plus the hash, or an error message. */
export interface BlendTransactionResult {
  success: boolean;
  hash?: string;
  error?: string;
}

/** A user's Blend position: raw b-token balance and its underlying-asset value. */
export interface BlendBalanceInfo {
  bTokenBalance: string;
  underlyingBalance: string;
}

/** Pool-level Blend stats (APYs, TVL, utilization, b-rate) as display strings. */
export interface BlendPoolStats {
  supplyApy: string;
  borrowApy: string;
  totalSupply: string;
  totalBorrow: string;
  utilizationRate: string;
  bRate: string;
}

/** Parsed `get_reserve` output for one asset — see {@link BlendService._parseReserveData}. */
export interface BlendReserveData {
  totalSupply: string;     // human-readable token amount (e.g. "54321.12")
  totalBorrow: string;     // human-readable token amount
  utilizationRate: string; // percentage string e.g. "73.50"
  supplyAPY: string;       // percentage string e.g. "5.23"
  borrowAPY: string;       // percentage string e.g. "12.45"
  bRate: string;           // exchange rate e.g. "1.0582"
  decimals: number;
}

/** A user's Blend supply position for one token (b-tokens + underlying value). */
export interface BlendUserPosition {
  bTokenBalance: string;    // raw b-token balance (human-readable)
  underlyingValue: string;  // underlying value = bTokens * bRate
  tokenSymbol: string;
}

/** A historical Blend supply/withdraw event for a margin account. */
export interface BlendEvent {
  type: 'supply' | 'withdraw';
  tokenAddress: string;
  tokenSymbol: string;
  underlyingAmount: string;
  bTokenAmount: string;
  timestamp: number;      // ledger close time (unix)
  txHash: string;
  ledger: number;
}

/**
 * Stateless façade over the single shared Blend Capital pool, reached through
 * the Vanna smart account (AccountManager.exec) for writes and via Soroban
 * simulation for reads. Amounts crossing the contract boundary are WAD (1e18);
 * b-token / tracking balances are 7-decimal; reserve APYs mirror blend-sdk-js.
 * All methods are static — no instance state.
 */
export class BlendService {
  /**
   * Fetch the Blend Capital pool address from Registry.get_protocol_config().
   * Falls back to CONTRACT_ADDRESSES.BLEND_POOL. Returns null if neither is set.
   */
  static async getBlendPoolAddressFromRegistry(): Promise<string | null> {
    try {
      return await getBlendPoolAddress();
    } catch (error: any) {
      console.error('[BlendService] getBlendPoolAddressFromRegistry error:', error);
      return CONTRACT_ADDRESSES.BLEND_POOL || null;
    }
  }

  /** Resolve underlying SAC address for a Blend token symbol. */
  private static async resolveTokenAddress(tokenSymbol: string): Promise<string> {
    const sym = tokenSymbol.toUpperCase();
    if (sym === 'XLM') return getXlmAddress();
    if (sym === 'USDC' || sym === 'BLUSDC' || sym === 'BLEND_USDC') return getUsdcAddress();
    throw new Error(`Unsupported Blend token: ${tokenSymbol}`);
  }

  /**
   * Supply (deposit) tokens into the Blend Capital pool via AccountManager.exec.
   *
   * Flow:
   * 1. Fetch Blend pool address from get_protocol_config
   * 2. Call exec(sa, blend_pool, Supply, [token_addr], [amount_wad], 0)
   */
  static async depositToBlendPool(
    walletAddress: string,
    marginAccountAddress: string,
    tokenSymbol: string,
    amount: number
  ): Promise<BlendTransactionResult> {
    try {
      const assetInfo = BLEND_POOL_ASSETS.find((a) => a.symbol === tokenSymbol);
      if (!assetInfo) {
        throw new Error(`Unsupported token: ${tokenSymbol}`);
      }

      const blendPoolAddress = await BlendService.getBlendPoolAddressFromRegistry();
      if (!blendPoolAddress) {
        return {
          success: false,
          error:
            'Blend pool is not configured. Set Registry blend_pool (or CONTRACT_ADDRESSES.BLEND_POOL) before depositing.',
        };
      }

      const tokenAddress = await BlendService.resolveTokenAddress(tokenSymbol);
      const amountWad = BigInt(Math.floor(amount * 1e18));

      return await execViaAccountManager(
        walletAddress,
        marginAccountAddress,
        blendPoolAddress,
        'Supply',
        [tokenAddress],
        [amountWad],
        BigInt(0),
        20,
      );
    } catch (error: any) {
      console.error('[BlendService] Supply error:', error);
      return { success: false, error: error?.message || 'Supply failed' };
    }
  }

  /**
   * Withdraw tokens from the Blend Capital pool via AccountManager.exec.
   *
   * Flow:
   * 1. Fetch Blend pool address from get_protocol_config
   * 2. Call exec(sa, blend_pool, Withdraw, [token_addr], [amount_wad], 0)
   */
  static async withdrawFromBlendPool(
    walletAddress: string,
    marginAccountAddress: string,
    tokenSymbol: string,
    amount: number
  ): Promise<BlendTransactionResult> {
    try {
      const assetInfo = BLEND_POOL_ASSETS.find((a) => a.symbol === tokenSymbol);
      if (!assetInfo) {
        throw new Error(`Unsupported token: ${tokenSymbol}`);
      }

      const blendPoolAddress = await BlendService.getBlendPoolAddressFromRegistry();
      if (!blendPoolAddress) {
        return {
          success: false,
          error:
            'Blend pool is not configured. Set Registry blend_pool (or CONTRACT_ADDRESSES.BLEND_POOL) before withdrawing.',
        };
      }

      const tokenAddress = await BlendService.resolveTokenAddress(tokenSymbol);
      const amountWad = BigInt(Math.floor(amount * 1e18));

      return await execViaAccountManager(
        walletAddress,
        marginAccountAddress,
        blendPoolAddress,
        'Withdraw',
        [tokenAddress],
        [amountWad],
        BigInt(0),
        20,
      );
    } catch (error: any) {
      console.error('[BlendService] Withdraw error:', error);
      return { success: false, error: error?.message || 'Withdraw failed' };
    }
  }

  /**
   * Get user's Blend supply balance for a given token.
   *
   * Reads the tracking token balance from the TrackingToken contract.
  * The tracking symbols are: BLEND_XLM, BLEND_USDC
   * (set by AccountManager after a successful Blend deposit).
   */
  static async getUserBlendBalance(
    marginAccountAddress: string,
    tokenSymbol: 'XLM' | 'USDC'
  ): Promise<BlendBalanceInfo> {
    try {
      const assetInfo = BLEND_POOL_ASSETS.find((a) => a.symbol === tokenSymbol);
      if (!assetInfo) {
        throw new Error(`Unsupported token: ${tokenSymbol}`);
      }

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');

      const cfg = await getProtocolConfig();
      const trackingTokenAddress = cfg.tracking_token || CONTRACT_ADDRESSES.TRACKING_TOKEN;
      if (!trackingTokenAddress) {
        return { bTokenBalance: '0', underlyingBalance: '0' };
      }

      // Call balance(margin_account, tracking_symbol)
      const trackingContract = new StellarSdk.Contract(trackingTokenAddress);
      const balanceTx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          trackingContract.call(
            'balance',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
            StellarSdk.xdr.ScVal.scvSymbol(assetInfo.trackingSymbol)
          )
        )
        .setTimeout(30)
        .build();

      const balanceSim = await server.simulateTransaction(balanceTx);
      if (StellarSdk.rpc.Api.isSimulationSuccess(balanceSim) && balanceSim.result?.retval) {
        const raw = StellarSdk.scValToNative(balanceSim.result.retval);
        // Tracking token balance is in b-tokens (Blend's internal representation, 7 decimals)
        const balanceNum = Number(raw) / 1e7;
        const reserve = await BlendService.getBlendReserveData(tokenSymbol);
        const bRate = reserve ? parseFloat(reserve.bRate) : 1;
        const underlying = balanceNum * bRate;

        return {
          bTokenBalance: balanceNum.toFixed(7),
          underlyingBalance: underlying.toFixed(7),
        };
      }

      return { bTokenBalance: '0', underlyingBalance: '0' };
    } catch (error: any) {
      console.error('[BlendService] getUserBlendBalance error:', error);
      return { bTokenBalance: '0', underlyingBalance: '0' };
    }
  }

  /**
   * Get the actual token balance held by a margin account for Blend-supported assets.
   * Uses token.balance(marginAccountAddress) on Blend asset contracts directly.
   */
  static async getMarginAccountTokenBalance(
    marginAccountAddress: string,
    token: 'XLM' | 'USDC'
  ): Promise<string> {
    try {
      const tokenContractId = token === 'XLM'
        ? await getXlmAddress()
        : await getUsdcAddress();

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
      return (Number(raw) / 1e7).toFixed(7);
    } catch {
      return '0';
    }
  }

  /**
   * Fetch the tracking token contract address from the Registry.
   * This is the contract that stores b-token balances for margin accounts.
   * Users can add this token contract to their wallet to monitor their Blend positions.
   */
  static async getTrackingTokenContractAddress(): Promise<string | null> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      const registryContract = new StellarSdk.Contract(CONTRACT_ADDRESSES.REGISTRY);

      const tx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(registryContract.call('get_tracking_token_contract_addr'))
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
        return null;
      }
      return StellarSdk.scValToNative(sim.result.retval) as string;
    } catch (error: any) {
      console.error('[BlendService] getTrackingTokenContractAddress error:', error);
      return null;
    }
  }

  /**
   * Check if the Blend pool is configured.
   * Blend actions require Registry.BlendPoolContract to be present so the
   * smart account can route the call to the correct protocol branch.
   */
  static async isBlendPoolConfigured(): Promise<boolean> {
    return (await BlendService.getBlendPoolAddressFromRegistry()) !== null;
  }

  /**
   * Admin function: Call Registry.set_blend_pool_address() to configure the Blend pool.
   *
   * ⚠️  CRITICAL: This MUST be called by the admin wallet BEFORE any Blend deposit/withdraw
   * can succeed. Without it, SmartAccount.execute() panics:
   *   "No external protocol mapped for the given protocol address"
   *   → HostError: Error(WasmVm, InvalidAction) / UnreachableCodeReached
   *
   * @param adminAddress - Must be the protocol admin wallet address
   */
  static async adminSetBlendPoolAddress(
    adminAddress: string
  ): Promise<BlendTransactionResult> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const adminAccount = await server.getAccount(adminAddress);
      const registryContract = new StellarSdk.Contract(CONTRACT_ADDRESSES.REGISTRY);

      const transaction = new StellarSdk.TransactionBuilder(adminAccount, {
        fee: (parseInt(StellarSdk.BASE_FEE) * 10).toString(),
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          registryContract.call(
            'set_blend_pool_address',
            StellarSdk.nativeToScVal(CONTRACT_ADDRESSES.BLEND_POOL, { type: 'address' })
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
        await BlendService.pollTransactionStatus(server, result.hash);
        return { success: true, hash: result.hash };
      } else {
        throw new Error('Transaction rejected by network');
      }
    } catch (error: any) {
      console.error('[BlendService] adminSetBlendPoolAddress error:', error);
      return { success: false, error: error?.message || 'Failed to set Blend pool address' };
    }
  }

  /**
   * Get Blend pool stats by querying the Blend Capital pool contract.
   * Gets reserve data (b_rate, supply rate, borrow rate) for a specific asset.
   */
  static async getBlendPoolStats(_blendPoolAddress: string): Promise<BlendPoolStats> {
    const data = await BlendService.getBlendReserveData('XLM');
    if (!data) {
      return { supplyApy: '0.00', borrowApy: '0.00', totalSupply: '0', totalBorrow: '0', utilizationRate: '0', bRate: '1.0000' };
    }
    return {
      supplyApy: data.supplyAPY,
      borrowApy: data.borrowAPY,
      totalSupply: data.totalSupply,
      totalBorrow: data.totalBorrow,
      utilizationRate: data.utilizationRate,
      bRate: data.bRate,
    };
  }

  /**
   * Get real reserve data for a specific asset from the Blend pool contract.
   * Calls get_reserve(asset_address) and calculates APY, TVL, utilization.
   */
  static async getBlendReserveData(
    tokenSymbol: 'XLM' | 'USDC',
    blendPoolAddress?: string
  ): Promise<BlendReserveData | null> {
    const assetAddress =
      tokenSymbol === 'XLM' ? await getXlmAddress() : await getUsdcAddress();
    if (!assetAddress) return null;

    const poolAddress =
      blendPoolAddress ??
      (await BlendService.getBlendPoolAddressFromRegistry()) ??
      CONTRACT_ADDRESSES.BLEND_POOL;

    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      const contract = new StellarSdk.Contract(poolAddress);

      // Call get_reserve(asset_address)
      const tx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'get_reserve',
            StellarSdk.nativeToScVal(assetAddress, { type: 'address' })
          )
        )
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
        console.warn(`[BlendService] get_reserve failed for ${tokenSymbol}`);
        return null;
      }

      const reserve = StellarSdk.scValToNative(sim.result.retval) as any;
      return BlendService._parseReserveData(reserve);
    } catch (err: any) {
      console.error(`[BlendService] getBlendReserveData(${tokenSymbol}) error:`, err);
      return null;
    }
  }

  /**
   * Parse raw reserve data from scValToNative into BlendReserveData.
   *
   * Mirrors blend-sdk-js' Reserve.estimateInterestRate / estApy logic so our
   * APYs match mainnet.blend.capital exactly:
   *   - r_base / r_one / r_two / r_three / util are SCALAR_7 fixed-point
   *   - ir_mod is SCALAR_7 on V2 pools (TestnetV2 etc.); pre-V2 used SCALAR_9
   *   - curIr (after IR_MOD application) is SCALAR_7 representing the
   *     ANNUALISED rate — there is no per-ledger conversion to do
   *   - Borrow APY = daily compound from APR (`(1 + apr/365)^365 - 1`)
   *   - Supply APY = weekly compound from supply APR
   *     (`(1 + supplyApr/52)^52 - 1`)
   */
  static _parseReserveData(reserve: any): BlendReserveData {
    const SCALAR_7 = 1e7;
    const SCALAR_12 = 1e12; // Blend uses 1e12 precision for b_rate and d_rate accumulators

    // b_rate and d_rate are stored with SCALAR_12 (1e12) precision
    const bRate = Number(reserve.data.b_rate);       // raw, precision 1e12
    const bSupply = Number(reserve.data.b_supply);   // b-tokens (7-decimal)
    const dRate = Number(reserve.data.d_rate);       // raw, precision 1e12
    const dSupply = Number(reserve.data.d_supply);   // d-tokens (7-decimal)

    // ir_mod is stored in SCALAR_7 on V2 pools (the only pool version we use
    // — CONTRACT_ADDRESSES.BLEND_POOL is the Blend v2 pool). DO NOT magnitude-
    // detect: at high utilization the dynamic ir_mod can rise well above 1e8
    // (10x), which would falsely look like a V1 (SCALAR_9) value and crash
    // the rate by 100x. Hardcoding SCALAR_7 keeps the math correct.
    const irMod = Number(reserve.data.ir_mod);
    const IR_MOD_SCALAR = 1e7;

    const decimals: number = Number(reserve.config.decimals);

    // IR curve parameters — all SCALAR_7 fixed-point representing annual
    // rate (e.g. r_one = 500_000 means 5% APR contribution).
    const rBase = Number(reserve.config.r_base);
    const rOne = Number(reserve.config.r_one);
    const rTwo = Number(reserve.config.r_two);
    const rThree = Number(reserve.config.r_three);
    const targetUtilRaw = Number(reserve.config.util); // SCALAR_7

    // Total underlying supply/borrow for display (human-readable token amounts)
    const totalSupplyRaw = (bSupply / SCALAR_7) * (bRate / SCALAR_12);
    const totalBorrowRaw = (dSupply / SCALAR_7) * (dRate / SCALAR_12);

    // Underlying utilization (decimal, e.g. 0.7834)
    const utilization = totalSupplyRaw > 0 ? totalBorrowRaw / totalSupplyRaw : 0;

    // Blend's IR curve uses underlying utilization directly. All math below
    // keeps values in SCALAR_7 form to mirror the SDK's FixedMath helpers,
    // then divides by SCALAR_7 at the end to get a decimal APR.
    const targetUtilDecimal = targetUtilRaw / SCALAR_7;
    const FIVE_PCT = 0.05;
    const NINETY_FIVE_PCT = 0.95;

    let curIrSCALAR_7: number; // result in SCALAR_7 = annual rate * 1e7
    if (utilization <= targetUtilDecimal) {
      // Tier 1: linear from r_base → r_base + r_one as util goes 0 → target
      const utilScalar = targetUtilDecimal > 0
        ? (utilization / targetUtilDecimal) * SCALAR_7
        : 0;
      const baseRate = (utilScalar * rOne) / SCALAR_7 + rBase;
      curIrSCALAR_7 = (baseRate * irMod) / IR_MOD_SCALAR;
    } else if (utilization <= NINETY_FIVE_PCT) {
      // Tier 2: linear slope through r_two between target and 95%
      const utilScalar = ((utilization - targetUtilDecimal) /
        (NINETY_FIVE_PCT - targetUtilDecimal)) * SCALAR_7;
      const baseRate = (utilScalar * rTwo) / SCALAR_7 + rOne + rBase;
      curIrSCALAR_7 = (baseRate * irMod) / IR_MOD_SCALAR;
    } else {
      // Tier 3: r_three slope on top of the irMod-adjusted (r_base+r_one+r_two)
      // intersection. The SDK does NOT apply irMod to the r_three excess.
      const utilScalar = ((utilization - NINETY_FIVE_PCT) / FIVE_PCT) * SCALAR_7;
      const extraRate = (utilScalar * rThree) / SCALAR_7;
      const intersection = ((rTwo + rOne + rBase) * irMod) / IR_MOD_SCALAR;
      curIrSCALAR_7 = extraRate + intersection;
    }

    const borrowAprDecimal = curIrSCALAR_7 / SCALAR_7;
    // Blend UI compounds borrow APR daily (365 periods/yr).
    const borrowApyDecimal = Math.pow(1 + borrowAprDecimal / 365, 365) - 1;

    // Supply APR = borrow APR × utilization × (1 − backstop_take_rate).
    // Blend's bstop_rate is on-chain at pool_config().bstop_rate (SCALAR_7).
    // For supported Blend pools it has historically been 0.10
    // (10%); fetching it dynamically would require an extra simulate call
    // per pool, so we keep the constant in sync with current mainnet config.
    const BACKSTOP_TAKE_RATE = 0.10;
    const supplyAprDecimal = borrowAprDecimal * utilization * (1 - BACKSTOP_TAKE_RATE);
    // Blend UI compounds supply APR weekly (52 periods/yr).
    const supplyApyDecimal = Math.pow(1 + supplyAprDecimal / 52, 52) - 1;

    return {
      totalSupply: totalSupplyRaw.toFixed(decimals > 4 ? 4 : decimals),
      totalBorrow: totalBorrowRaw.toFixed(decimals > 4 ? 4 : decimals),
      utilizationRate: (utilization * 100).toFixed(2),
      supplyAPY: Math.max(0, supplyApyDecimal * 100).toFixed(2),
      borrowAPY: Math.max(0, borrowApyDecimal * 100).toFixed(2),
      bRate: (bRate / SCALAR_12).toFixed(7),
      decimals,
    };
  }

  /**
   * Get Blend reserve stats (XLM, USDC) in parallel.
   */
  static async getAllBlendReserveStats(): Promise<Record<string, BlendReserveData | null>> {
    const [xlm, usdc] = await Promise.all([
      BlendService.getBlendReserveData('XLM'),
      BlendService.getBlendReserveData('USDC'),
    ]);
    return { XLM: xlm, USDC: usdc };
  }

  /**
   * Get user's Blend supply positions for all tokens via tracking token contract.
   * Returns b-token balance and estimated underlying value per token.
   */
  static async getAllUserBlendPositions(
    marginAccountAddress: string
  ): Promise<Record<string, BlendUserPosition>> {
    const assets = BLEND_POOL_ASSETS;
    const empty = (): BlendUserPosition => ({ bTokenBalance: '0', underlyingValue: '0', tokenSymbol: '' });
    const result: Record<string, BlendUserPosition> = {
      XLM: empty(), USDC: empty(),
    };

    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');

      // Fetch tracking token contract address from get_protocol_config
      const cfg = await getProtocolConfig();
      const trackingAddress = cfg.tracking_token || CONTRACT_ADDRESSES.TRACKING_TOKEN;
      if (!trackingAddress) {
        return result;
      }
      const trackContract = new StellarSdk.Contract(trackingAddress);

      // Fetch b-rates for value calculation
      const [xlmReserve, usdcReserve] = await Promise.all([
        BlendService.getBlendReserveData('XLM'),
        BlendService.getBlendReserveData('USDC'),
      ]);
      const bRates: Record<string, number> = {
        XLM: xlmReserve ? parseFloat(xlmReserve.bRate) : 1,
        USDC: usdcReserve ? parseFloat(usdcReserve.bRate) : 1,
      };

      // Fetch balances for each tracking symbol in parallel
      const balancePromises = assets.map(async (asset) => {
        const balTx = new StellarSdk.TransactionBuilder(tempAccount, {
          fee: StellarSdk.BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE,
        }).addOperation(
          trackContract.call(
            'balance',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
            StellarSdk.xdr.ScVal.scvSymbol(asset.trackingSymbol)
          )
        ).setTimeout(30).build();

        const balSim = await server.simulateTransaction(balTx);
        if (StellarSdk.rpc.Api.isSimulationSuccess(balSim) && balSim.result?.retval) {
          const raw = Number(StellarSdk.scValToNative(balSim.result.retval));
          const bTokens = raw / 1e7; // tracking token uses 7 decimals
          const underlying = bTokens * bRates[asset.symbol];
          return {
            symbol: asset.symbol,
            bTokenBalance: bTokens.toFixed(7),
            underlyingValue: underlying.toFixed(7),
          };
        }
        return { symbol: asset.symbol, bTokenBalance: '0', underlyingValue: '0' };
      });

      const balances = await Promise.all(balancePromises);
      for (const b of balances) {
        result[b.symbol] = { bTokenBalance: b.bTokenBalance, underlyingValue: b.underlyingValue, tokenSymbol: b.symbol };
      }
    } catch (err: any) {
      console.error('[BlendService] getAllUserBlendPositions error:', err);
    }
    return result;
  }

  /**
   * Fetch supply/withdraw events for a margin account from the Blend pool.
   * Uses Soroban RPC getEvents to find historical events.
   */
  static async getBlendEvents(
    marginAccountAddress: string,
    blendPoolAddress?: string
  ): Promise<BlendEvent[]> {
    const registryPoolAddress = await BlendService.getBlendPoolAddressFromRegistry();
    const xlmAddr = await getXlmAddress();
    const usdcAddr = await getUsdcAddress();
    const poolAddress = blendPoolAddress ?? registryPoolAddress ?? CONTRACT_ADDRESSES.BLEND_POOL;
    const assetMap: Record<string, string> = {
      [xlmAddr]: 'XLM',
      [usdcAddr]: 'USDC',
      [CONTRACT_ADDRESSES.BLEND_XLM]: 'XLM',
      [CONTRACT_ADDRESSES.BLEND_USDC]: 'USDC',
    };

    try {
      if (!poolAddress || typeof poolAddress !== 'string') {
        return [];
      }
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);

      // Get current ledger to set a reasonable start ledger (last ~30 days ≈ 518400 ledgers)
      const ledgerResp = await server.getLatestLedger();
      const startLedger = Math.max(1, ledgerResp.sequence - 518400);

      // Topics: only filter by action symbol (supply/withdraw) — filter account client-side.
      // Passing account address as topic causes XDR decode errors on some RPC nodes.
      const supplyTopic = StellarSdk.xdr.ScVal.scvSymbol('supply').toXDR('base64');
      const withdrawTopic = StellarSdk.xdr.ScVal.scvSymbol('withdraw').toXDR('base64');

      // Fetch supply events (all for pool, filter by account below)
      const safeGetEvents = async (topic: string) => {
        try {
          const resp = await server.getEvents({
            startLedger,
            filters: [{
              type: 'contract',
              contractIds: [poolAddress],
              topics: [[topic]],
            }],
            limit: 200,
          } as any);
          if ((resp as any)?.error) return [];
          return (resp as any)?.events ?? [];
        } catch {
          return [];
        }
      };

      const supplyEvents = await safeGetEvents(supplyTopic);
      const withdrawEvents = await safeGetEvents(withdrawTopic);

      const parseEvents = (events: any[], eventType: 'supply' | 'withdraw'): BlendEvent[] => {
        const results: BlendEvent[] = [];
        for (const ev of events ?? []) {
          try {
            const topics = ev.topic?.map((t: any) => StellarSdk.scValToNative(t));
            // topics[2] or topics[1] may hold the "from" address depending on pool contract version
            const fromAddress = (topics?.[2] ?? topics?.[1]) as string;
            if (fromAddress && fromAddress !== marginAccountAddress) continue;
            const data = ev.value ? StellarSdk.scValToNative(ev.value) : null;
            const tokenAddress = topics?.[1] as string;
            const [underlying, bTokens] = Array.isArray(data) ? data.map(Number) : [0, 0];
            results.push({
              type: eventType,
              tokenAddress,
              tokenSymbol: assetMap[tokenAddress] ?? tokenAddress?.slice(0, 8) ?? '?',
              underlyingAmount: (underlying / 1e7).toFixed(7),
              bTokenAmount: (bTokens / 1e7).toFixed(7),
              timestamp: ev.ledgerClosedAt ? new Date(ev.ledgerClosedAt).getTime() : 0,
              txHash: ev.txHash ?? '',
              ledger: ev.ledger ?? 0,
            });
          } catch {/* skip malformed events */}
        }
        return results;
      };

      const events: BlendEvent[] = [
        ...parseEvents(supplyEvents, 'supply'),
        ...parseEvents(withdrawEvents, 'withdraw'),
      ];

      // Sort by timestamp descending
      events.sort((a, b) => b.timestamp - a.timestamp);
      return events;
    } catch (err: any) {
      console.warn('[BlendService] getBlendEvents error:', err?.message ?? err);
      return [];
    }
  }

  /**
   * Get wallet balance for a specific asset (XLM, USDC).
   */
  static async getWalletBalance(
    walletAddress: string,
    assetType: 'XLM' | 'USDC'
  ): Promise<string> {
    try {
      const balances = await ContractService.getAllTokenBalances(walletAddress);
      return balances[assetType] ?? '0';
    } catch (error: any) {
      console.error('[BlendService] getWalletBalance error:', error);
      return '0';
    }
  }

  /**
   * Poll for transaction confirmation.
   */
  static async pollTransactionStatus(
    server: StellarSdk.rpc.Server,
    hash: string
  ): Promise<void> {
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      try {
        const transaction = await server.getTransaction(hash);
        if (transaction.status !== 'NOT_FOUND') {
          if (transaction.status === 'SUCCESS') {
            return;
          } else {
            throw new Error(`Transaction failed with status: ${transaction.status}`);
          }
        }
      } catch (error: any) {
        if (error?.message?.includes('Transaction failed')) {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      attempts++;
    }
    throw new Error('Transaction timed out waiting for confirmation');
  }
}
