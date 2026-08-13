import { requestAccess, getAddress, signTransaction } from '@/lib/wallet-adapter';
import * as StellarSdk from '@stellar/stellar-sdk';
import { markTxSubmitted } from './tx-progress';

export const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
export const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
export const HORIZON_URL = 'https://horizon-testnet.stellar.org';

// Redeployed 2026-07-19 (third redeploy same day) — testnet genuinely has
// THREE separate USDC test tokens (one per DEX's own pre-existing pool,
// none interchangeable), reversing the prior "single canonical USDC"
// collapse. Registry.get_protocol_config() now returns aquarius_usdc/
// soroswap_usdc as their own real addresses alongside the Blend-side `usdc`.
// Each USDC variant has its own genuine lending pool (3 pools total, plus
// XLM = 4). See CONTRACT_COMMAND.md for the full command sequence.
//
// Live-verified this deploy (real testnet transactions): add liquidity to
// all 4 lending pools -> create margin account -> deposit XLM + borrow
// BLUSDC -> deposit XLM + borrow AqUSDC -> deposit XLM + borrow SoUSDC ->
// Blend Supply (exec) -> Soroswap AddLiquidity + RemoveLiquidity (exec),
// all succeeding with real fund movement and TrackingToken mint/burn.
//
// Aquarius AddLiquidity is registered and reachable but currently BLOCKED by
// a real external-protocol limitation: the live Aquarius router's `deposit`
// performs gauge/reward checkpoint accounting that reads a classic-asset
// trustline balance for `user` — a G-account without that trustline gets a
// graceful "trustline missing" error, but a smart-contract `user` has no
// trustline concept at all, so the same check panics unhandled instead.
// This is a protocol-side constraint on this specific gauge-enabled pool,
// not a bug in our Controller — confirmed by testing every plausible
// auth-entry shape (flat siblings, nested-under-router, nested-under-pool)
// and by reproducing the identical trustline-missing failure with a second
// real G-account. Aquarius RemoveLiquidity was never reached because of this.
export const CONTRACT_ADDRESSES = {
  REGISTRY: 'CBBQQULN3XZDWDZG7D6VYD4UQKBGYH22DOFQEISKENCMZTYUPQ5LDXUO',
  ORACLE: 'CAYHPE4U54GDKULPRHYJZNDMBAJDQ3UNQ446KFYMJ5HABBPORERZCRWB',
  RATE_MODEL: 'CBMJ7DD4EUVZWFRPKRPGYK2NADCIGY5OFTPN7PJ7SAOIJI7IQTVHOJT6',
  RISK_ENGINE: 'CCSCBA4WSUMVGA4CWC7QKBZXXEL4TO2YCCFPGHX5SJCYKHQLQUKAVUAY',
  ACCOUNT_MANAGER: 'CAZLR6EHZXQNZJIFNP6F7SIJQC3P64MKHHQNZSSG5BNAEFCYTTGTDZXB',
  TRACKING_TOKEN: 'CC4P2DC4J3DTKNL7CQB42S3JSZNIVVHFJEMHZWTSDR233CT6O2KK7ZK2',
  CONTROLLER_FACADE: 'CB2SEZGDRPS4O56UYQAERQGHM7V6ZDMZZE5AYOGERRGWT5CUGRPVDWEH',
  POOL_DEPLOYER: 'CCURFEEXKVGDAKXAGNG4NHEK2RRSOBOVUZDNHI32DFBAF2HWO57JKLIP',

  // Per-protocol Controllers — resolved by Registry.get_controller_for(target)
  // Redeployed 2026-07-20/21: all three Controllers now have an admin-gated
  // `upgrade()` fn, so future fixes won't need a fresh redeploy + re-register.
  BLEND_CONTROLLER: 'CCZVHCPWY47GRWCE2TB7QPX7Y54BMQUYQTTAQ5LJGNJ3GLGO77VVQUS3',
  SOROSWAP_CONTROLLER: 'CBSUSG7PK2QKYBEA2GPNNTV7QVGKV7DSDUFDB44FFRZYR4L4GB7BKD2M',
  AQUARIUS_CONTROLLER: 'CBVRH2DWBMASALAMPZ5JUCKZHWO6SA2MD4MBXMO644XNCERWBMKHL2WT',

  // vToken receipt contracts, one per lending pool
  VXLM_TOKEN: 'CDGYZSMWOOKM55WEKEQ2HEMM7RS2KRA7MYI2DDYXWV5YHGUVUGQZSOCB',
  VBLEND_USDC_TOKEN: 'CAZWBJQ6V2XASUILI36UVQJ5K2EQXIDVXJZNGZBEONPUVVURKDOP4RX5',
  VAQUARIUS_USDC_TOKEN: 'CAU5GVAGCWLOIAGFHQFEVBJLDHVS2KH4YPRQ34CIDG2T7RDAWWWODKRV',
  VSOROSWAP_USDC_TOKEN: 'CAIMEE4EZ3FUMOBTVV7DKGI2TDACWXUWU6Z2RJ3NMP642TDKQHHOEIWG',
  // Back-compat alias used by earn constants
  VUSDC_TOKEN: 'CAZWBJQ6V2XASUILI36UVQJ5K2EQXIDVXJZNGZBEONPUVVURKDOP4RX5',

  // Lending Pools — XLM + per-USDC-variant
  LENDING_PROTOCOL_XLM: 'CB3LCPDMPRTRXJHO7ZB3OORQDL2AV5FTJPPZOPHTZFOMUPMJY55RHYR3',
  LENDING_PROTOCOL_BLEND_USDC: 'CCHSDWJPFMEFNDRSZ55A5MLSTASYHZERLPJIJGTAD7MT24KHVLOU3BTI',
  LENDING_PROTOCOL_AQUARIUS_USDC: 'CDKMMD63RUZNROFZZD64QZNEQ2FR5X62R4FE6E3USJ5VN5KY7QM6F2FD',
  LENDING_PROTOCOL_SOROSWAP_USDC: 'CCZQUQQVZVNZMTG2P6MVAGA7V2DRTCII6IGVEQ5YUCYP7MXA7SMLHETP',
  // Back-compat alias for call sites still keyed on a single "USDC" pool —
  // resolves to Blend's own pool specifically, not a shared canonical one.
  LENDING_PROTOCOL_USDC: 'CCHSDWJPFMEFNDRSZ55A5MLSTASYHZERLPJIJGTAD7MT24KHVLOU3BTI',

  // Three genuinely distinct USDC test tokens — one per DEX's own real pool.
  BLEND_USDC_TOKEN: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',
  AQUARIUS_USDC_TOKEN: 'CAZRY5GSFBFXD7H6GAFBA5YGYQTDXU4QKWKMYFWBAZFUCURN3WKX6LF5',
  SOROSWAP_USDC_TOKEN: 'CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F',
  // Back-compat alias for old single-USDC call sites — resolves to Blend's own token.
  USDC_TOKEN: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',

  // Blend Capital (testnet, external, unchanged)
  BLEND_POOL: 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF',
  BLEND_XLM: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  BLEND_USDC: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',

  // Aquarius AMM (testnet, external). Registered and reachable — see the
  // gauge/trustline limitation noted above for why AddLiquidity still fails.
  // Only constant_product pools are supported (no concentrated).
  AQUARIUS_ROUTER: 'CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD',
  AQUARIUS_XLM_USDC_POOL: 'CD3LFMMLBQ6RBJUD3Z2LFDFE6544WDRMWHEZYPI5YDVESYRSO2TT32BX',
  AQUARIUS_USDC: 'CAZRY5GSFBFXD7H6GAFBA5YGYQTDXU4QKWKMYFWBAZFUCURN3WKX6LF5',
  AQUARIUS_POOL_INDEX_HEX: '9ac7a9cde23ac2ada11105eeaa42e43c2ea8332ca0aa8f41f58d7160274d718e',
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

// Aquarius USDC classic-side issuer (for trustline/Horizon balance checks)
export const ASSET_ISSUERS = {
  USDC_AQUARIUS: 'GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER',
} as const;

export type AssetType = typeof ASSET_TYPES[keyof typeof ASSET_TYPES];

/** Lending-pool contract for an earn asset type. */
export function lendingPoolAddress(assetType: AssetType): string {
  switch (assetType) {
    case ASSET_TYPES.XLM: return CONTRACT_ADDRESSES.LENDING_PROTOCOL_XLM;
    case ASSET_TYPES.USDC:
    case ASSET_TYPES.BLEND_USDC: return CONTRACT_ADDRESSES.LENDING_PROTOCOL_BLEND_USDC;
    case ASSET_TYPES.AQUARIUS_USDC: return CONTRACT_ADDRESSES.LENDING_PROTOCOL_AQUARIUS_USDC;
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
    case ASSET_TYPES.AQUARIUS_USDC: return CONTRACT_ADDRESSES.VAQUARIUS_USDC_TOKEN;
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
      const account = await server.loadAccount(address);
      
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
        if (options?.throwOnError) throw new Error(`Token balance simulation failed for ${tokenContract}`);
        return '0';
      }

      const raw = StellarSdk.scValToNative(sim.result.retval) as bigint;
      const decimals = options?.decimals ?? await this.getTokenDecimals(tokenContract);
      return (Number(raw) / 10 ** decimals).toFixed(7);
    } catch (error) {
      if (options?.throwOnError) throw error;
      return '0';
    }
  }

  static async deposit(
    walletAddress: string, 
    amount: number, 
    assetType: AssetType = ASSET_TYPES.XLM
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(walletAddress);
      
      const contractAddress = lendingPoolAddress(assetType);
      const methodName = 'deposit';

      const contract = new StellarSdk.Contract(contractAddress);

      // See ContractService.withdraw's matching comment: raw `amount * 1e18`
      // float multiplication loses precision once the product needs more
      // significant digits than a JS double can hold, most likely to bite on
      // a 100%-of-balance supply with many decimal digits. Splitting through
      // a 7-decimal (stroop-precision) integer step keeps it exact.
      const amountWAD = (BigInt(Math.floor(amount * 1e7)) * BigInt(10 ** 11)).toString();

      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            methodName,
            StellarSdk.nativeToScVal(walletAddress, { type: 'address' }),
            StellarSdk.nativeToScVal(amountWAD, { type: 'u256' })
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
        await ContractService.pollTransactionStatus(server, result.hash);
        return { success: true, hash: result.hash };
      } else {
        throw new Error(`Transaction rejected by network: ${describeSendError(result)}`);
      }
    } catch (error: any) {
      console.error('Deposit error:', error);
      return { success: false, error: error?.message || 'Deposit failed' };
    }
  }

  /**
   * Withdraw from a lending pool by redeeming vTokens (`redeem_vxlm` /
   * `redeem_vusdc`). Prepares → signs via Freighter → submits → polls.
   *
   * @param walletAddress - Redeemer's G-address and tx source.
   * @param amount - Human amount; converted to WAD as `floor(amount × 1e18)`.
   * @param assetType - Target pool (default XLM); undeployed pools return an
   *                    error rather than throwing.
   * @returns `{ success, hash?, error? }`.
   */
  static async withdraw(
    walletAddress: string, 
    amount: number, 
    assetType: AssetType = ASSET_TYPES.XLM
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const sourceAccount = await server.getAccount(walletAddress);
      
      const contractAddress = lendingPoolAddress(assetType);
      const methodName = 'redeem_vtokens';
      
      const contract = new StellarSdk.Contract(contractAddress);

      // `amount * 1e18` in raw floating point loses precision once the
      // product needs more significant digits than a JS double can hold
      // (~15-17) — confirmed live: withdrawing the exact 100% vToken balance
      // (999.5544013) computed as 999554401300000014336 instead of the true
      // 999554401300000000000, a 14336-unit excess over the real balance.
      // redeem_vtokens has no tolerance for that — it trapped with
      // `HostError(WasmVm, InvalidAction) / UnreachableCodeReached`
      // instead of a clean "insufficient balance" the caller could act on.
      // Splitting the conversion through a 7-decimal (stroop-precision —
      // Stellar amounts never carry more real precision than this) integer
      // step keeps the multiplication that actually needs 18 digits of
      // headroom in exact BigInt arithmetic instead of a float.
      const amountWAD = (BigInt(Math.floor(amount * 1e7)) * BigInt(10 ** 11)).toString();

      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            methodName,
            StellarSdk.nativeToScVal(walletAddress, { type: 'address' }),
            StellarSdk.nativeToScVal(amountWAD, { type: 'u256' })
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
        await ContractService.pollTransactionStatus(server, result.hash);
        return { success: true, hash: result.hash };
      } else {
        throw new Error(`Transaction rejected by network: ${describeSendError(result)}`);
      }
    } catch (error: any) {
      console.error('Withdraw error:', error);
      return { success: false, error: error?.message || 'Withdraw failed' };
    }
  }

  /**
   * Read a holder's vToken (deposit-receipt) balance for a pool via simulation,
   * scaled by the vToken's own decimals.
   *
   * @param address - Holder G-address; also the simulation source.
   * @param assetType - Which pool's vToken to read (default XLM).
   * @returns Balance fixed to 7 decimals, `'0'` when empty/undeployed/sim-fail,
   *          or `'Error'` on exception.
   */
  static async getDepositedBalance(
    address: string,
    assetType: AssetType = ASSET_TYPES.XLM
  ): Promise<string> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      // Read-only simulation does not need a live sequence-number lookup.
      const sourceAccount = new StellarSdk.Account(address, '0');
      
      const contractAddress = vTokenAddress(assetType);

      const contract = new StellarSdk.Contract(contractAddress);

      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'balance',
            StellarSdk.nativeToScVal(address, { type: 'address' })
          )
        )
        .setTimeout(30)
        .build();

      const simulationResponse = await server.simulateTransaction(transaction);
      
      if (StellarSdk.rpc.Api.isSimulationSuccess(simulationResponse)) {
        const result = simulationResponse.result;
        if (result && result.retval) {
          const balance = StellarSdk.scValToNative(result.retval);
          const decimals = await this.getTokenDecimals(contractAddress);
          const balanceDecimal = Number(balance) / 10 ** decimals;
          return balanceDecimal.toFixed(7);
        } else {
          return '0';
        }
      } else {
        console.error(`[getDepositedBalance] Simulation failed for ${assetType}`);
        return '0';
      }
    } catch (error: any) {
      console.error(`[getDepositedBalance] Error fetching deposited balance for ${assetType}:`, error);
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

  /**
   * Read the REAL per-second borrow interest rate straight from the deployed
   * `RateModelContract.get_borrow_rate_per_sec(liquidity_wad, borrows_wad)` —
   * the exact same curve `lending-pool`'s own `get_rate_factor` calls to
   * accrue interest on-chain. This replaced a frontend-only synthetic curve
   * (`lib/utils/borrow-rate.ts`'s `computeBorrowApr`) that had no relationship
   * to the real contract math and could show Supply APY above Borrow APY —
   * mathematically impossible under the real curve, since supply is always a
   * fraction (utilization-scaled) of borrow.
   *
   * @param liquidityWad - Pool's available liquidity, WAD-scaled (1e18).
   * @param borrowsWad - Pool's outstanding borrows, WAD-scaled (1e18).
   * @returns The per-second rate, WAD-scaled, as a bigint; `null` on error.
   */
  static async getBorrowRatePerSecWad(liquidityWad: bigint, borrowsWad: bigint): Promise<bigint | null> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      const contract = new StellarSdk.Contract(CONTRACT_ADDRESSES.RATE_MODEL);

      const transaction = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'get_borrow_rate_per_sec',
            StellarSdk.nativeToScVal(liquidityWad, { type: 'u256' }),
            StellarSdk.nativeToScVal(borrowsWad, { type: 'u256' }),
          )
        )
        .setTimeout(30)
        .build();

      const simulationResponse = await server.simulateTransaction(transaction);

      if (StellarSdk.rpc.Api.isSimulationSuccess(simulationResponse)) {
        const result = simulationResponse.result;
        if (result && result.retval) {
          const ratePerSecWad = StellarSdk.scValToNative(result.retval);
          return BigInt(ratePerSecWad);
        }
      }
      return null;
    } catch (error: any) {
      console.error('Error fetching borrow rate per sec:', error);
      return null;
    }
  }

  /**
   * Read a pool's available (un-borrowed) liquidity via
   * `get_total_liquidity_in_pool`, converting the returned WAD to a decimal.
   * Simulated from a throwaway random source account (no signer needed).
   *
   * @param assetType - Pool to query (default XLM).
   * @returns Liquidity fixed to 7 decimals; `'0'` when undeployed or on error.
   */
  static async getPoolLiquidity(assetType: AssetType = ASSET_TYPES.XLM): Promise<string> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      
      const contractAddress = lendingPoolAddress(assetType);

      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');
      
      const contract = new StellarSdk.Contract(contractAddress);
      
      const transaction = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('get_total_liquidity_in_pool'))
        .setTimeout(30)
        .build();

      const simulationResponse = await server.simulateTransaction(transaction);
      
      if (StellarSdk.rpc.Api.isSimulationSuccess(simulationResponse)) {
        const result = simulationResponse.result;
        if (result && result.retval) {
          const liquidityWad = StellarSdk.scValToNative(result.retval);
          // Convert from WAD (18 decimals) to regular decimal
          const liquidity = Number(liquidityWad) / 1e18;
          return liquidity.toFixed(7);
        }
      }
      return '0';
    } catch (error: any) {
      console.error('Error fetching pool liquidity:', error);
      return '0';
    }
  }

  /**
   * Read a pool's total outstanding borrows via `get_borrows` (WAD → decimal).
   * Simulated from a throwaway random source account.
   *
   * @param assetType - Pool to query (default XLM).
   * @returns Borrows fixed to 7 decimals; `'0'` when undeployed or on error.
   */
  static async getPoolBorrows(assetType: AssetType = ASSET_TYPES.XLM): Promise<string> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      
      const contractAddress = lendingPoolAddress(assetType);

      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');

      const contract = new StellarSdk.Contract(contractAddress);

      const transaction = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('get_borrows'))
        .setTimeout(30)
        .build();

      const simulationResponse = await server.simulateTransaction(transaction);
      
      if (StellarSdk.rpc.Api.isSimulationSuccess(simulationResponse)) {
        const result = simulationResponse.result;
        if (result && result.retval) {
          const borrowsWad = StellarSdk.scValToNative(result.retval);
          const borrows = Number(borrowsWad) / 1e18;
          return borrows.toFixed(7);
        }
      }
      return '0';
    } catch (error: any) {
      console.error('Error fetching pool borrows:', error);
      return '0';
    }
  }

  /**
   * Read a pool's total managed assets (liquidity + borrows) via `total_assets`
   * (WAD → decimal). Simulated from a throwaway random source account.
   *
   * @param assetType - Pool to query (default XLM).
   * @returns Total assets fixed to 7 decimals; `'0'` when undeployed or on error.
   */
  static async getTotalAssets(assetType: AssetType = ASSET_TYPES.XLM): Promise<string> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      
      const contractAddress = lendingPoolAddress(assetType);

      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');

      const contract = new StellarSdk.Contract(contractAddress);

      const transaction = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('total_assets'))
        .setTimeout(30)
        .build();

      const simulationResponse = await server.simulateTransaction(transaction);
      
      if (StellarSdk.rpc.Api.isSimulationSuccess(simulationResponse)) {
        const result = simulationResponse.result;
        if (result && result.retval) {
          const totalWad = StellarSdk.scValToNative(result.retval);
          const total = Number(totalWad) / 1e18;
          return total.toFixed(7);
        }
      }
      return '0';
    } catch (error: any) {
      console.error('Error fetching total assets:', error);
      return '0';
    }
  }

  /**
   * Read a pool vToken's `total_supply`, scaled by the vToken's decimals.
   * Simulated from a throwaway random source account.
   *
   * @param assetType - Pool whose vToken to query (default XLM).
   * @returns Supply fixed to 7 decimals; `'0'` when undeployed or on error.
   */
  static async getVTokenTotalSupply(assetType: AssetType = ASSET_TYPES.XLM): Promise<string> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      
      const contractAddress = vTokenAddress(assetType);

      const tempKeypair = StellarSdk.Keypair.random();
      const tempAccount = new StellarSdk.Account(tempKeypair.publicKey(), '0');

      const contract = new StellarSdk.Contract(contractAddress);

      const transaction = new StellarSdk.TransactionBuilder(tempAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('total_supply'))
        .setTimeout(30)
        .build();

      const simulationResponse = await server.simulateTransaction(transaction);
      
      if (StellarSdk.rpc.Api.isSimulationSuccess(simulationResponse)) {
        const result = simulationResponse.result;
        if (result && result.retval) {
          const supply = StellarSdk.scValToNative(result.retval);
          const decimals = await this.getTokenDecimals(contractAddress);
          const supplyDecimal = Number(supply) / 10 ** decimals;
          return supplyDecimal.toFixed(7);
        }
      }
      return '0';
    } catch (error: any) {
      console.error('Error fetching vToken supply:', error);
      return '0';
    }
  }

  /**
   * Aggregate a pool's headline stats in one call, fetching liquidity, borrows
   * and vToken supply in parallel. `totalSupply` is liquidity + borrows;
   * `utilizationRate` is borrows / totalSupply as a percentage string.
   *
   * @param assetType - Pool to summarize (default XLM).
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
      const [liquidity, borrows, vTokenSupply] = await Promise.all([
        this.getPoolLiquidity(assetType),
        this.getPoolBorrows(assetType),
        this.getVTokenTotalSupply(assetType),
      ]);
      
      const liquidityNum = parseFloat(liquidity) || 0;
      const borrowsNum = parseFloat(borrows) || 0;
      const totalSupply = liquidityNum + borrowsNum;
      
      // Calculate utilization rate
      const utilizationRate = totalSupply > 0 
        ? ((borrowsNum / totalSupply) * 100).toFixed(2)
        : '0';
      
      return {
        totalSupply: totalSupply.toFixed(7),
        totalBorrowed: borrows,
        availableLiquidity: liquidity,
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

  /**
   * Read a user's outstanding borrow balance for a pool via
   * `get_borrow_balance` (WAD ÷ 1e18). Simulated from the user's own account.
   *
   * @param address - Borrower G-address; also the simulation source.
   * @param assetType - Pool to query (default XLM).
   * @returns Borrow balance fixed to 7 decimals; `'0'` when undeployed or on error.
   */
  static async getUserBorrowBalance(
    address: string,
    assetType: AssetType = ASSET_TYPES.XLM
  ): Promise<string> {
    try {
      const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
      // Read-only simulation does not need a live sequence-number lookup.
      const sourceAccount = new StellarSdk.Account(address, '0');
      
      const contractAddress = lendingPoolAddress(assetType);

      const contract = new StellarSdk.Contract(contractAddress);

      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            'get_borrow_balance',
            StellarSdk.nativeToScVal(address, { type: 'address' })
          )
        )
        .setTimeout(30)
        .build();

      const simulationResponse = await server.simulateTransaction(transaction);
      
      if (StellarSdk.rpc.Api.isSimulationSuccess(simulationResponse)) {
        const result = simulationResponse.result;
        if (result && result.retval) {
          const balance = StellarSdk.scValToNative(result.retval);
          const balanceDecimal = Number(balance) / 1e18;
          return balanceDecimal.toFixed(7);
        }
      }
      return '0';
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
    AQUARIUS_USDC: string;
    SOROSWAP_USDC: string;
  }> {
    const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
    const rpc = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);

    // Horizon and RPC source-account reads are independent. Starting them
    // together removes the old Horizon-before-Soroban waterfall.
    const [horizonResult, rpcAccountResult] = await Promise.allSettled([
      horizon.loadAccount(address),
      rpc.getAccount(address),
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
      CONTRACT_ADDRESSES.BLEND_USDC,
      CONTRACT_ADDRESSES.AQUARIUS_USDC,
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
    const aquariusUsdc = valueAt(1);
    const soroswapUsdc = valueAt(2);

    if (horizonResult.status === 'rejected' && tokenResults.every((r) => r.status === 'rejected')) {
      throw new Error('Unable to read wallet balances from Horizon or Soroban RPC');
    }

    return {
      XLM: xlmBalance,
      USDC: blendUsdc,
      BLEND_USDC: blendUsdc,
      AQUARIUS_USDC: aquariusUsdc,
      SOROSWAP_USDC: soroswapUsdc,
    };
  }
}
