import * as StellarSdk from '@stellar/stellar-sdk';
import { signTransaction } from '@stellar/freighter-api';
import {
  CONTRACT_ADDRESSES,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
} from './stellar-utils';

// ── Soroswap Testnet Constants ────────────────────────────────────────────────
const SOROSWAP_ROUTER = CONTRACT_ADDRESSES.SOROSWAP_ROUTER;
const SOROSWAP_XLM   = CONTRACT_ADDRESSES.SOROSWAP_XLM;
const SOROSWAP_USDC  = CONTRACT_ADDRESSES.SOROSWAP_USDC;
const SOROSWAP_XLM_USDC_POOL = CONTRACT_ADDRESSES.SOROSWAP_XLM_USDC_POOL;
const SOROSWAP_API   = 'https://api.soroswap.finance';
const LP_TRACKING_SYMBOL = 'SS_XLM_USDC'; // Registry tracking token symbol

const WAD = 1e18;
const STROOP = 1e7; // Stellar 7-decimal precision

const toWad  = (amount: number): bigint => BigInt(Math.floor(amount * WAD));
const toStroop = (amount: number): bigint => BigInt(Math.round(amount * STROOP));
const makeKey  = (name: string) => StellarSdk.xdr.ScVal.scvSymbol(name);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SoroswapLpEvent {
  type: 'deposit' | 'withdraw';
  shareAmount: string;  // LP shares (7 decimals)
  amountXLM: string;    // XLM contributed/withdrawn (7 decimals)
  amountUSDC: string;   // USDC contributed/withdrawn (7 decimals)
  timestamp: number;    // unix ms
  txHash: string;
  ledger: number;
}

export interface SoroswapPoolStats {
  reserveXLM:   string; // human-readable (7 decimals)
  reserveUSDC:  string;
  totalShares:  string;
  feeFraction:  string; // "0.30%"
  pairAddress:  string;
}

export interface SoroswapLpPosition {
  lpBalance: string; // LP shares held by margin account (7 decimals)
}

export interface SoroswapTransactionResult {
  success: boolean;
  hash?:   string;
  error?:  string;
}

export interface SoroswapPoolConfig {
  id:          string;
  tokens:      [string, string];
  displayName: string;
  feeFraction: number;
}

