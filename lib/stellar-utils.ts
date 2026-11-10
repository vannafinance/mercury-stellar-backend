import { requestAccess, getAddress, signTransaction } from '@/lib/wallet-adapter';
import * as StellarSdk from '@stellar/stellar-sdk';
import { RETRY, withRetry } from '@/lib/copilot/retry-policy';
import { markTxSubmitted } from './tx-progress';
import { CREDIT_LAYER_ADDRESSES, ReserveCalls, marginOf, sc, simulateRead, stroopsToWad, toCreditAsset } from './credit-layer';

export const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
// Gateway.fm public testnet RPC. SDF's soroban-testnet.stellar.org started
// spiking to 5-10s per simulateTransaction (2026-11-08/09, measured), which
// made every margin snapshot hit its 12s deadline (UI showed $0 / "No debt").
// Gateway.fm answered the same calls in ~0.2s with the same 7-day event
// retention. Override with NEXT_PUBLIC_SOROBAN_RPC_URL if this one degrades.
export const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || 'https://soroban-rpc.testnet.stellar.gateway.fm';

/**
 * Gateway.fm (like most fast public RPCs) answers bursts of ~40 parallel
 * requests with HTTP 429. The analytics scan and the margin snapshot fan out
 * that wide, and every caller treats a failed read as "no data" ($0 / no
 * debt). Rather than touch every `new rpc.Server(...)` call site, retry 429s
 * once here on the shared prototype, with jittered exponential backoff.
 * Every app file that builds an rpc.Server imports SOROBAN_RPC_URL from this
 * module, so the patch is always installed first. Resubmitting the same
 * signed envelope on a 429 is safe: the network dedupes it (DUPLICATE).
 */
function isRateLimited(err: any): boolean {
  const status = err?.response?.status ?? err?.status;
  return status === 429 || /\b429\b|too many requests/i.test(String(err?.message ?? ''));
}

/**
 * Extra read-only RPCs for SERVER-SIDE reads (API routes: analytics scan,
 * account snapshot). Each public RPC rate-limits on its own, so spreading
 * `simulateTransaction` / ledger-entry reads round-robin over the primary
 * plus these roughly multiplies read throughput — the full analytics scan
 * (~9k reads) has to fit in Cloud Run's 300s request timeout. Browser code
 * (which simulates, signs and sends the user's own transactions) always stays
 * on the primary, so a tx is never simulated on one node and sent to another.
 * Comma-separated override: SOROBAN_EXTRA_READ_RPC_URLS ("" disables).
 */
const EXTRA_READ_RPC_URLS: string[] = (
  process.env.SOROBAN_EXTRA_READ_RPC_URLS ?? 'https://rpc.ankr.com/stellar_testnet_soroban'
)
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);
const READ_SPREAD_METHODS = new Set(['simulateTransaction', '_getLedgerEntries']);

