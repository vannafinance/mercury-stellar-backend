// Soroswap (AMM) integration: XLM/USDC pool stats, LP positions, swap quotes,
// and add/remove-liquidity + swap, both from the Vanna margin account (via
// AccountManager.exec) and directly from the user's wallet. Reads use a
// throwaway sim source; amounts for exec are WAD (1e18) while on-chain
// reserves/LP balances are 7-decimal (STROOP). RemoveLiquidity LP amount stays
// in raw LP units (Soroswap controller legacy quirk).

import * as StellarSdk from '@stellar/stellar-sdk';
import { signTransaction } from '@/lib/wallet-adapter';
import {
  CONTRACT_ADDRESSES,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
} from './stellar-utils';
import { floorAmountToStroops, stroopsToWad } from './utils/swap-amount';
import {
  fallbackUsdcAddress,
  fallbackXlmAddress,
  getProtocolConfig,
  getSoroswapRouter,
  getUsdcAddress,
  getXlmAddress,
} from './protocol-config';
import { execViaAccountManager } from './exec-helpers';

// ── Soroswap Constants ────────────────────────────────────────────────────────
const SOROSWAP_ROUTER = CONTRACT_ADDRESSES.SOROSWAP_ROUTER;
const SOROSWAP_XLM   = fallbackXlmAddress();
const SOROSWAP_USDC  = fallbackUsdcAddress();
const SOROSWAP_XLM_USDC_POOL = CONTRACT_ADDRESSES.SOROSWAP_XLM_USDC_POOL;
const SOROSWAP_API   = 'https://api.soroswap.finance';
const LP_TRACKING_SYMBOL = 'SS_XLM_USDC'; // Registry tracking token symbol

/** Tokens the Spot-swap feature supports on Soroswap. */
export type SoroswapSwapSymbol = 'XLM' | 'USDC';

/**
 * Each non-XLM token's swap partner is always XLM (Soroswap's own router is a
 * real generic AMM, but the only pool we've confirmed live and liquid on this
 * testnet is XLM/USDC). XLM itself resolves to USDC by default; its
 * resolution can come from the caller's actual token-out selection.
 */
export function getSoroswapSwapPartner(symbol: SoroswapSwapSymbol, explicitTokenOut?: SoroswapSwapSymbol): SoroswapSwapSymbol | null {
  if (symbol !== 'XLM') return 'XLM';
  return explicitTokenOut ?? 'USDC';
}

const WAD = 1e18;
const STROOP = 1e7; // Stellar 7-decimal precision

const toWad  = (amount: number): bigint => BigInt(Math.floor(amount * WAD));
const toStroop = (amount: number): bigint => BigInt(Math.floor(amount * STROOP + 1e-9));

// ── Types ─────────────────────────────────────────────────────────────────────

/** A historical Soroswap add/remove-liquidity event (amounts 7-decimal strings). */
export interface SoroswapLpEvent {
  type: 'deposit' | 'withdraw';
  shareAmount: string;  // LP shares (7 decimals)
  amountXLM: string;    // XLM contributed/withdrawn (7 decimals)
  amountUSDC: string;   // USDC contributed/withdrawn (7 decimals)
  timestamp: number;    // unix ms
  txHash: string;
  ledger: number;
}

/** Reserves, total LP supply, and fee for the XLM/USDC pool (display strings). */
export interface SoroswapPoolStats {
  reserveXLM:   string; // human-readable (7 decimals)
  reserveUSDC:  string;
  totalShares:  string;
  feeFraction:  string; // "0.30%"
  pairAddress:  string;
}

/** A margin account's Soroswap LP position (LP shares, 7-decimal string). */
export interface SoroswapLpPosition {
  lpBalance: string; // LP shares held by margin account (7 decimals)
}

/** Outcome of a Soroswap tx: success plus the hash, or an error message. */
export interface SoroswapTransactionResult {
  success: boolean;
  hash?:   string;
  error?:  string;
}

/** Static config for a supported Soroswap pool (display + fee in bps×10). */
export interface SoroswapPoolConfig {
  id:          string;
  tokens:      [string, string];
  displayName: string;
  feeFraction: number;
  trackingSymbol: string;
  pairAddress?: string;
}