export const SOROSWAP_POOLS: SoroswapPoolConfig[] = [
  {
    id:          'soroswap-xlm-usdc',
    tokens:      ['XLM', 'USDC'],
    displayName: 'XLM / USDC',
    feeFraction: 30,
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

export class SoroswapService {

  // ── Registry helpers ───────────────────────────────────────────────────────

  /** Returns the Soroswap router address stored in Registry, or null if not set. */
  static async getRegistrySoroswapRouterAddress(): Promise<string | null> {
    try {
      const [server, acct] = tempAccount();
      const registry = new StellarSdk.Contract(CONTRACT_ADDRESSES.REGISTRY);

      const hasSim = await simulateTx(server, acct,
        registry.call('has_soroswap_router_address'));
      if (!StellarSdk.rpc.Api.isSimulationSuccess(hasSim) || !hasSim.result?.retval) return null;
      const has = StellarSdk.scValToNative(hasSim.result.retval);
      if (!has) return null;

      const getSim = await simulateTx(server, acct,
        registry.call('get_soroswap_router_address'));
      if (!StellarSdk.rpc.Api.isSimulationSuccess(getSim) || !getSim.result?.retval) return null;
      return (StellarSdk.scValToNative(getSim.result.retval) as string) ?? null;
    } catch {
      return null;
    }
  }

  /** Returns the Soroswap USDC address stored in Registry, or null if not set. */
  static async getRegistrySoroswapUsdcAddress(): Promise<string | null> {
    try {
      const [server, acct] = tempAccount();
      const registry = new StellarSdk.Contract(CONTRACT_ADDRESSES.REGISTRY);

      const hasSim = await simulateTx(server, acct,
        registry.call('has_soroswap_usdc_addr'));
      if (!StellarSdk.rpc.Api.isSimulationSuccess(hasSim) || !hasSim.result?.retval) return null;
      const has = StellarSdk.scValToNative(hasSim.result.retval);
      if (!has) return null;

      const getSim = await simulateTx(server, acct,
        registry.call('get_soroswap_usdc_addr'));
      if (!StellarSdk.rpc.Api.isSimulationSuccess(getSim) || !getSim.result?.retval) return null;
      return (StellarSdk.scValToNative(getSim.result.retval) as string) ?? null;
    } catch {
      return null;
    }
  }

  /** Returns the Soroswap router address (static protocol config). */
  static async getEffectiveRouterAddress(): Promise<string> {
    const router = await SoroswapService.getRegistrySoroswapRouterAddress();
    if (router) return router;
    return SOROSWAP_ROUTER;
  }

  /** Returns Soroswap XLM/USDC token addresses effective for current Registry config. */
  private static async getSwapTokenAddresses(): Promise<{ xlm: string; usdc: string }> {
    // Prefer the token pair actually configured on the live Soroswap pool.
    // This avoids UI/account balance mismatches when constants drift.
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

        if (token0 === SOROSWAP_XLM) return { xlm: SOROSWAP_XLM, usdc: token1 };
        if (token1 === SOROSWAP_XLM) return { xlm: SOROSWAP_XLM, usdc: token0 };
      }
    } catch {
      // fall through to registry/config fallback
    }

    const usdc = await SoroswapService.getRegistrySoroswapUsdcAddress();
    return {
      xlm: SOROSWAP_XLM,
      usdc: usdc || SOROSWAP_USDC,
    };
  }

  /** Returns the tracking token contract address from Registry, or null. */
  static async getTrackingTokenAddress(): Promise<string | null> {
    try {
      const [server, acct] = tempAccount();
      const registry = new StellarSdk.Contract(CONTRACT_ADDRESSES.REGISTRY);

      const hasSim = await simulateTx(server, acct,
        registry.call('has_tracking_token_contract_addr'));
      if (!StellarSdk.rpc.Api.isSimulationSuccess(hasSim) || !hasSim.result?.retval) return null;
      const has = StellarSdk.scValToNative(hasSim.result.retval);
      if (!has) return null;

      const getSim = await simulateTx(server, acct,
        registry.call('get_tracking_token_contract_addr'));
      if (!StellarSdk.rpc.Api.isSimulationSuccess(getSim) || !getSim.result?.retval) return null;
      return (StellarSdk.scValToNative(getSim.result.retval) as string) ?? null;
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
   * Returns reserves and total LP supply for the XLM/USDC Soroswap pool.
   * Pair contract: get_reserves() -> (i128, i128), token_0/token_1, total_supply().
   */
  static async getPoolStats(): Promise<SoroswapPoolStats | null> {
    try {
      const pairAddress = await SoroswapService.getPairAddress();
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
   * Returns LP balance for a margin account via the Vanna tracking token
   * (symbol = SS_XLM_USDC), falling back to direct LP token balance.
   */
  static async getLpBalance(marginAccountAddress: string): Promise<string> {
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
            StellarSdk.nativeToScVal(LP_TRACKING_SYMBOL, { type: 'symbol' }),
          ));
        if (StellarSdk.rpc.Api.isSimulationSuccess(sim) && sim.result?.retval) {
          const raw = StellarSdk.scValToNative(sim.result.retval) as bigint;
          const lp  = Number(raw) / STROOP;
          if (lp > 0) return lp.toFixed(7);
        }
      }

      // Fallback: read LP token balance directly from the pair contract
      const pairAddress = await SoroswapService.getPairAddress();
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

  /** Returns the actual XLM or USDC token balance held by a margin account. */
  static async getMarginAccountTokenBalance(
    marginAccountAddress: string,
    token: 'XLM' | 'USDC',
  ): Promise<string> {
    try {
      const { xlm, usdc } = await SoroswapService.getSwapTokenAddresses();
      const tokenContract = token === 'XLM' ? xlm : usdc;
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
    tokenIn: 'XLM' | 'USDC',
    walletAddress: string,
  ): Promise<string | null> {
    try {
      const { xlm, usdc } = await SoroswapService.getSwapTokenAddresses();
      const tokenInContract  = tokenIn === 'XLM' ? xlm : usdc;
      const tokenOutContract = tokenIn === 'XLM' ? usdc : xlm;
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

  // ── LP event history ──────────────────────────────────────────────────────

  /**
   * Fetch deposit / withdraw LP events from the Soroswap pair contract.
   * The pair emits (Symbol("deposit"|"withdraw"), depositor) with body (shares, amt0, amt1).
   */
  static async getSoroswapLpEvents(
    pairAddress?: string,
    userAddress?: string,
  ): Promise<SoroswapLpEvent[]> {
    try {
      const resolvedPair = pairAddress ?? SOROSWAP_XLM_USDC_POOL;
      if (!resolvedPair) return [];

      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const latest = await server.getLatestLedger();
      const startLedger = Math.max(0, latest.sequence - 518400); // ~30 days

      const depositTopic  = StellarSdk.xdr.ScVal.scvSymbol('deposit').toXDR('base64');
      const withdrawTopic = StellarSdk.xdr.ScVal.scvSymbol('withdraw').toXDR('base64');

      const safeGet = async (topic: string) => {
        try {
          const resp = await (server as any).getEvents({
            startLedger,
            filters: [{ type: 'contract', contractIds: [resolvedPair], topics: [[topic]] }],
            limit: 200,
          });
          if (resp?.error) return [];
          return resp?.events ?? [];
        } catch { return []; }
      };

      const [depositEvs, withdrawEvs] = await Promise.all([
        safeGet(depositTopic),
        safeGet(withdrawTopic),
      ]);

      const parseEv = (ev: any, type: 'deposit' | 'withdraw'): SoroswapLpEvent | null => {
        try {
          if (userAddress && Array.isArray(ev.topic)) {
            // Some deployments emit depositor/caller at different topic indexes.
            // Match against any decodable address topic instead of assuming topic[1].
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
          const body = ev.value ? (StellarSdk.scValToNative(ev.value) as any[]) : null;
          if (!Array.isArray(body) || body.length < 3) return null;
          const toHuman = (v: any) => (Number(v?.toString?.() ?? v ?? 0) / STROOP).toFixed(7);
          return {
            type,
            shareAmount: toHuman(body[0]),
            amountXLM:   toHuman(body[1]),
            amountUSDC:  toHuman(body[2]),
            timestamp: ev.ledgerClosedAt ? new Date(ev.ledgerClosedAt).getTime() : 0,
            txHash: ev.txHash ?? '',
            ledger: ev.ledger ?? 0,
          };
        } catch { return null; }
      };

      const all: SoroswapLpEvent[] = [
        ...depositEvs.map((ev: any) => parseEv(ev, 'deposit')),
        ...withdrawEvs.map((ev: any) => parseEv(ev, 'withdraw')),
      ].filter((e): e is SoroswapLpEvent => e !== null);

      return all.sort((a, b) => b.timestamp - a.timestamp);
    } catch (err: any) {
      console.warn('[SoroswapService] getSoroswapLpEvents error:', err?.message ?? err);
      return [];
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

  // ── XDR builder ───────────────────────────────────────────────────────────

  /**
   * Build ExternalProtocolCall XDR bytes for AccountManager.execute().
   * Matches the struct expected by SmartAccountContract.execute_soroswap().
   */
  private static buildExternalProtocolCallBytes(
    routerAddress:       string,
    action:              'AddLiquidity' | 'RemoveLiquidity' | 'Swap',
    tokensOut:           string[],        // symbol strings e.g. ['XLM','USDC']
    amountsOutWad:       bigint[],
    marginAccountAddress: string,
    isTokenPair:         boolean,
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
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('amount_in'),        val: amountIn }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('amount_out'),       val: amountOut }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('fee_fraction'),     val: StellarSdk.xdr.ScVal.scvU32(30) }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('is_token_pair'),    val: StellarSdk.xdr.ScVal.scvBool(isTokenPair) }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('margin_account'),   val: StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }) }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('min_liquidity_out'),val: StellarSdk.nativeToScVal(BigInt(0), { type: 'u256' }) }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('protocol_address'), val: StellarSdk.nativeToScVal(routerAddress, { type: 'address' }) }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('token_pair_ratio'), val: StellarSdk.xdr.ScVal.scvU64(StellarSdk.xdr.Uint64.fromString('0')) }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('tokens_in'),        val: tokensIn }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('tokens_out'),       val: tokensOutVal }),
      new StellarSdk.xdr.ScMapEntry({ key: makeKey('type_action'),      val: StellarSdk.xdr.ScVal.scvVec([StellarSdk.xdr.ScVal.scvSymbol(action)]) }),
    ]);

    return Buffer.from(scvMap.toXDR());
  }

  /** Execute a prepared call bytes via AccountManager.execute(). */
  private static async executeViaAccountManager(
    walletAddress:        string,
    marginAccountAddress: string,
    callBytes:            Buffer,
    feeMultiplier = 100,
  ): Promise<SoroswapTransactionResult> {
    const server        = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
    const sourceAccount = await server.getAccount(walletAddress);
    const accountManager = new StellarSdk.Contract(CONTRACT_ADDRESSES.ACCOUNT_MANAGER);

    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: (parseInt(StellarSdk.BASE_FEE) * feeMultiplier).toString(),
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        accountManager.call(
          'execute',
          StellarSdk.nativeToScVal(marginAccountAddress, { type: 'address' }),
          StellarSdk.xdr.ScVal.scvBytes(callBytes),
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
  }

  // ── Margin account operations ──────────────────────────────────────────────

  /**
   * Add liquidity to Soroswap XLM/USDC pool from the margin account.
   * Amounts are in human-readable token units (e.g. 100.5 XLM).
   */
  static async addLiquidity(
    walletAddress:        string,
    marginAccountAddress: string,
    amountXLM:            number,
    amountUSDC:           number,
  ): Promise<SoroswapTransactionResult> {
    try {
      if (!marginAccountAddress) return { success: false, error: 'Margin account required' };

      const routerAddress = await SoroswapService.getEffectiveRouterAddress();
      const callBytes = SoroswapService.buildExternalProtocolCallBytes(
        routerAddress,
        'AddLiquidity',
        ['XLM', 'USDC'],
        [toWad(amountXLM), toWad(amountUSDC)],
        marginAccountAddress,
        true,
      );

      return await SoroswapService.executeViaAccountManager(walletAddress, marginAccountAddress, callBytes, 100);
    } catch (err: any) {
      console.error('[SoroswapService] addLiquidity error:', err);
      return { success: false, error: err?.message || 'Add liquidity failed' };
    }
  }

  /**
   * Remove liquidity from the Soroswap XLM/USDC pool from the margin account.
   * lpAmount is in LP token units (7 decimals).
   */
  static async removeLiquidity(
    walletAddress:        string,
    marginAccountAddress: string,
    lpAmount:             number,
  ): Promise<SoroswapTransactionResult> {
    try {
      const routerAddress = await SoroswapService.getEffectiveRouterAddress();
      // LP amount is passed as raw units (7 decimals), not WAD — SmartAccount casts i128 directly
      const lpUnits = toStroop(lpAmount);

      const callBytes = SoroswapService.buildExternalProtocolCallBytes(
        routerAddress,
        'RemoveLiquidity',
        ['XLM', 'USDC'],
        [lpUnits],
        marginAccountAddress,
        true,
      );

      return await SoroswapService.executeViaAccountManager(walletAddress, marginAccountAddress, callBytes, 50);
    } catch (err: any) {
      console.error('[SoroswapService] removeLiquidity error:', err);
      return { success: false, error: err?.message || 'Remove liquidity failed' };
    }
  }

  /**
   * Swap XLM → USDC or USDC → XLM from the margin account.
   */
  static async swapFromMargin(
    walletAddress:        string,
    marginAccountAddress: string,
    tokenIn:              'XLM' | 'USDC',
    amountIn:             number,
  ): Promise<SoroswapTransactionResult> {
    try {
      const routerAddress = await SoroswapService.getEffectiveRouterAddress();
      const tokenOut: 'XLM' | 'USDC' = tokenIn === 'XLM' ? 'USDC' : 'XLM';

      const callBytes = SoroswapService.buildExternalProtocolCallBytes(
        routerAddress,
        'Swap',
        [tokenIn, tokenOut],
        [toWad(amountIn), BigInt(0)], // amount_out[0] = amountIn WAD, [1] = min_out
        marginAccountAddress,
        false,
      );

      return await SoroswapService.executeViaAccountManager(walletAddress, marginAccountAddress, callBytes, 100);
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
    tokenIn:       'XLM' | 'USDC',
    amountIn:      number,
    slippagePct    = 0.5,
  ): Promise<SoroswapTransactionResult> {
    try {
      const { xlm, usdc } = await SoroswapService.getSwapTokenAddresses();
      const tokenInContract  = tokenIn === 'XLM' ? xlm : usdc;
      const tokenOutContract = tokenIn === 'XLM' ? usdc : xlm;

      const amountInStroops = toStroop(amountIn);

      // Get quote to compute min_out with slippage
      const quote = await SoroswapService.getSwapQuote(amountIn, tokenIn, walletAddress);
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