const RPC_RETRY_PATCHED = Symbol.for('vanna.rpc429RetryPatched');
// Optional chaining: unit tests mock @stellar/stellar-sdk without rpc.Server.
const rpcProto = (StellarSdk as any)?.rpc?.Server?.prototype;
if (rpcProto && !rpcProto[RPC_RETRY_PATCHED]) {
  rpcProto[RPC_RETRY_PATCHED] = true;
  const serverSide = typeof window === 'undefined';
  let extraServers: unknown[] | null = null;
  let rotation = 0;
  /** Server to run a read on: the caller's own, or (server-side, primary URL only) the next in rotation. */
  const pickReadTarget = (self: any): unknown => {
    if (!serverSide || EXTRA_READ_RPC_URLS.length === 0) return self;
    if (String(self?.serverURL ?? '').replace(/\/$/, '') !== SOROBAN_RPC_URL.replace(/\/$/, '')) return self;
    extraServers ??= EXTRA_READ_RPC_URLS.map((url) => new StellarSdk.rpc.Server(url));
    const pool = [self, ...extraServers];
    rotation = (rotation + 1) % pool.length;
    return pool[rotation];
  };
  for (const method of [
    'simulateTransaction',
    // Internal transport behind getLedgerEntries / getLedgerEntry /
    // getAccount / getContractData — patching it covers all of them.
    '_getLedgerEntries',
    'getEvents',
    'getTransaction',
    'getLatestLedger',
    'getNetwork',
    'getHealth',
    'sendTransaction',
  ]) {
    const original = rpcProto[method];
    if (typeof original !== 'function') continue;
    rpcProto[method] = async function patched(this: unknown, ...args: unknown[]) {
      for (let attempt = 0; ; attempt++) {
        const target = READ_SPREAD_METHODS.has(method) ? pickReadTarget(this) : this;
        try {
          return await original.apply(target, args);
        } catch (err) {
          // An extra read RPC that errors for any other reason: answer from the primary.
          if (target !== this && !isRateLimited(err)) return original.apply(this, args);
          if (!isRateLimited(err) || attempt >= 5) throw err;
          const delay = 250 * 2 ** attempt + Math.floor(Math.random() * 250);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    };
  }
}
export const HORIZON_URL = 'https://horizon-testnet.stellar.org';

// Credit-layer redeploy 2026-11-06 (Protocol_V1_Soroban_testnet branch
// `testnet-credit-layer`, deploy/testnet.json). The old AccountManager,
// Registry, RiskEngine, RateModel, lending pools + vTokens, SmartAccount,
// Controllers and TrackingToken are retired. Their replacements:
//   CreditLayer  - margin accounts, collateral, borrow/repay, venue calls
//   Reserve x4   - one lending reserve per asset; it is also the share token
//                  (so the LENDING_PROTOCOL_* and V*_TOKEN keys both point at it)
//   Oracle       - Reflector-backed USD prices (WAD), LP + Blend valuation
//   ValidatorFacade + per-venue validators - build the venue calls
// See lib/credit-layer.ts for the client.
export const CONTRACT_ADDRESSES = {
  CREDIT_LAYER: CREDIT_LAYER_ADDRESSES.CREDIT_LAYER,
  ORACLE: CREDIT_LAYER_ADDRESSES.ORACLE,
  VALIDATOR_FACADE: CREDIT_LAYER_ADDRESSES.VALIDATOR_FACADE,
  BLEND_VALUER: CREDIT_LAYER_ADDRESSES.BLEND_VALUER,
  REFLECTOR: CREDIT_LAYER_ADDRESSES.REFLECTOR,

  // Reserve share tokens (the old vToken role), one per reserve
  VXLM_TOKEN: CREDIT_LAYER_ADDRESSES.RESERVE_XLM,
  VBLEND_USDC_TOKEN: CREDIT_LAYER_ADDRESSES.RESERVE_BLUSDC,
  VSOROSWAP_USDC_TOKEN: CREDIT_LAYER_ADDRESSES.RESERVE_SOUSDC,
  // Back-compat alias used by earn constants
  VUSDC_TOKEN: CREDIT_LAYER_ADDRESSES.RESERVE_BLUSDC,

  // Lending reserves — XLM + per-USDC-variant
  LENDING_PROTOCOL_XLM: CREDIT_LAYER_ADDRESSES.RESERVE_XLM,
  LENDING_PROTOCOL_BLEND_USDC: CREDIT_LAYER_ADDRESSES.RESERVE_BLUSDC,
  LENDING_PROTOCOL_SOROSWAP_USDC: CREDIT_LAYER_ADDRESSES.RESERVE_SOUSDC,
  // Back-compat alias for call sites still keyed on a single "USDC" pool —
  // resolves to the Blend USDC reserve specifically, not a shared canonical one.
  LENDING_PROTOCOL_USDC: CREDIT_LAYER_ADDRESSES.RESERVE_BLUSDC,

  // Three genuinely distinct USDC test tokens — one per DEX's own real pool.
  BLEND_USDC_TOKEN: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',
  // Aquarius moved to BLUSDC (mainnet-credit-layer, 2026-11-07): the old Aquarius
  // test USDC (CAZRY5GS…) lost its issuer account and can't take new holders.
  AQUARIUS_USDC_TOKEN: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',
  SOROSWAP_USDC_TOKEN: 'CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F',
  // Back-compat alias for old single-USDC call sites — resolves to Blend's own token.
  USDC_TOKEN: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',

  // Blend Capital (testnet, external, unchanged)
  BLEND_POOL: 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF',
  BLEND_XLM: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  BLEND_USDC: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',

  // Aquarius AMM (testnet, external). The credit layer's Aquarius validator
  // accepts only this constant_product XLM/BLUSDC pool (0.3%, index below).
  AQUARIUS_ROUTER: 'CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD',
  AQUARIUS_XLM_USDC_POOL: 'CBXVVJ5BOTUVRPXUY54LXFILWC4ZTJWRP2GIVHBMOEAOPHSLGHBG3NNP',
  AQUARIUS_USDC: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',
  AQUARIUS_POOL_INDEX_HEX: '9ac7a9cde23ac2ada11105eeaa42e43c2ea8332ca0aa8f41f58d7160274d718e',
  /** Share (LP) token of AQUARIUS_XLM_USDC_POOL; the margin account holds it directly. */
  AQUARIUS_XLM_USDC_SHARE: CREDIT_LAYER_ADDRESSES.AQUARIUS_SHARE,
  AQUARIUS_XLM_USDT_POOL: 'CA6DAGOMK5D7GKBNWVCIEAYSTPJXLQUFWFKSZOMNEM6BVOTUBDCTIT5I',

  // Soroswap DEX (testnet, external). XLM/SoUSDC pair auto-created live by
  // the router's own add_liquidity (Soroswap creates pairs on demand).
  SOROSWAP_ROUTER: 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD',
  SOROSWAP_XLM: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  SOROSWAP_USDC: 'CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F',
  SOROSWAP_XLM_USDC_POOL: 'CDVAIOYHCD4RUSLQNVFI7RIZBFT2JZMJWM4RTOLQZQXL4QAVXU5RFKDB',
} as const;

export const ASSET_TYPES = {
  XLM: 'XLM',
  // Back-compat alias for old single-USDC call sites — resolves to Blend's own pool/token.
  USDC: 'USDC',
  BLEND_USDC: 'BLEND_USDC',
  AQUARIUS_USDC: 'AQUARIUS_USDC',
  SOROSWAP_USDC: 'SOROSWAP_USDC',
} as const;

// Classic-side issuers (for trustline / Horizon balance checks).
// Blend USDC (BLUSDC, SAC CAQCFVLO…) is the classic asset USDC:GATALTGT….
// Aquarius trades BLUSDC since mainnet-credit-layer, so USDC_AQUARIUS is the
// same issuer; the old Aquarius test USDC issuer (GAHPYWLK…) no longer exists.
export const ASSET_ISSUERS = {
  USDC_BLEND: 'GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56',
  USDC_AQUARIUS: 'GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56',
} as const;

export type AssetType = typeof ASSET_TYPES[keyof typeof ASSET_TYPES];

/** Lending-pool contract for an earn asset type. */
export function lendingPoolAddress(assetType: AssetType): string {
  switch (assetType) {
    case ASSET_TYPES.XLM: return CONTRACT_ADDRESSES.LENDING_PROTOCOL_XLM;
    case ASSET_TYPES.USDC:
    case ASSET_TYPES.BLEND_USDC: return CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC;
    // No AQUSDC reserve since mainnet-credit-layer; Aquarius's USDC is BLUSDC.
    case ASSET_TYPES.AQUARIUS_USDC: return CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC;
    case ASSET_TYPES.SOROSWAP_USDC: return CONTRACT_ADDRESSES.LENDING_PROTOCOL_SOROSWAP_USDC;
    default: throw new Error(`Unsupported asset type: ${assetType}`);
  }
}

/** vToken receipt contract for an earn asset type. */
export function vTokenAddress(assetType: AssetType): string {
  switch (assetType) {
    case ASSET_TYPES.XLM: return CONTRACT_ADDRESSES.VXLM_TOKEN;
    case ASSET_TYPES.USDC:
    case ASSET_TYPES.BLEND_USDC: return CONTRACT_ADDRESSES.VBLEND_USDC_TOKEN;
    case ASSET_TYPES.AQUARIUS_USDC: return CONTRACT_ADDRESSES.VBLEND_USDC_TOKEN;
    case ASSET_TYPES.SOROSWAP_USDC: return CONTRACT_ADDRESSES.VSOROSWAP_USDC_TOKEN;
    default: throw new Error(`Unsupported asset type: ${assetType}`);
  }
}

// ─── Shared same-account back-to-back tx resilience ─────────────────────────
//
// Any two Soroban transactions submitted from the SAME wallet account back
// to back (e.g. one-click's deposit → borrow → deploy chain) race the same
// class of failure: the second tx's `getAccount()` call can read a stale
// sequence number from an RPC endpoint that hasn't caught up with the first
// tx yet. This surfaces as `txBadSeq` (submission-time rejection, no
// operations even run) or, less often, the RPC's submission queue declining
// the attempt outright (`TRY_AGAIN_LATER`). Neither means the transaction
// was invalid — both self-heal on a proper retry. Originally solved ad hoc
// inside MarginAccountService.borrowTokensAttempt; hoisted here once
// BlendService's depositToBlendPool/withdrawFromBlendPool needed the exact
// same handling and duplicating it a second time stopped being reasonable.

/**
 * Whether a transaction failure looks like the same-account race documented
 * above — a stale sequence number (`txBadSeq`), a stale simulation
 * footprint (`scecExceededLimit`/"outside of the footprint"), or an RPC
 * submission queue that declined the attempt (`TRY_AGAIN_LATER`). All three
 * self-heal on a fresh rebuild+resubmit; none of them mean the transaction
 * itself was invalid.
 */
export function isFootprintRaceError(raw: any): boolean {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
  return (
    text.includes('outside of the footprint') ||
    text.includes('exceeded_limit') ||
    /budget|exceededlimit|resource|try_again_later|txbadseq|txsorobaninvalid|txtoolate/i.test(text)
  );
}

/**
 * Decodes a `sendTransaction` submission-time rejection (`result.status ===
 * 'ERROR'`) into its real `TransactionResult` code, e.g. `txBadSeq`, instead
 * of the raw XDR bytes `result.errorResult.toXDR()` would otherwise dump —
 * `toXDR()` with no argument returns a Buffer, and string-interpolating it
 * just calls the Buffer's garbled default `toString()`, which never matches
 * {@link isFootprintRaceError}'s text patterns.
 */
export function describeSendError(result: any): string {
  try {
    const code = result?.errorResult?.result?.().switch?.().name;
    if (code) return code;
  } catch {
    // Fall through to the generic message below.
  }
  return 'unknown';
}

/**
 * Resubmits the SAME signed transaction (no rebuild) when the RPC's
 * submission queue returns `TRY_AGAIN_LATER` — that status means the queue
 * declined the attempt without judging the tx itself, so resubmitting the
 * identical signed envelope (not rebuilding with a fresh sequence) is the
 * correct recovery.
 */
export async function resubmitOnTryAgainLater(
  server: StellarSdk.rpc.Server,
  signedTx: StellarSdk.Transaction,
  initialResult: any,
  label: string,
  maxAttempts = 3,
  delayMs = 1500,
): Promise<any> {
  let result = initialResult;
  for (let attempt = 0; result.status === 'TRY_AGAIN_LATER' && attempt < maxAttempts; attempt++) {
    console.warn(`⚠️ ${label} submission returned TRY_AGAIN_LATER; resubmitting (attempt ${attempt + 1}/${maxAttempts}).`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    result = await server.sendTransaction(signedTx);
  }
  return result;
}

/**
 * Decodes a failed `getTransaction` result's diagnostic events into a
 * human-readable string (e.g. `scecExceededLimit: operation byte-write
 * resources exceeds amount specified (1920, 1880)`, or a contract's own
 * `error` event). The resource footprint `prepareTransaction` computes from
 * simulation can go stale by the time the signed tx actually executes, and a
 * bare `status: 'FAILED'` gives no way to tell that apart from a genuine
 * business-logic rejection — callers need this decoded text to both surface
 * a real reason to the user and to feed {@link isFootprintRaceError} for a
 * retry decision.
 */
export function describeFailedTx(finalResult: any): string {
  try {
    const events: any[] = finalResult?.diagnosticEventsXdr ?? [];
    const reasons: string[] = [];
    for (const ev of events) {
      try {
        const body = ev.event().body().v0();
        const topics = body.topics().map((t: any) => StellarSdk.scValToNative(t));
        if (!topics.includes('error')) continue;
        const data = StellarSdk.scValToNative(body.data());
        const errorCode = topics.find((t: any) => typeof t === 'object' && t?.value)?.value;
        reasons.push([errorCode, ...(Array.isArray(data) ? data : [data])].filter(Boolean).join(': '));
      } catch {
        // Skip events that don't decode as a v0 diagnostic event.
      }
    }
    return reasons.join('; ');
  } catch {
    return '';
  }
}

/**
 * Runs `attempt` once, then retries with growing backoff (2s, 4s) whenever
 * the failure looks like {@link isFootprintRaceError} — a stale RPC read
 * that a full rebuild-from-scratch (calling `attempt` again re-fetches
 * `getAccount()` fresh) can outlast. A single retry wasn't always enough
 * against a multi-node RPC endpoint — confirmed live still hitting the same
 * error on the first retry too — so this allows up to 3 total tries.
 */
export async function withFootprintRaceRetry<T extends { success: boolean; error?: string }>(
  attempt: () => Promise<T>,
  label: string,
): Promise<T> {
  const RETRY_DELAYS_MS = [2000, 4000];
  let result = await attempt();

  for (let i = 0; i < RETRY_DELAYS_MS.length && !result.success && isFootprintRaceError(result.error); i++) {
    console.warn(`⚠️ ${label} hit a footprint/ledger-lag race; retrying after a short delay (attempt ${i + 2}/${RETRY_DELAYS_MS.length + 1}).`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[i]));
    result = await attempt();
  }

  return result;
}

export class WalletService {
  static async connectWallet(): Promise<{ address: string; success: boolean; error?: string }> {
    try {
      const accessGranted = await requestAccess();
      if (!accessGranted) {
        return { address: '', success: false, error: 'Please approve the connection in Freighter' };
      }
      
      const result = await getAddress();
      if (result.error) {
        const message = typeof result.error === 'string' ? result.error : result.error.message;
        return { address: '', success: false, error: message || 'Failed to connect wallet' };
      }
      
      if (!result.address) {
        return { address: '', success: false, error: 'Wallet is locked. Please unlock Freighter' };
      }
      
      return { address: result.address, success: true };
    } catch (error: any) {
      return { address: '', success: false, error: error?.message || 'Failed to connect wallet' };
    }
  }

  static async checkConnection(): Promise<{ address: string; connected: boolean }> {
    try {
      const result = await getAddress();
      if (result.address && !result.error) {
        return { address: result.address, connected: true };
      }
      return { address: '', connected: false };
    } catch (error) {
      return { address: '', connected: false };
    }
  }

  static async getBalance(address: string): Promise<string> {
    try {
      const server = new StellarSdk.Horizon.Server(HORIZON_URL);
      const account = await withRetry(RETRY.rpcRead, () => server.loadAccount(address));
      
      const xlmBalance = account.balances.find(
        (balance: any) => balance.asset_type === 'native'
      );
      
      return xlmBalance ? parseFloat(xlmBalance.balance).toFixed(7) : '0';
    } catch (error: any) {
      if (error?.response?.status === 404) {
        return '0 (Not funded)';
      }
      return 'Error';
    }
  }
}

export class ContractService {
  private static tokenDecimalsCache: Record<string, number> = {};

  private static async getTokenDecimals(tokenContract: string): Promise<number> {
    if (typeof this.tokenDecimalsCache[tokenContract] === 'number') {
      return this.tokenDecimalsCache[tokenContract];
    }

    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      const token = new StellarSdk.Contract(tokenContract);

      const tx = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(token.call('decimals'))
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (StellarSdk.rpc.Api.isSimulationSuccess(sim) && sim.result?.retval) {
        const decimalsNative = StellarSdk.scValToNative(sim.result.retval);
        const decimals = Number(decimalsNative);
        if (Number.isFinite(decimals) && decimals >= 0) {
          this.tokenDecimalsCache[tokenContract] = decimals;
          return decimals;
        }
      }
    } catch (error) {
      console.warn(`[getTokenDecimals] Falling back to 7 for ${tokenContract}:`, error);
    }

    this.tokenDecimalsCache[tokenContract] = 7;
    return 7;
  }

  static async getSorobanTokenWalletBalance(
    tokenContract: string,
    walletAddress: string,
    sourceUserAddress?: string,
    options?: { sourceSequence?: string; decimals?: number; throwOnError?: boolean },
  ): Promise<string> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAddress = sourceUserAddress ?? walletAddress;
      const sourceAccount = options?.sourceSequence !== undefined
        ? new StellarSdk.Account(sourceAddress, options.sourceSequence)
        : await server.getAccount(sourceAddress);
      const token = new StellarSdk.Contract(tokenContract);

      const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          token.call(
            'balance',
            StellarSdk.nativeToScVal(walletAddress, { type: 'address' })
          )
        )
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
        throw new Error(`Token balance simulation failed for ${tokenContract}`);
      }

      const raw = StellarSdk.scValToNative(sim.result.retval) as bigint;
      const decimals = options?.decimals ?? await this.getTokenDecimals(tokenContract);
      return (Number(raw) / 10 ** decimals).toFixed(7);
    } catch (error) {
      throw error;
    }
  }

  /**
   * Supply `amount` of the underlying into the asset's credit-layer Reserve
   * (`reserve.supply(lender, amount_wad)`, was `pool.deposit(lender, wad)`).
   * The reserve mints share tokens (the old vToken role) to the lender.
   * Signed by the connected wallet (Freighter / Privy) via `invokeWrite`, which
   * also waits for SUCCESS and retries a stale-sequence / footprint race.
   *
   * @param walletAddress - Lender G-address (must be the connected wallet).
   * @param amount - Human amount of the underlying asset.
   * @param assetType - Target reserve (default XLM).
   * @returns `{ success, hash?, error? }`.
   */
  static async deposit(
    walletAddress: string,
    amount: number,
    assetType: AssetType = ASSET_TYPES.XLM
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
    try {
      // Raw `amount * 1e18` float multiplication loses precision once the
      // product needs more significant digits than a JS double can hold, most
      // likely to bite on a 100%-of-balance supply with many decimal digits.
      // Splitting through a 7-decimal (stroop-precision) integer step keeps it exact.
      const amountWAD = humanToWad(amount);
      if (amountWAD <= BigInt(0)) return { success: false, error: 'Please enter a valid amount' };
      const r = await ReserveCalls.supply(walletAddress, creditSymbol(assetType), amountWAD);
      return { success: r.success, hash: r.hash, error: r.success ? undefined : r.error || 'Deposit failed' };
    } catch (error: any) {
      console.error('Deposit error:', error);
      return { success: false, error: error?.message || 'Deposit failed' };
    }
  }

  /**
   * Withdraw from a Reserve by redeeming share tokens
   * (`reserve.redeem(lender, shares_wad)`, was `pool.redeem_vtokens`).
   *
   * `amount` is in SHARE (vToken) units — the same unit the Earn UI shows as
   * "vXLM" balance and caps the input with, unchanged from the old vToken
   * flow. It is capped at the lender's live share balance, and an amount at
   * (or within one stroop of) the full balance redeems the whole balance, so a
   * 100% withdrawal never leaves dust or overshoots. The reserve pays out the
   * underlying at its current exchange rate (capped by available cash).
   *
   * @param walletAddress - Redeemer's G-address (must be the connected wallet).
   * @param amount - Share amount (human, 7 decimals).
   * @param assetType - Target reserve (default XLM).
   * @returns `{ success, hash?, error? }`.
   */
  static async withdraw(
    walletAddress: string,
    amount: number,
    assetType: AssetType = ASSET_TYPES.XLM
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
    try {
      const symbol = creditSymbol(assetType);
      const balance = BigInt(await simulateRead<bigint>(lendingPoolAddress(assetType), 'balance', [sc.address(walletAddress)]));
      if (balance <= BigInt(0)) return { success: false, error: 'No supplied balance to withdraw' };
      // Same stroop-precision integer step as deposit (see the comment there):
      // a float `amount * 1e18` once produced 14336 units MORE than the real
      // 100% balance, which the old pool trapped on.
      let shares = BigInt(Math.floor(amount * 1e7 + 1e-6));
      if (shares <= BigInt(0)) return { success: false, error: 'Please enter a valid amount' };
      if (shares >= balance - BigInt(1)) shares = balance; // max / rounding → redeem everything
      const r = await ReserveCalls.redeem(walletAddress, symbol, stroopsToWad(shares));
      return { success: r.success, hash: r.hash, error: r.success ? undefined : r.error || 'Withdraw failed' };
    } catch (error: any) {
      console.error('Withdraw error:', error);
      return { success: false, error: error?.message || 'Withdraw failed' };
    }
  }

  /**
   * The holder's supplied position in a Reserve, in UNDERLYING units:
   * `shares × total_assets / total_supply` (the reserve's exchange rate,
   * interest included). Use {@link getShareBalance} for the raw share
   * (vToken) count.
   *
   * @param address - Lender G-address.
   * @param assetType - Which reserve (default XLM).
   * @returns Underlying amount fixed to 7 decimals, `'0'` when empty, or
   *          `'Error'` when the read failed.
   */
  static async getDepositedBalance(
    address: string,
    assetType: AssetType = ASSET_TYPES.XLM
  ): Promise<string> {
    try {
      const reserve = lendingPoolAddress(assetType);
      const [shares, totalAssets, totalSupply] = await Promise.all([
        simulateRead<bigint>(reserve, 'balance', [sc.address(address)]),
        simulateRead<bigint>(reserve, 'total_assets'),
        simulateRead<bigint>(reserve, 'total_supply'),
      ]);
      const s = BigInt(shares ?? 0);
      const supply = BigInt(totalSupply ?? 0);
      if (s === BigInt(0) || supply === BigInt(0)) return '0.0000000';
      return wadToFixed7((s * BigInt(totalAssets ?? 0)) / supply);
    } catch (error: any) {
      console.error(`[getDepositedBalance] Error fetching deposited balance for ${assetType}:`, error);
      return 'Error';
    }
  }

  /**
   * The holder's Reserve share (vToken) balance — the unit `withdraw` takes.
   *
   * @returns Shares fixed to 7 decimals, `'0'` when empty, `'Error'` on failure.
   */
  static async getShareBalance(
    address: string,
    assetType: AssetType = ASSET_TYPES.XLM
  ): Promise<string> {
    try {
      const shares = BigInt(
        (await simulateRead<bigint>(lendingPoolAddress(assetType), 'balance', [sc.address(address)])) ?? 0,
      );
      return (Number(shares) / 1e7).toFixed(7);
    } catch (error: any) {
      console.error(`[getShareBalance] Error fetching share balance for ${assetType}:`, error);
      return 'Error';
    }
  }

  /**
   * Poll a submitted transaction until it leaves NOT_FOUND, retrying every 2s up
   * to 30 times (~60s). Soroban submission is async, so this is how callers wait
   * for finality after `sendTransaction`.
   *
   * @param server - Soroban RPC server to poll.
   * @param hash - Transaction hash returned by `sendTransaction`.
   * @returns Resolves once the tx is SUCCESS.
   * @throws If the tx reports a failed status, or if it never resolves within
   *         the attempt budget ("Transaction timeout").
   */
  static async pollTransactionStatus(server: StellarSdk.rpc.Server, hash: string): Promise<void> {
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      try {
        const transaction = await server.getTransaction(hash);
        if (transaction.status !== 'NOT_FOUND') {
          if (transaction.status === 'SUCCESS') {
            return;
          } else {
            const detail = describeFailedTx(transaction);
            throw new Error(
              detail
                ? `Transaction failed: ${detail} (Tx: ${hash})`
                : `Transaction failed (Tx: ${hash})`,
            );
          }
        }
      } catch (error: any) {
        if (error?.message?.includes('Transaction failed')) {
          throw error;
        }
        // Continue polling
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      attempts++;
    }
    
    throw new Error('Transaction timeout');
  }


  /** Per-reserve interest curve cache (`reserve.interest_curve()`), 10 min. */
  private static curveCache: Record<string, { c1: bigint; c2: bigint; c3: bigint; ts: number }> = {};

  /**
   * Per-second borrow rate, WAD-scaled (1e18 == 100%), from the credit-layer
   * Reserve (the old RateModelContract is gone; each Reserve carries its own
   * interest curve).
   *
   * - `getBorrowRatePerSecWad(assetType)` — the reserve's LIVE rate via
   *   `reserve.borrow_rate_per_sec()` (what the reserve accrues with now).
   * - `getBorrowRatePerSecWad(liquidityWad, borrowsWad, assetType?)` — the
   *   rate the reserve's curve gives at a hypothetical cash/debt split (used
   *   to draw rate curves). Reads `reserve.interest_curve()` once and applies
   *   the contract's exact integer math (reserve/src/interest.rs) locally.
   *
   * @returns The per-second rate as a bigint; `null` on error.
   */
  static getBorrowRatePerSecWad(assetType: AssetType): Promise<bigint | null>;
  static getBorrowRatePerSecWad(liquidityWad: bigint, borrowsWad: bigint, assetType?: AssetType): Promise<bigint | null>;
  static async getBorrowRatePerSecWad(
    assetOrLiquidity: AssetType | bigint,
    borrowsWad?: bigint,
    curveAsset: AssetType = ASSET_TYPES.XLM,
  ): Promise<bigint | null> {
    try {
      if (typeof assetOrLiquidity !== 'bigint') {
        const r = await simulateRead<bigint>(lendingPoolAddress(assetOrLiquidity), 'borrow_rate_per_sec');
        return BigInt(r ?? 0);
      }
      const curve = await this.getInterestCurve(curveAsset);
      return borrowRateFromCurve(curve, assetOrLiquidity, borrowsWad ?? BigInt(0));
    } catch (error: any) {
      console.error('Error fetching borrow rate per sec:', error);
      return null;
    }
  }

  private static async getInterestCurve(assetType: AssetType): Promise<{ c1: bigint; c2: bigint; c3: bigint }> {
    const reserve = lendingPoolAddress(assetType);
    const hit = this.curveCache[reserve];
    if (hit && Date.now() - hit.ts < 10 * 60_000) return hit;
    const raw = await simulateRead<{ c1: bigint; c2: bigint; c3: bigint }>(reserve, 'interest_curve');
    const curve = { c1: BigInt(raw.c1), c2: BigInt(raw.c2), c3: BigInt(raw.c3), ts: Date.now() };
    this.curveCache[reserve] = curve;
    return curve;
  }

  /**
   * A reserve's available cash (un-borrowed liquidity): `total_assets −
   * total_debt` (both WAD), as a decimal string.
   *
   * @param assetType - Reserve to query (default XLM).
   * @returns Liquidity fixed to 7 decimals; `'0'` on error.
   */
  static async getPoolLiquidity(assetType: AssetType = ASSET_TYPES.XLM): Promise<string> {
    try {
      const reserve = lendingPoolAddress(assetType);
      const [ta, td] = await Promise.all([
        simulateRead<bigint>(reserve, 'total_assets'),
        simulateRead<bigint>(reserve, 'total_debt'),
      ]);
      const cash = BigInt(ta ?? 0) - BigInt(td ?? 0);
      return wadToFixed7(cash > BigInt(0) ? cash : BigInt(0));
    } catch (error: any) {
      console.error('Error fetching pool liquidity:', error);
      return '0';
    }
  }

  /**
   * A reserve's total outstanding debt, interest accrued to now
   * (`reserve.total_debt()`, WAD → decimal).
   *
   * @param assetType - Reserve to query (default XLM).
   * @returns Borrows fixed to 7 decimals; `'0'` on error.
   */
  static async getPoolBorrows(assetType: AssetType = ASSET_TYPES.XLM): Promise<string> {
    try {
      return wadToFixed7(BigInt((await simulateRead<bigint>(lendingPoolAddress(assetType), 'total_debt')) ?? 0));
    } catch (error: any) {
      console.error('Error fetching pool borrows:', error);
      return '0';
    }
  }

  /**
   * A reserve's total managed assets (cash + debt) via `total_assets`
   * (WAD → decimal).
   *
   * @param assetType - Reserve to query (default XLM).
   * @returns Total assets fixed to 7 decimals; `'0'` on error.
   */
  static async getTotalAssets(assetType: AssetType = ASSET_TYPES.XLM): Promise<string> {
    try {
      return wadToFixed7(BigInt((await simulateRead<bigint>(lendingPoolAddress(assetType), 'total_assets')) ?? 0));
    } catch (error: any) {
      console.error('Error fetching total assets:', error);
      return '0';
    }
  }

  /**
   * A reserve's share-token `total_supply` (7 decimals, the old vToken supply).
   *
   * @param assetType - Reserve to query (default XLM).
   * @returns Supply fixed to 7 decimals; `'0'` on error.
   */
  static async getVTokenTotalSupply(assetType: AssetType = ASSET_TYPES.XLM): Promise<string> {
    try {
      const supply = BigInt((await simulateRead<bigint>(lendingPoolAddress(assetType), 'total_supply')) ?? 0);
      return (Number(supply) / 1e7).toFixed(7);
    } catch (error: any) {
      console.error('Error fetching vToken supply:', error);
      return '0';
    }
  }

  /**
   * Aggregate a reserve's headline stats in one call, reading total assets,
   * total debt and share supply in parallel. `totalSupply` is total assets
   * (cash + debt); `availableLiquidity` = totalSupply − borrows;
   * `utilizationRate` is borrows / totalSupply as a percentage string (the
   * same utilization the reserve's interest curve uses).
   *
   * @param assetType - Reserve to summarize (default XLM).
   * @returns `{ totalSupply, totalBorrowed, availableLiquidity, utilizationRate,
   *          vTokenSupply }` — all stringified; an all-zero object on error.
   */
  static async getPoolStats(assetType: AssetType = ASSET_TYPES.XLM): Promise<{
    totalSupply: string;
    totalBorrowed: string;
    availableLiquidity: string;
    utilizationRate: string;
    vTokenSupply: string;
  }> {
    try {
      const [totalAssets, borrows, vTokenSupply] = await Promise.all([
        this.getTotalAssets(assetType),
        this.getPoolBorrows(assetType),
        this.getVTokenTotalSupply(assetType),
      ]);

      const totalNum = parseFloat(totalAssets) || 0;
      const borrowsNum = parseFloat(borrows) || 0;
      const liquidityNum = Math.max(0, totalNum - borrowsNum);

      // Calculate utilization rate
      const utilizationRate = totalNum > 0
        ? ((borrowsNum / totalNum) * 100).toFixed(2)
        : '0';

      return {
        totalSupply: totalNum.toFixed(7),
        totalBorrowed: borrows,
        availableLiquidity: liquidityNum.toFixed(7),
        utilizationRate,
        vTokenSupply,
      };
    } catch (error: any) {
      console.error('Error fetching pool stats:', error);
      return {
        totalSupply: '0',
        totalBorrowed: '0',
        availableLiquidity: '0',
        utilizationRate: '0',
        vTokenSupply: '0',
      };
    }
  }

  /** trader → margin account (only non-null results; a margin never changes once created). */
  private static marginCache = new Map<string, Promise<string | null>>();

  private static cachedMarginOf(trader: string): Promise<string | null> {
    const hit = this.marginCache.get(trader);
    if (hit) return hit;
    const p = marginOf(trader).then((m) => {
      if (!m) this.marginCache.delete(trader);
      return m;
    });
    this.marginCache.set(trader, p);
    return p;
  }

  /**
   * A trader's outstanding debt in one reserve. Debt belongs to the trader's
   * margin account, so this resolves `credit_layer.margin_of(trader)` and then
   * reads `reserve.debt_of(margin)` (WAD, interest accrued to now).
   *
   * @param address - Trader G-address (or a margin account C-address).
   * @param assetType - Reserve to query (default XLM).
   * @returns Debt fixed to 7 decimals; `'0'` when no margin account / no debt / on error.
   */
  static async getUserBorrowBalance(
    address: string,
    assetType: AssetType = ASSET_TYPES.XLM
  ): Promise<string> {
    try {
      const margin = address.startsWith('C') ? address : await this.cachedMarginOf(address);
      if (!margin) return '0';
      const debt = BigInt(
        (await simulateRead<bigint>(lendingPoolAddress(assetType), 'debt_of', [sc.address(margin)])) ?? 0,
      );
      return wadToFixed7(debt);
    } catch (error: any) {
      console.error('Error fetching borrow balance:', error);
      return '0';
    }
  }
  /**
   * Read a wallet's spendable balances for every supported asset.
   *
   * Native XLM comes from Horizon; the USDC variants are read directly from
   * their Soroban SAC contracts rather than Horizon trustlines — collateral
   * transfers move SAC tokens, so showing the contract balance avoids
   * false-positive "available" amounts from a trustline that isn't the real
   * source. `USDC` and `BLEND_USDC` intentionally mirror the same Blend balance.
   *
   * @param address - Wallet G-address to query.
   * @returns Per-asset balances fixed to 7 decimals. On a transient
   *          Horizon/RPC failure it warns (not errors) and returns all zeros,
   *          since the next refresh typically recovers.
   */
  static async getAllTokenBalances(address: string): Promise<{
    XLM: string;
    USDC: string;
    BLEND_USDC: string;
    SOROSWAP_USDC: string;
  }> {
    const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
    const rpc = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);

    // Horizon and RPC source-account reads are independent. Starting them
    // together removes the old Horizon-before-Soroban waterfall.
    const [horizonResult, rpcAccountResult] = await Promise.allSettled([
      withRetry(RETRY.rpcRead, () => horizon.loadAccount(address)),
      withRetry(RETRY.rpcRead, () => rpc.getAccount(address)),
    ]);

    let xlmBalance = '0';
    if (horizonResult.status === 'fulfilled') {
      const native = horizonResult.value.balances.find((balance) => balance.asset_type === 'native');
      if (native) xlmBalance = parseFloat(native.balance).toFixed(7);
    }

    // All Stellar Asset Contracts use 7 decimals. Reuse the one source
    // sequence fetched above and run the three simulations concurrently;
    // previously every token performed its own getAccount + decimals call.
    const sourceSequence = rpcAccountResult.status === 'fulfilled'
      ? rpcAccountResult.value.sequenceNumber()
      : undefined;
    const tokenContracts = [
      // Aquarius's USDC is the Blend USDC token now, so it is not read twice.
      CONTRACT_ADDRESSES.BLEND_USDC,
      CONTRACT_ADDRESSES.SOROSWAP_USDC,
    ] as const;
    const tokenResults = sourceSequence === undefined
      ? []
      : await Promise.allSettled(
          tokenContracts.map((tokenContract) =>
            ContractService.getSorobanTokenWalletBalance(tokenContract, address, address, {
              sourceSequence,
              decimals: 7,
              throwOnError: true,
            }),
          ),
        );

    const valueAt = (index: number): string => {
      const result = tokenResults[index];
      return result?.status === 'fulfilled'
        ? (parseFloat(result.value) || 0).toFixed(7)
        : '0';
    };
    const blendUsdc = valueAt(0);
    const soroswapUsdc = valueAt(1);

    if (horizonResult.status === 'rejected' && tokenResults.every((r) => r.status === 'rejected')) {
      throw new Error('Unable to read wallet balances from Horizon or Soroban RPC');
    }

    return {
      XLM: xlmBalance,
      USDC: blendUsdc,
      BLEND_USDC: blendUsdc,
      SOROSWAP_USDC: soroswapUsdc,
    };
  }
}

