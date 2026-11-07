// Blend Capital integration: deposit/withdraw into the single shared Blend pool
// from the Vanna margin account (CreditLayer.margin_execute), plus reserve-stats
// and position reads. APY math mirrors blend-sdk-js so figures match
// testnet.blend.capital exactly.

import * as StellarSdk from '@stellar/stellar-sdk';
import {
  CONTRACT_ADDRESSES,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
  ContractService,
  describeFailedTx,
} from './stellar-utils';
import { CreditLayer, readOr, sc, type ExternalAction } from './credit-layer';
import { blendSupplyApyFromApr } from './rate-display';

/** Blend action as the UI names it. Maps to ExternalAction Supply / Withdraw. */
export type BlendAction = 'Deposit' | 'Withdraw';

/** Asset display info (icons/UI only — the pool address is CONTRACT_ADDRESSES.BLEND_POOL). */
export interface BlendPoolAsset {
  symbol: string;
  /** Position key the app has always used for this Blend asset (BLEND_XLM / BLEND_USDC). */
  trackingSymbol: string;
  iconPath: string;
  decimals: number;
}

/**
 * Asset display configuration for Blend pools.
 * NOTE: There is ONE Blend Capital pool contract that handles all assets
 * (CONTRACT_ADDRESSES.BLEND_POOL). "USDC" here is Blend's own USDC (BLUSDC).
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
  /** Sequence the account will have once this tx confirms — pass to a
   * chained same-account call's `knownSequence` param instead of racing a
   * fresh `getAccount()` read. See stellar-utils.ts's isFootprintRaceError. */
  nextSequence?: string;
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

/** Token contract the Blend pool lists for a UI symbol. */
const BLEND_TOKEN_ADDRESS: Record<string, string> = {
  XLM: CONTRACT_ADDRESSES.BLEND_XLM,
  USDC: CONTRACT_ADDRESSES.BLEND_USDC,
};

/** One row of BlendValuer.positions(pool, account): native (7dp) underlying owned / owed. */
interface BlendValuerPosition {
  token: string;
  owned: bigint;
  owed: bigint;
}

/** Arguments for CreditLayer.margin_execute (see lib/credit-layer.ts). */
export interface VenueExecuteArgs {
  target: string;
  action: ExternalAction;
  tokens: string[];
  amounts: bigint[];
  minOut: bigint;
}

/** Converts a human token amount to WAD through a 7-decimal integer step. */
function humanToWad(amount: number): bigint {
  // Split through a 7-decimal (stroop-precision) integer step rather than
  // `amount * 1e18` directly — that raw float multiplication loses precision
  // once the product needs more significant digits than a JS double can hold,
  // confirmed live to overshoot the real balance by a tiny excess on a 100%
  // withdraw elsewhere (see ContractService.withdraw in stellar-utils.ts).
  return BigInt(Math.floor(amount * 1e7)) * BigInt(10 ** 11);
}

/**
 * Stateless façade over the single shared Blend Capital pool. Writes go
 * through CreditLayer.margin_execute(margin, BLEND_POOL, Supply|Withdraw,
 * [token], [amount_wad], 0); the Blend validator turns them into a pool
 * `submit`. Positions are read from the BlendValuer (underlying owned, 7dp).
 * Reserve APYs mirror blend-sdk-js. All methods are static — no instance state.
 */
export class BlendService {
  /**
   * The Blend Capital pool address. Kept for callers that used to look it up
   * in the (retired) Registry; it is now the fixed CONTRACT_ADDRESSES.BLEND_POOL.
   */
  static async getBlendPoolAddressFromRegistry(): Promise<string | null> {
    return CONTRACT_ADDRESSES.BLEND_POOL;
  }

  /**
   * margin_execute arguments for a Blend supply or withdraw of `amount`
   * (human units) of `tokenSymbol` ('XLM' | 'USDC' = BLUSDC).
   * Blend: tokens=[token], amounts=[amount WAD], min_out unused (0).
   */
  static buildExecuteArgs(action: BlendAction, tokenSymbol: string, amount: number): VenueExecuteArgs {
    const token = BLEND_TOKEN_ADDRESS[tokenSymbol];
    if (!token) throw new Error(`Unsupported token: ${tokenSymbol}`);
    const amountWad = humanToWad(amount);
    if (amountWad <= BigInt(0)) throw new Error('Amount must be greater than zero');
    return {
      target: CONTRACT_ADDRESSES.BLEND_POOL,
      action: action === 'Deposit' ? 'Supply' : 'Withdraw',
      tokens: [token],
      amounts: [amountWad],
      minOut: BigInt(0),
    };
  }