/** Supported Soroswap pools. */
export const SOROSWAP_POOLS: SoroswapPoolConfig[] = [
  {
    id:          'soroswap-xlm-usdc',
    tokens:      ['XLM', 'USDC'],
    displayName: 'XLM / USDC',
    feeFraction: 30,
    trackingSymbol: 'SS_XLM_USDC',
    pairAddress: SOROSWAP_XLM_USDC_POOL,
  },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function simulateTx(
  server: StellarSdk.rpc.Server,
  account: StellarSdk.Account,
  operation: StellarSdk.xdr.Operation,
): Promise<StellarSdk.rpc.Api.SimulateTransactionResponse> {
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();
  return server.simulateTransaction(tx);
}

function tempAccount(): [StellarSdk.rpc.Server, StellarSdk.Account] {
  const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
  const kp     = StellarSdk.Keypair.random();
  const acct   = new StellarSdk.Account(kp.publicKey(), '0');
  return [server, acct];
}

// ── SoroswapService ───────────────────────────────────────────────────────────

/**
 * Stateless façade over the Soroswap router + XLM/USDC pair. Resolves effective
 * router/token addresses from Registry (with hardcoded fallbacks), reads pool
 * stats and LP balances via simulation, and routes liquidity/swap writes either
 * through the margin account (AccountManager.execute, amounts in WAD) or the
 * user's wallet directly. All methods are static.
 */
export class SoroswapService {

  // ── Registry helpers ───────────────────────────────────────────────────────

  /** Returns the Soroswap router address from get_protocol_config, or null. */
  static async getRegistrySoroswapRouterAddress(): Promise<string | null> {
    try {
      return await getSoroswapRouter();
    } catch {
      return null;
    }
  }

  /** Returns the canonical USDC address from get_protocol_config, or null. */
  static async getRegistrySoroswapUsdcAddress(): Promise<string | null> {
    try {
      const cfg = await getProtocolConfig();
      return cfg.usdc || null;
    } catch {
      return null;
    }
  }

  /** Returns the Soroswap router address (Registry → CONTRACT_ADDRESSES fallback). */
  static async getEffectiveRouterAddress(): Promise<string> {
    const router = await SoroswapService.getRegistrySoroswapRouterAddress();
    if (router) return router;
    return SOROSWAP_ROUTER;
  }

  /** Returns Soroswap XLM/USDC token addresses effective for current config. */
  private static async getSwapTokenAddresses(): Promise<{ xlm: string; usdc: string }> {
    // Prefer the token pair actually configured on the live Soroswap pool.
    try {
      const [server, acct] = tempAccount();
      const pool = new StellarSdk.Contract(SOROSWAP_XLM_USDC_POOL);
      const [token0Sim, token1Sim] = await Promise.all([
        simulateTx(server, acct, pool.call('token_0')),
        simulateTx(server, acct, pool.call('token_1')),
      ]);

      if (
        StellarSdk.rpc.Api.isSimulationSuccess(token0Sim) && token0Sim.result?.retval &&
        StellarSdk.rpc.Api.isSimulationSuccess(token1Sim) && token1Sim.result?.retval
      ) {
        const token0 = StellarSdk.scValToNative(token0Sim.result.retval) as string;
        const token1 = StellarSdk.scValToNative(token1Sim.result.retval) as string;
        const xlm = SOROSWAP_XLM;

        if (token0 === xlm) return { xlm, usdc: token1 };
        if (token1 === xlm) return { xlm, usdc: token0 };
      }
    } catch {
      // fall through to registry/config fallback
    }

    return {
      xlm: await getXlmAddress(),
      usdc: await getUsdcAddress(),
    };
  }

  /** Resolves the on-chain contract address for any Spot-swap-supported symbol. */
  private static async getSwapTokenContract(symbol: SoroswapSwapSymbol): Promise<string> {
    const { xlm, usdc } = await SoroswapService.getSwapTokenAddresses();
    return symbol === 'XLM' ? xlm : usdc;
  }

  /** Returns the tracking token contract address from get_protocol_config, or null. */
  static async getTrackingTokenAddress(): Promise<string | null> {
    try {
      const cfg = await getProtocolConfig();
      return cfg.tracking_token || CONTRACT_ADDRESSES.TRACKING_TOKEN || null;
    } catch {
      return null;
    }
  }

  // ── Pair / pool data ───────────────────────────────────────────────────────

  /**
   * Returns the Soroswap XLM/USDC pair contract address via router_pair_for().
   * The pair contract also IS the LP token.
   */
  static async getPairAddress(): Promise<string | null> {
    try {
      const routerAddr  = await SoroswapService.getEffectiveRouterAddress();
      const { xlm, usdc } = await SoroswapService.getSwapTokenAddresses();
      const [server, acct] = tempAccount();
      const router = new StellarSdk.Contract(routerAddr);

      const sim = await simulateTx(server, acct,
        router.call(
          'router_pair_for',
          StellarSdk.nativeToScVal(xlm,  { type: 'address' }),
          StellarSdk.nativeToScVal(usdc, { type: 'address' }),
        ));

      if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
        return SOROSWAP_XLM_USDC_POOL || null;
      }
      return StellarSdk.scValToNative(sim.result.retval) as string;
    } catch {
      return SOROSWAP_XLM_USDC_POOL || null;
    }
  }

  /**
   * Returns reserves and total LP supply for a Soroswap pool. Defaults to the
   * XLM/USDC pool (via the hardcoded `getPairAddress()`) when no address is
   * given, for backward compatibility — any other Soroswap pool MUST pass its
   * own `pairAddress` (see `SOROSWAP_POOLS`), or this silently returns the
   * XLM/USDC pool's stats mislabeled as the requested one.
   * Pair contract: get_reserves() -> (i128, i128), token_0/token_1, total_supply().
   */
  static async getPoolStats(pairAddressOverride?: string): Promise<SoroswapPoolStats | null> {
    try {
      const pairAddress = pairAddressOverride ?? await SoroswapService.getPairAddress();
      if (!pairAddress) return null;

      const [server, acct] = tempAccount();
      const pair = new StellarSdk.Contract(pairAddress);

      const [token0Sim, resSim, supSim] = await Promise.all([
        simulateTx(server, acct, pair.call('token_0')),
        simulateTx(server, acct, pair.call('get_reserves')),
        simulateTx(server, acct, pair.call('total_supply')),
      ]);

      // Determine which reserve is XLM and which is USDC
      const { xlm } = await SoroswapService.getSwapTokenAddresses();
      let reserveXLMRaw = BigInt(0);
      let reserveUSDCRaw = BigInt(0);

      if (StellarSdk.rpc.Api.isSimulationSuccess(token0Sim) && token0Sim.result?.retval &&
          StellarSdk.rpc.Api.isSimulationSuccess(resSim) && resSim.result?.retval) {
        const token0 = StellarSdk.scValToNative(token0Sim.result.retval) as string;
        const [res0, res1] = StellarSdk.scValToNative(resSim.result.retval) as [bigint, bigint];
        if (token0 === xlm) {
          reserveXLMRaw  = res0;
          reserveUSDCRaw = res1;
        } else {
          reserveXLMRaw  = res1;
          reserveUSDCRaw = res0;
        }
      }

      let totalShares = '0';
      if (StellarSdk.rpc.Api.isSimulationSuccess(supSim) && supSim.result?.retval) {
        const raw = StellarSdk.scValToNative(supSim.result.retval) as bigint;
        totalShares = (Number(raw) / STROOP).toFixed(7);
      }

      return {
        reserveXLM:  (Number(reserveXLMRaw)  / STROOP).toFixed(7),
        reserveUSDC: (Number(reserveUSDCRaw) / STROOP).toFixed(7),
        totalShares,
        feeFraction: '0.30%',
        pairAddress,
      };
    } catch (err) {
      console.error('[SoroswapService] getPoolStats error:', err);
      return null;
    }
  }

  // ── LP position ────────────────────────────────────────────────────────────

  /**
   * Returns LP balance for a margin account via the Vanna tracking token.
   * Defaults to the XLM/USDC pool's tracking symbol/pair for backward
   * compatibility — any other pool MUST pass its own
   * `trackingSymbol`/`pairAddressOverride` (see `SOROSWAP_POOLS`), or this
   * silently checks the XLM/USDC pool's tracking balance instead.
   */
  static async getLpBalance(
    marginAccountAddress: string,
    trackingSymbol: string = LP_TRACKING_SYMBOL,
    pairAddressOverride?: string,
  ): Promise<string> {
    try {
      // Primary: tracking token from registry
      const trackingAddress = await SoroswapService.getTrackingTokenAddress();
      if (trackingAddress) {
        const [server, acct] = tempAccount();
        const tracking = new StellarSdk.Contract(trackingAddress);
        const sim = await simulateTx(server, acct,
          tracking.call(
            'balance',
            StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
            StellarSdk.nativeToScVal(trackingSymbol, { type: 'symbol' }),
          ));
        if (StellarSdk.rpc.Api.isSimulationSuccess(sim) && sim.result?.retval) {
          const raw = StellarSdk.scValToNative(sim.result.retval) as bigint;
          const lp  = Number(raw) / STROOP;
          if (lp > 0) return lp.toFixed(7);
        }
      }

      // Fallback: read LP token balance directly from the pair contract
      const pairAddress = pairAddressOverride ?? await SoroswapService.getPairAddress();
      if (!pairAddress) return '0';

      const [server, acct] = tempAccount();
      const pair = new StellarSdk.Contract(pairAddress);
      const sim = await simulateTx(server, acct,
        pair.call(
          'balance',
          StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
        ));

      if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) return '0';
      const raw = StellarSdk.scValToNative(sim.result.retval) as bigint;
      const lp  = Number(raw) / STROOP;
      return lp > 0 ? lp.toFixed(7) : '0';
    } catch {
      return '0';
    }
  }

  /** Returns the actual token balance held by a margin account. */
  static async getMarginAccountTokenBalance(
    marginAccountAddress: string,
    token: SoroswapSwapSymbol,
  ): Promise<string> {
    try {
      const tokenContract = await SoroswapService.getSwapTokenContract(token);
      const [server, acct] = tempAccount();
      const contract = new StellarSdk.Contract(tokenContract);
      const sim = await simulateTx(server, acct,
        contract.call(
          'balance',
          StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
        ));
      if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) return '0';
      const raw = StellarSdk.scValToNative(sim.result.retval) as bigint;
      return (Number(raw) / STROOP).toFixed(7);
    } catch {
      return '0';
    }
  }

  // ── Swap quote ─────────────────────────────────────────────────────────────

  /**
   * Get expected output amount for a swap via Soroswap router_get_amounts_out().
   * Returns human-readable amount (7 decimals), or null on error.
   */
  static async getSwapQuote(
    amountIn: number,
    tokenIn: SoroswapSwapSymbol,
    walletAddress: string,
    tokenOut?: SoroswapSwapSymbol,
  ): Promise<string | null> {
    try {
      const resolvedTokenOut = getSoroswapSwapPartner(tokenIn, tokenOut);
      if (!resolvedTokenOut) return null;
      const tokenInContract  = await SoroswapService.getSwapTokenContract(tokenIn);
      const tokenOutContract = await SoroswapService.getSwapTokenContract(resolvedTokenOut);
      const amountInStroops  = toStroop(amountIn);

      const routerAddr = await SoroswapService.getEffectiveRouterAddress();
      const server     = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(walletAddress);
      const router = new StellarSdk.Contract(routerAddr);

      const pathVec = StellarSdk.xdr.ScVal.scvVec([
        StellarSdk.nativeToScVal(tokenInContract,  { type: 'address' }),
        StellarSdk.nativeToScVal(tokenOutContract, { type: 'address' }),
      ]);

      const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: (parseInt(StellarSdk.BASE_FEE) * 20).toString(),
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          router.call(
            'router_get_amounts_out',
            StellarSdk.nativeToScVal(amountInStroops, { type: 'i128' }),
            pathVec,
          ))
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) return null;

      const amounts = StellarSdk.scValToNative(sim.result.retval) as bigint[];
      if (!Array.isArray(amounts) || amounts.length < 2) return null;

      const amountOut = Number(amounts[amounts.length - 1]) / STROOP;
      return amountOut > 0 ? amountOut.toFixed(7) : null;
    } catch (err) {
      console.error('[SoroswapService] getSwapQuote error:', err);
      return null;
    }
  }

  // ── Transaction polling ────────────────────────────────────────────────────

  private static async pollTransactionStatus(
    server: StellarSdk.rpc.Server,
    hash:   string,
  ): Promise<void> {
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      const tx = await server.getTransaction(hash);
      if (tx.status !== 'NOT_FOUND') {
        if (tx.status === 'SUCCESS') return;
        throw new Error(`Transaction failed: ${tx.status}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('Transaction timed out');
  }

  // ── Margin account operations (AccountManager.exec) ────────────────────────

  /**
   * Add liquidity to a Soroswap pool from the margin account. Defaults to
   * XLM/USDC for backward compatibility. Amounts are human-readable token units.
   * amounts_wad = [amountA_wad, amountB_wad, minA, minB] (M-02 per-leg mins).
   */
  static async addLiquidity(
    walletAddress:        string,
    marginAccountAddress: string,
    amountA:              number,
    amountB:              number,
    tokenA:               SoroswapSwapSymbol = 'XLM',
    tokenB:               SoroswapSwapSymbol = 'USDC',
  ): Promise<SoroswapTransactionResult> {
    try {
      if (!marginAccountAddress) return { success: false, error: 'Margin account required' };

      const routerAddress = await SoroswapService.getEffectiveRouterAddress();
      const tokens = [
        await SoroswapService.getSwapTokenContract(tokenA),
        await SoroswapService.getSwapTokenContract(tokenB),
      ];

      return await execViaAccountManager(
        walletAddress,
        marginAccountAddress,
        routerAddress,
        'AddLiquidity',
        tokens,
        [toWad(amountA), toWad(amountB), BigInt(0), BigInt(0)],
        BigInt(0),
        100,
      );
    } catch (err: any) {
      console.error('[SoroswapService] addLiquidity error:', err);
      return { success: false, error: err?.message || 'Add liquidity failed' };
    }
  }

  /**
   * Remove liquidity from a Soroswap pool. lpAmount is in LP token units
   * (7 decimals / stroops) — Soroswap controller expects raw LP units, not WAD.
   * amounts_wad = [lp_units, minA, minB].
   */
  static async removeLiquidity(
    walletAddress:        string,
    marginAccountAddress: string,
    lpAmount:             number,
    tokenA:               SoroswapSwapSymbol = 'XLM',
    tokenB:               SoroswapSwapSymbol = 'USDC',
  ): Promise<SoroswapTransactionResult> {
    try {
      const routerAddress = await SoroswapService.getEffectiveRouterAddress();
      const lpUnits = toStroop(lpAmount);
      const tokens = [
        await SoroswapService.getSwapTokenContract(tokenA),
        await SoroswapService.getSwapTokenContract(tokenB),
      ];

      return await execViaAccountManager(
        walletAddress,
        marginAccountAddress,
        routerAddress,
        'RemoveLiquidity',
        tokens,
        [lpUnits, BigInt(0), BigInt(0)],
        BigInt(0),
        50,
      );
    } catch (err: any) {
      console.error('[SoroswapService] removeLiquidity error:', err);
      return { success: false, error: err?.message || 'Remove liquidity failed' };
    }
  }

  /**
   * Swap XLM → USDC or USDC → XLM from the margin account via exec(Swap).
   */
  static async swapFromMargin(
    walletAddress:        string,
    marginAccountAddress: string,
    tokenIn:              SoroswapSwapSymbol,
    amountIn:             number,
    tokenOutParam?:       SoroswapSwapSymbol,
  ): Promise<SoroswapTransactionResult> {
    try {
      const routerAddress = await SoroswapService.getEffectiveRouterAddress();
      const tokenOut = getSoroswapSwapPartner(tokenIn, tokenOutParam);
      if (!tokenOut) {
        return { success: false, error: `No Soroswap pool for ${tokenIn}` };
      }

      const amountStroops = floorAmountToStroops(amountIn);
      if (amountStroops <= BigInt(0)) {
        return { success: false, error: 'Invalid swap amount' };
      }

      const tokens = [
        await SoroswapService.getSwapTokenContract(tokenIn),
        await SoroswapService.getSwapTokenContract(tokenOut),
      ];

      return await execViaAccountManager(
        walletAddress,
        marginAccountAddress,
        routerAddress,
        'Swap',
        tokens,
        [stroopsToWad(amountStroops)],
        BigInt(0),
        100,
      );
    } catch (err: any) {
      console.error('[SoroswapService] swapFromMargin error:', err);
      return { success: false, error: err?.message || 'Swap from margin failed' };
    }
  }

  /**
   * Direct wallet swap (not via margin account) — calls Soroswap router directly.
   * The user's Freighter wallet signs the transaction with token transfer auth.
   */
  static async swap(
    walletAddress: string,
    tokenIn:       SoroswapSwapSymbol,
    amountIn:      number,
    slippagePct    = 0.5,
    tokenOutParam?: SoroswapSwapSymbol,
  ): Promise<SoroswapTransactionResult> {
    try {
      const tokenOut = getSoroswapSwapPartner(tokenIn, tokenOutParam);
      if (!tokenOut) {
        return { success: false, error: `No Soroswap pool for ${tokenIn}` };
      }
      const tokenInContract  = await SoroswapService.getSwapTokenContract(tokenIn);
      const tokenOutContract = await SoroswapService.getSwapTokenContract(tokenOut);

      const amountInStroops = toStroop(amountIn);

      // Get quote to compute min_out with slippage
      const quote = await SoroswapService.getSwapQuote(amountIn, tokenIn, walletAddress, tokenOut);
      const minOut = quote
        ? toStroop(parseFloat(quote) * (1 - slippagePct / 100))
        : BigInt(1);

      const routerAddr    = await SoroswapService.getEffectiveRouterAddress();
      const server        = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(walletAddress);
      const router        = new StellarSdk.Contract(routerAddr);

      // deadline = now + 60s (in ledger seconds, approximate)
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 60);

      const pathVec = StellarSdk.xdr.ScVal.scvVec([
        StellarSdk.nativeToScVal(tokenInContract,  { type: 'address' }),
        StellarSdk.nativeToScVal(tokenOutContract, { type: 'address' }),
      ]);

      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: (parseInt(StellarSdk.BASE_FEE) * 100).toString(),
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          router.call(
            'swap_exact_tokens_for_tokens',
            StellarSdk.nativeToScVal(amountInStroops, { type: 'i128' }),
            StellarSdk.nativeToScVal(minOut,          { type: 'i128' }),
            pathVec,
            StellarSdk.nativeToScVal(walletAddress,   { type: 'address' }),
            StellarSdk.nativeToScVal(deadline,        { type: 'u64' }),
          ))
        .setTimeout(30)
        .build();

      const preparedTx  = await server.prepareTransaction(transaction);
      const signResult  = await signTransaction(preparedTx.toXDR(), { networkPassphrase: NETWORK_PASSPHRASE });
      const signedTx    = StellarSdk.TransactionBuilder.fromXDR(signResult.signedTxXdr, NETWORK_PASSPHRASE);
      const result      = await server.sendTransaction(signedTx as StellarSdk.Transaction);

      if (result.status === 'PENDING') {
        await SoroswapService.pollTransactionStatus(server, result.hash);
        return { success: true, hash: result.hash };
      }
      return { success: false, error: `Network rejected (status: ${result.status})` };
    } catch (err: any) {
      console.error('[SoroswapService] swap error:', err);
      return { success: false, error: err?.message || 'Swap failed' };
    }
  }
}