/* ─── Credit-layer Reserve helpers (used by ContractService above) ─────────── */

/** Earn asset type → credit-layer asset symbol ('XLM' | 'BLUSDC' | 'SOUSDC'). */
function creditSymbol(assetType: AssetType): string {
  const a = toCreditAsset(assetType);
  if (!a) throw new Error(`Unsupported asset type: ${assetType}`);
  return a;
}

/** Human amount → WAD through an exact 7-decimal (stroop) integer step. */
function humanToWad(amount: number): bigint {
  return stroopsToWad(BigInt(Math.floor(amount * 1e7 + 1e-6)));
}

/** WAD bigint → decimal string with 7 decimals (exact, truncated to stroops). */
function wadToFixed7(wad: bigint): string {
  return (Number(wad / BigInt('100000000000')) / 1e7).toFixed(7);
}

/**
 * Port of reserve/src/interest.rs `borrow_rate_per_sec` (same integer math):
 * rate = c3 · (u·c1 + u^32·c1 + u^64·c2) / (SECS_PER_YEAR · WAD), u = debt / (cash + debt).
 */
function borrowRateFromCurve(curve: { c1: bigint; c2: bigint; c3: bigint }, cashWad: bigint, debtWad: bigint): bigint {
  const WAD_ = BigInt('1000000000000000000');
  const SECS_PER_YEAR_WAD = BigInt(31_556_952) * WAD_;
  const mulWad = (a: bigint, b: bigint) => (a * b) / WAD_;
  const total = cashWad + debtWad;
  let util = total === BigInt(0) ? BigInt(0) : (debtWad * WAD_) / total;
  if (util > WAD_) util = WAD_;
  // rpow_wad(util, 32)
  let base = util;
  let result = WAD_;
  let n = 32;
  while (n > 0) {
    if (n & 1) result = mulWad(result, base);
    if (n > 1) base = mulWad(base, base);
    n >>= 1;
  }
  const linear = mulWad(util, curve.c1);
  const steep = mulWad(result, curve.c1);
  const steeper = mulWad(mulWad(result, result), curve.c2);
  return (curve.c3 * (linear + steep + steeper)) / SECS_PER_YEAR_WAD;
}