  /**
   * Deposit tokens into the Blend Capital pool from the margin account via
   * CreditLayer.margin_execute(…, Supply, …).
   *
   * `walletAddress` / `knownSequence` are kept for signature compatibility
   * (one-click strategy, Copilot): the connected wallet signs, and the shared
   * invokeWrite already retries a stale-sequence / footprint race.
   */
  static async depositToBlendPool(
    walletAddress: string,
    marginAccountAddress: string,
    tokenSymbol: string,
    amount: number,
    knownSequence?: string
  ): Promise<BlendTransactionResult> {
    void walletAddress;
    void knownSequence;
    return BlendService.execute('Deposit', marginAccountAddress, tokenSymbol, amount);
  }

  /**
   * Withdraw tokens from the Blend Capital pool back into the margin account via
   * CreditLayer.margin_execute(…, Withdraw, …). Blend caps a withdraw at the
   * position, so asking for more than is owned withdraws everything.
   */
  static async withdrawFromBlendPool(
    walletAddress: string,
    marginAccountAddress: string,
    tokenSymbol: string,
    amount: number,
    knownSequence?: string
  ): Promise<BlendTransactionResult> {
    void walletAddress;
    void knownSequence;
    return BlendService.execute('Withdraw', marginAccountAddress, tokenSymbol, amount);
  }

  private static async execute(
    action: BlendAction,
    marginAccountAddress: string,
    tokenSymbol: string,
    amount: number,
  ): Promise<BlendTransactionResult> {
    try {
      if (!marginAccountAddress) return { success: false, error: 'Margin account required' };
      const a = BlendService.buildExecuteArgs(action, tokenSymbol, amount);
      const res = await CreditLayer.execute(marginAccountAddress, a.target, a.action, a.tokens, a.amounts, a.minOut);
      return { success: res.success, hash: res.hash, error: res.error };
    } catch (error: any) {
      console.error(`[BlendService] ${action} error:`, error);
      return { success: false, error: error?.message || `${action} failed` };
    }
  }

  /**
   * The margin account's Blend positions from BlendValuer.positions(pool, account):
   * one row per reserve with `owned` underlying (native 7dp) and `owed`.
   */
  private static async getValuerPositions(marginAccountAddress: string): Promise<BlendValuerPosition[]> {
    const raw = await readOr<any[]>(
      CONTRACT_ADDRESSES.BLEND_VALUER,
      'positions',
      [sc.address(CONTRACT_ADDRESSES.BLEND_POOL), sc.address(marginAccountAddress)],
      [],
    );
    return (raw || []).map((r: any) => ({
      token: String(r?.token ?? ''),
      owned: BigInt(r?.owned ?? 0),
      owed: BigInt(r?.owed ?? 0),
    }));
  }

  /** Builds a BlendBalanceInfo from an underlying native amount and the reserve b-rate. */
  private static toBalance(ownedNative: bigint, bRate: number): BlendBalanceInfo {
    const underlying = Number(ownedNative) / 1e7;
    const bTokens = bRate > 0 ? underlying / bRate : underlying;
    return { bTokenBalance: bTokens.toFixed(7), underlyingBalance: underlying.toFixed(7) };
  }

  /**
   * Get the margin account's Blend supply balance for a given token.
   *
   * Reads BlendValuer.positions (underlying owned, 7 decimals); the b-token
   * figure is derived from the reserve's current b-rate.
   */
  static async getUserBlendBalance(
    marginAccountAddress: string,
    tokenSymbol: 'XLM' | 'USDC'
  ): Promise<BlendBalanceInfo> {
    try {
      const token = BLEND_TOKEN_ADDRESS[tokenSymbol];
      if (!token) throw new Error(`Unsupported token: ${tokenSymbol}`);
      const [positions, reserve] = await Promise.all([
        BlendService.getValuerPositions(marginAccountAddress),
        BlendService.getBlendReserveData(tokenSymbol),
      ]);
      const row = positions.find((p) => p.token === token);
      if (!row || row.owned <= BigInt(0)) return { bTokenBalance: '0', underlyingBalance: '0' };
      return BlendService.toBalance(row.owned, reserve ? parseFloat(reserve.bRate) : 1);
    } catch (error: any) {
      console.error('[BlendService] getUserBlendBalance error:', error);
      return { bTokenBalance: '0', underlyingBalance: '0' };
    }
  }

  /**
   * Get the actual token balance held by a margin account, reading
   * `token.balance(marginAccountAddress)` directly on the asset's own SAC.
   * Despite the Blend-specific name, this reads any of the four
   * margin-supported assets (XLM, USDC = BLUSDC, AQUSDC, SOUSDC).
   */
  static async getMarginAccountTokenBalance(
    marginAccountAddress: string,
    token: 'XLM' | 'USDC' | 'AQUSDC' | 'SOUSDC'
  ): Promise<string> {
    const tokenContractId =
      token === 'XLM' ? CONTRACT_ADDRESSES.BLEND_XLM
      : token === 'USDC' ? CONTRACT_ADDRESSES.BLEND_USDC
      : token === 'AQUSDC' ? CONTRACT_ADDRESSES.AQUARIUS_USDC
      : CONTRACT_ADDRESSES.SOROSWAP_USDC;
    const raw = await readOr<bigint>(tokenContractId, 'balance', [sc.address(marginAccountAddress)], BigInt(0));
    return (Number(raw) / 1e7).toFixed(7);
  }

  /**
   * Blend actions need only the (fixed) Blend pool address, so this is always
   * true now. Kept so existing UI gates keep compiling.
   */
  static async isBlendPoolConfigured(): Promise<boolean> {
    return true;
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
    // Asset contract addresses in the Blend pool
    const assetAddresses: Record<string, string> = {
      XLM: CONTRACT_ADDRESSES.BLEND_XLM,
      USDC: CONTRACT_ADDRESSES.BLEND_USDC,
    };

    const assetAddress = assetAddresses[tokenSymbol];
    if (!assetAddress) return null;

    const poolAddress = blendPoolAddress ?? CONTRACT_ADDRESSES.BLEND_POOL;

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
   * APYs match testnet.blend.capital exactly:
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
    // — CONTRACT_ADDRESSES.BLEND_POOL is the TestnetV2 pool). DO NOT magnitude-
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
    // For the four supported testnet pools it has historically been 0.10
    // (10%); fetching it dynamically would require an extra simulate call
    // per pool, so we keep the constant in sync with current testnet config.
    const BACKSTOP_TAKE_RATE = 0.10;
    const supplyAprDecimal = borrowAprDecimal * utilization * (1 - BACKSTOP_TAKE_RATE);
    // Blend UI compounds supply APR weekly (52 periods/yr).
    const supplyApyDecimal = blendSupplyApyFromApr(supplyAprDecimal);

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
   * Get the margin account's Blend supply positions for all tokens from
   * BlendValuer.positions (one read). Returns b-token balance (derived from the
   * b-rate) and underlying value per token.
   */
  static async getAllUserBlendPositions(
    marginAccountAddress: string
  ): Promise<Record<string, BlendUserPosition>> {
    const empty = (): BlendUserPosition => ({ bTokenBalance: '0', underlyingValue: '0', tokenSymbol: '' });
    const result: Record<string, BlendUserPosition> = {
      XLM: empty(), USDC: empty(),
    };

    try {
      const [positions, xlmReserve, usdcReserve] = await Promise.all([
        BlendService.getValuerPositions(marginAccountAddress),
        BlendService.getBlendReserveData('XLM'),
        BlendService.getBlendReserveData('USDC'),
      ]);
      const bRates: Record<string, number> = {
        XLM: xlmReserve ? parseFloat(xlmReserve.bRate) : 1,
        USDC: usdcReserve ? parseFloat(usdcReserve.bRate) : 1,
      };
      for (const asset of BLEND_POOL_ASSETS) {
        const row = positions.find((p) => p.token === BLEND_TOKEN_ADDRESS[asset.symbol]);
        if (!row || row.owned <= BigInt(0)) continue;
        const bal = BlendService.toBalance(row.owned, bRates[asset.symbol]);
        result[asset.symbol] = { bTokenBalance: bal.bTokenBalance, underlyingValue: bal.underlyingBalance, tokenSymbol: asset.symbol };
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
    const poolAddress = blendPoolAddress ?? CONTRACT_ADDRESSES.BLEND_POOL;
    const assetMap: Record<string, string> = {
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
            // Decode the real on-chain reason (e.g. a Blend pool's own error
            // event, or scecExceededLimit) instead of a bare status string —
            // a generic "Transaction failed with status: FAILED" gave no way
            // to tell a genuine rejection apart from a retriable footprint
            // race, and hid the actual cause from the user entirely.
            const reason = describeFailedTx(transaction);
            console.error('❌ Blend tx did not succeed:', { hash, status: transaction.status, reason });
            throw new Error(`Transaction failed with status: ${transaction.status}${reason ? `: ${reason}` : ''}`);
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
