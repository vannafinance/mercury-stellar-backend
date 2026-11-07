/**
 * Client for the Vanna credit-layer contracts (testnet redeploy 2026-11-06,
 * Protocol_V1_Soroban_testnet branch `testnet-credit-layer`, deploy/testnet.json).
 *
 * The credit layer replaced the old AccountManager / Registry / RiskEngine /
 * lending-pool / vToken / SmartAccount / Controller contracts:
 *   - CreditLayer: create_margin, deposit_collateral, withdraw_collateral,
 *     borrow, repay, margin_execute (venue calls), liquidate, margin_value.
 *   - Reserve (one per asset): supply / redeem for lenders. The reserve IS the
 *     share token (balance / total_supply / decimals), so it replaces both the
 *     old lending pool and its vToken.
 *   - MarginAccount (one per trader): holds the funds; `assets()` / `debts()`.
 *   - Oracle: get_price(asset, account, mode) -> USD price in WAD (1e18).
 *
 * Amounts: every `*_wad` argument is a 1e18 fixed-point number. Exceptions in
 * margin_execute: `min_out` and Soroswap's LP / min amounts are native units
 * (7 decimals on testnet); Aquarius RemoveLiquidity's LP amount is WAD and its
 * mins are native.
 */
import * as StellarSdk from '@stellar/stellar-sdk';
import { getAddress, signTransaction } from '@/lib/wallet-adapter';
import { getReadSourceAddress } from '@/lib/read-source';
import { markTxSubmitted } from './tx-progress';

const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';

/** Addresses written by deploy/deploy.sh to deploy/testnet.json. */
export const CREDIT_LAYER_ADDRESSES = {
  ADMIN: 'GB3QLYUAG4E35US6ACVRMEPQSGPR7YJFCHL3DR77SBNDRRXF524NPQMT',
  CREDIT_LAYER: 'CCDZE7VGLWXOUGUBUXHXUMMBTMBSXG4R3VZSROLOCP73DSAA5AIAKYVP',
  ORACLE: 'CAFMDZ4OZGMDIRTPLEOBFL5JLLOEETLWQIUNOL7MWGMJOJPZSQDQGQTE',
  VALIDATOR_FACADE: 'CBPEQBRFELQZLIWWNAOTJQPOJSCQORT6GIV5KDBD4E5FNGPZHTVWOLG2',
  REFLECTOR: 'CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63',
  RESERVE_XLM: 'CC2GWN6QIB4YQ6CWIRGTMJFG6E2SMUW5QUROSHXX55VUEVDZ5PSODV36',
  RESERVE_BLUSDC: 'CCV6MFO66JRAFMJEF7A3E726FF26LACLFOJ6BZOTBFXC3OVD7WBQLARE',
  RESERVE_AQUSDC: 'CBRXVEAR5BU6SPFGVUPCI3AJHDGNTW6XK7X7UNPZSZTQUPUE765A2A6S',
  RESERVE_SOUSDC: 'CDMROV7WSYG44ZKZS4KFVN4GJRNOV5BGFWSRXNRLM7IFP7YFTMYULCNN',
  BLEND_VALIDATOR: 'CAMZ426UMBLLOJEOWDTB7MOSWJZQW7FPYLGFXYWYCAWOPJAJ2HI2LZLP',
  BLEND_VALUER: 'CBAOEJK6JO77E3S3Y6WS6U5JOKB3ZZR5GH7RKM7U7FXMN6UVTTLLOPQN',
  SOROSWAP_VALIDATOR: 'CCWKZG4MRD5ZCL4SQ4AIXQFXTVLPCY62PE5HQTKV6LU64VN467GQY6DR',
  SOROSWAP_LP_ADAPTER: 'CDU6LOHZ4ZGDZ7YTDQJ3IC2QRXHDWGI3AOSNAOHHOFUNC2VVTIJHXI5B',
  AQUARIUS_VALIDATOR: 'CDTY5OY2IZLVAF7CQDQC7C4JVL26BTCNH4P2F43F6TDVJXTM7CGXHGL6',
  AQUARIUS_LP_ADAPTER: 'CBNZZ73PMPGR7XHWXLEENB5MM5JMKMG4PGMJFUWUYTO7ZKUWYMASB4QM',
  /** Aquarius XLM/AQUSDC pool share token (held directly by the margin account). */
  AQUARIUS_SHARE: 'CDZ3L5A7DY6OSJPTWCACOMEA4H6RC7B5CTFRHSPUUAHMEL2MAKY37JMG',
} as const;

/** The four credit-layer assets. Symbol = the reserve's `v<symbol>` share name. */
export type CreditAsset = 'XLM' | 'BLUSDC' | 'AQUSDC' | 'SOUSDC';

export const CREDIT_ASSETS: Record<CreditAsset, { token: string; reserve: string; decimals: number }> = {
  XLM: { token: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC', reserve: CREDIT_LAYER_ADDRESSES.RESERVE_XLM, decimals: 7 },
  BLUSDC: { token: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU', reserve: CREDIT_LAYER_ADDRESSES.RESERVE_BLUSDC, decimals: 7 },
  AQUSDC: { token: 'CAZRY5GSFBFXD7H6GAFBA5YGYQTDXU4QKWKMYFWBAZFUCURN3WKX6LF5', reserve: CREDIT_LAYER_ADDRESSES.RESERVE_AQUSDC, decimals: 7 },
  SOUSDC: { token: 'CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F', reserve: CREDIT_LAYER_ADDRESSES.RESERVE_SOUSDC, decimals: 7 },
};

/** Health threshold the contracts enforce for borrow, withdraw and liquidation (1.2). */
export const HEALTH_THRESHOLD = 1.2;

export const WAD = BigInt('1000000000000000000');
const STROOP_TO_WAD = BigInt('100000000000'); // 1e11

/**
 * Maps any UI alias (USDC, BLEND_USDC, AQUARIUS_USDC, SoUSDC, …) to a credit
 * asset. Plain "USDC" means the Blend USDC test token, as everywhere else in the app.
 */
export function toCreditAsset(symbol: string): CreditAsset | null {
  const s = String(symbol || '').trim().toUpperCase().replace(/[\s-]/g, '_');
  if (s === 'XLM' || s === 'NATIVE') return 'XLM';
  if (['USDC', 'BLUSDC', 'BLEND_USDC', 'BLENDUSDC'].includes(s)) return 'BLUSDC';
  if (['AQUSDC', 'AQUARIUS_USDC', 'AQUARIUSUSDC', 'AQUIRESUSDC'].includes(s)) return 'AQUSDC';
  if (['SOUSDC', 'SOROSWAP_USDC', 'SOROSWAPUSDC'].includes(s)) return 'SOUSDC';
  return null;
}

/** Credit asset for a token contract address, or null. */
export function creditAssetForToken(token: string): CreditAsset | null {
  for (const [k, v] of Object.entries(CREDIT_ASSETS)) if (v.token === token) return k as CreditAsset;
  return null;
}

export function tokenAddressFor(symbol: string): string {
  const a = toCreditAsset(symbol);
  if (!a) throw new Error(`Unsupported asset: ${symbol}`);
  return CREDIT_ASSETS[a].token;
}

export function reserveAddressFor(symbol: string): string {
  const a = toCreditAsset(symbol);
  if (!a) throw new Error(`Unsupported asset: ${symbol}`);
  return CREDIT_ASSETS[a].reserve;
}

/* ------------------------------- ScVal helpers ------------------------------ */

export const sc = {
  address: (a: string) => StellarSdk.nativeToScVal(a, { type: 'address' }),
  u256: (v: bigint | string | number) => StellarSdk.nativeToScVal(BigInt(v), { type: 'u256' }),
  u128: (v: bigint | string | number) => StellarSdk.nativeToScVal(BigInt(v), { type: 'u128' }),
  bool: (v: boolean) => StellarSdk.nativeToScVal(v, { type: 'bool' }),
  addresses: (list: string[]) => StellarSdk.xdr.ScVal.scvVec(list.map((a) => sc.address(a))),
  u128s: (list: (bigint | string | number)[]) => StellarSdk.xdr.ScVal.scvVec(list.map((v) => sc.u128(v))),
  /** A unit enum variant, e.g. ExternalAction::Swap or PriceMode::Liquidation. */
  unitEnum: (name: string) => StellarSdk.xdr.ScVal.scvVec([StellarSdk.xdr.ScVal.scvSymbol(name)]),
};

export type ExternalAction = 'Supply' | 'Withdraw' | 'Swap' | 'AddLiquidity' | 'RemoveLiquidity';

export function stroopsToWad(stroops: bigint): bigint {
  return stroops * STROOP_TO_WAD;
}
export function wadToStroops(wad: bigint): bigint {
  return wad / STROOP_TO_WAD;
}
export function wadToNumber(wad: bigint | string | number): number {
  const v = BigInt(wad as any);
  return Number(v / BigInt(1e9)) / 1e9;
}

/* ---------------------------------- reads ---------------------------------- */

let server: StellarSdk.rpc.Server | null = null;
export function rpc(): StellarSdk.rpc.Server {
  if (!server) server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
  return server;
}

/**
 * Simulates a view call and returns the decoded native value. Throws on a
 * contract error so callers can tell "no data" apart from "call failed".
 */
export async function simulateRead<T = any>(contractId: string, fn: string, args: StellarSdk.xdr.ScVal[] = []): Promise<T> {
  const source = await getReadSourceAddress();
  const account = new StellarSdk.Account(source, '0');
  const tx = new StellarSdk.TransactionBuilder(account, { fee: StellarSdk.BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new StellarSdk.Contract(contractId).call(fn, ...args))
    .setTimeout(30)
    .build();
  const sim = await rpc().simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) throw new Error(`${fn}: ${sim.error}`);
  const retval = (sim as any).result?.retval;
  return (retval ? StellarSdk.scValToNative(retval) : undefined) as T;
}

/** Same as {@link simulateRead} but returns `fallback` on any error. */
export async function readOr<T>(contractId: string, fn: string, args: StellarSdk.xdr.ScVal[], fallback: T): Promise<T> {
  try {
    const v = await simulateRead<T>(contractId, fn, args);
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

export async function marginOf(trader: string): Promise<string | null> {
  return readOr<string | null>(CREDIT_LAYER_ADDRESSES.CREDIT_LAYER, 'margin_of', [sc.address(trader)], null);
}

export async function ownerOf(margin: string): Promise<string | null> {
  return readOr<string | null>(CREDIT_LAYER_ADDRESSES.CREDIT_LAYER, 'owner_of', [sc.address(margin)], null);
}

/** Collateral and debt in USD (WAD), priced in Liquidation mode, as the contract does. */
export async function marginValue(margin: string): Promise<{ collateralWad: bigint; debtWad: bigint }> {
  const [c, d] = await simulateRead<[bigint, bigint]>(CREDIT_LAYER_ADDRESSES.CREDIT_LAYER, 'margin_value', [sc.address(margin)]);
  return { collateralWad: BigInt(c), debtWad: BigInt(d) };
}

/** Token addresses with an open debt. */
export async function marginDebts(margin: string): Promise<string[]> {
  return readOr<string[]>(margin, 'debts', [], []);
}

/** Listed assets: tokens held directly plus venues (Blend pool) with a position. */
export async function marginAssets(margin: string): Promise<{ tokens: string[]; venues: string[] }> {
  const raw = await readOr<any[]>(margin, 'assets', [], []);
  const tokens: string[] = [];
  const venues: string[] = [];
  for (const k of raw || []) {
    // AssetKey decodes as [tag, address] (JS SDK) or {Tag: address}
    let tag: string | undefined;
    let addr: string | undefined;
    if (Array.isArray(k) && k.length === 2) {
      tag = String(k[0]);
      addr = String(k[1]);
    } else if (k && typeof k === 'object') {
      const [t, a] = Object.entries(k)[0] ?? [];
      tag = t;
      addr = a === undefined ? undefined : String(a);
    }
    if (tag === 'Token' && addr) tokens.push(addr);
    else if (tag === 'Venue' && addr) venues.push(addr);
  }
  return { tokens, venues };
}

/** Debt of `margin` in a reserve, WAD of the underlying asset. */
export async function debtOf(symbol: string, margin: string): Promise<bigint> {
  return BigInt(await readOr<bigint>(reserveAddressFor(symbol), 'debt_of', [sc.address(margin)], BigInt(0)));
}

/** SAC / share token balance in native units. */
export async function tokenBalance(token: string, holder: string): Promise<bigint> {
  return BigInt(await readOr<bigint>(token, 'balance', [sc.address(holder)], BigInt(0)));
}

/** Oracle price in USD WAD. `account` matters only for venue valuation. */
export async function oraclePriceWad(asset: string, account?: string): Promise<bigint> {
  return BigInt(
    await simulateRead<bigint>(CREDIT_LAYER_ADDRESSES.ORACLE, 'get_price', [
      sc.address(asset),
      sc.address(account || CREDIT_LAYER_ADDRESSES.ADMIN),
      sc.unitEnum('Liquidation'),
    ]),
  );
}

export interface ReserveStats {
  totalAssetsWad: bigint; // cash + debt
  totalDebtWad: bigint;
  cashWad: bigint; // available liquidity
  shareSupply: bigint; // native share units (7 dp)
  borrowRatePerSecWad: bigint;
  originationFeeWad: bigint;
}

export async function reserveStats(symbol: string): Promise<ReserveStats> {
  const r = reserveAddressFor(symbol);
  const [ta, td, supply, rate, fee] = await Promise.all([
    readOr<bigint>(r, 'total_assets', [], BigInt(0)),
    readOr<bigint>(r, 'total_debt', [], BigInt(0)),
    readOr<bigint>(r, 'total_supply', [], BigInt(0)),
    readOr<bigint>(r, 'borrow_rate_per_sec', [], BigInt(0)),
    readOr<bigint>(r, 'origination_fee', [], BigInt(0)),
  ]);
  const totalAssetsWad = BigInt(ta);
  const totalDebtWad = BigInt(td);
  return {
    totalAssetsWad,
    totalDebtWad,
    cashWad: totalAssetsWad > totalDebtWad ? totalAssetsWad - totalDebtWad : BigInt(0),
    shareSupply: BigInt(supply),
    borrowRatePerSecWad: BigInt(rate),
    originationFeeWad: BigInt(fee),
  };
}

/** Underlying value of `shares` (native share units) at the reserve's current rate, WAD. */
export function sharesToAssetsWad(shares: bigint, stats: ReserveStats): bigint {
  if (stats.shareSupply === BigInt(0)) return stroopsToWad(shares);
  return (shares * stats.totalAssetsWad) / stats.shareSupply;
}

/** Shares (native units) needed to redeem `assetsWad`, rounded up, capped by nothing. */
export function assetsWadToShares(assetsWad: bigint, stats: ReserveStats): bigint {
  if (stats.totalAssetsWad === BigInt(0)) return wadToStroops(assetsWad);
  const n = assetsWad * stats.shareSupply;
  return (n + stats.totalAssetsWad - BigInt(1)) / stats.totalAssetsWad;
}

/* ---------------------------------- writes --------------------------------- */

export interface TxResult {
  success: boolean;
  hash?: string;
  error?: string;
  /** Decoded return value of the contract call, when any. */
  returnValue?: any;
}

function decodeError(text: string): string {
  // Keep this phrase: retryable() keys on it to re-simulate and resubmit.
  if (/outside of the footprint/i.test(text)) return 'state changed between simulation and execution (outside of the footprint)';
  const m = text.match(/(CreditLayer|Reserve|Oracle|ValidatorFacade|\w+Validator|BlendValuer|MarginAccount): [^"\]\n]+/);
  if (m) return m[0];
  if (/trustline entry is missing/i.test(text)) return 'The wallet has no trustline for this asset.';
  if (/Error\(Contract, #10\)|balance is not sufficient|InsufficientBalance/i.test(text)) return 'Insufficient balance.';
  if (/Error\(Contract, #2\)/.test(text)) return 'Not enough liquidity in the reserve.';
  if (/ExceededLimit|Budget/i.test(text)) return 'The transaction exceeded the network resource limit.';
  return text.length > 300 ? text.slice(0, 300) + '…' : text;
}

function retryable(text: string): boolean {
  return /txBadSeq|TRY_AGAIN_LATER|outside of the footprint|txTooLate/i.test(text);
}

/** Error / log strings from a failed transaction's diagnostic events. */
function diagnosticText(res: any): string {
  const out: string[] = [];
  for (const ev of res?.diagnosticEventsXdr ?? []) {
    try {
      const body = ev.event().body().v0();
      const topics = body.topics().map((t: any) => {
        try {
          return StellarSdk.scValToNative(t);
        } catch {
          return '';
        }
      });
      if (!topics.includes('error')) continue;
      const data = StellarSdk.scValToNative(body.data());
      out.push(Array.isArray(data) ? data.map(String).join(' ') : String(data));
    } catch {
      // not a v0 diagnostic event
    }
  }
  return out.join('; ');
}

/**
 * Ledger of the last transaction this tab submitted. A reserve reads its
 * interest `Curve` only when time has passed since its last accrual, so a tx
 * simulated against the ledger that just accrued (elapsed = 0) misses that key
 * and then fails on-chain one ledger later with "outside of the footprint".
 * Waiting until the network is past our last tx's ledger before simulating the
 * next one makes chained flows (borrow -> deploy, deposit -> repay) safe.
 */
let lastSubmittedLedger = 0;

async function waitPastLedger(s: StellarSdk.rpc.Server, ledger: number): Promise<void> {
  if (!ledger) return;
  for (let i = 0; i < 12; i++) {
    try {
      const latest = await s.getLatestLedger();
      if (latest.sequence > ledger) return;
    } catch {
      // keep waiting
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Builds, simulates, signs (Freighter or Privy) and submits one contract call
 * from the connected wallet, then waits for the result. Retries once on a
 * stale-sequence or footprint race.
 */
export async function invokeWrite(
  contractId: string,
  fn: string,
  args: StellarSdk.xdr.ScVal[],
  label = fn,
): Promise<TxResult> {
  let last: TxResult = { success: false, error: 'not attempted' };
  for (let attempt = 0; attempt < 3; attempt++) {
    last = await invokeOnce(contractId, fn, args, label);
    if (last.success || !retryable(last.error || '')) return last;
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  return last;
}

async function invokeOnce(contractId: string, fn: string, args: StellarSdk.xdr.ScVal[], label: string): Promise<TxResult> {
  try {
    const who = await getAddress();
    if (who.error || !who.address) return { success: false, error: 'Wallet not connected' };
    const s = rpc();
    await waitPastLedger(s, lastSubmittedLedger);
    const account = await s.getAccount(who.address);
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: (parseInt(StellarSdk.BASE_FEE) * 100).toString(),
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(new StellarSdk.Contract(contractId).call(fn, ...args))
      .setTimeout(120)
      .build();

    const sim = await s.simulateTransaction(tx);
    if (StellarSdk.rpc.Api.isSimulationError(sim)) {
      return { success: false, error: decodeError(sim.error) };
    }
    const prepared = StellarSdk.rpc.assembleTransaction(tx, sim).build();
    const signed = await signTransaction(prepared.toXDR(), { networkPassphrase: NETWORK_PASSPHRASE });
    const signedTx = StellarSdk.TransactionBuilder.fromXDR(signed.signedTxXdr, NETWORK_PASSPHRASE) as StellarSdk.Transaction;
    markTxSubmitted();

    let sent = await s.sendTransaction(signedTx);
    for (let i = 0; sent.status === 'TRY_AGAIN_LATER' && i < 3; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      sent = await s.sendTransaction(signedTx);
    }
    if (sent.status === 'ERROR') {
      let code = 'ERROR';
      try {
        code = (sent as any).errorResult?.result?.().switch?.().name ?? code;
      } catch {
        /* keep generic */
      }
      return { success: false, error: `${label} rejected: ${code}` };
    }
    if (sent.status !== 'PENDING' && sent.status !== 'DUPLICATE') {
      return { success: false, error: `${label} rejected: ${sent.status}` };
    }

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const res = await s.getTransaction(sent.hash);
      if (res.status === 'NOT_FOUND') continue;
      lastSubmittedLedger = Math.max(lastSubmittedLedger, Number((res as any).ledger) || 0);
      if (res.status === 'SUCCESS') {
        const rv = (res as any).returnValue;
        return { success: true, hash: sent.hash, returnValue: rv ? StellarSdk.scValToNative(rv) : undefined };
      }
      const why = diagnosticText(res);
      return {
        success: false,
        hash: sent.hash,
        error: `${label} failed on-chain (tx ${sent.hash})${why ? `: ${decodeError(why)}` : ''}`,
      };
    }
    return { success: false, hash: sent.hash, error: `${label} not confirmed in time (tx ${sent.hash})` };
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (/declined|rejected by user|User declined/i.test(msg)) return { success: false, error: 'Transaction was rejected in the wallet.' };
    return { success: false, error: decodeError(msg) };
  }
}

/* ----------------------------- credit-layer calls ---------------------------- */

const CL = () => CREDIT_LAYER_ADDRESSES.CREDIT_LAYER;

export const CreditLayer = {
  createMargin: (trader: string) => invokeWrite(CL(), 'create_margin', [sc.address(trader)], 'Create margin account'),
  depositCollateral: (margin: string, symbol: string, amountWad: bigint | string) =>
    invokeWrite(CL(), 'deposit_collateral', [sc.address(margin), sc.address(tokenAddressFor(symbol)), sc.u256(amountWad)], 'Deposit'),
  withdrawCollateral: (margin: string, symbol: string, amountWad: bigint | string) =>
    invokeWrite(CL(), 'withdraw_collateral', [sc.address(margin), sc.address(tokenAddressFor(symbol)), sc.u256(amountWad)], 'Withdraw'),
  /** Withdraw any token (e.g. an LP share) the margin account holds. */
  withdrawToken: (margin: string, token: string, amountWad: bigint | string) =>
    invokeWrite(CL(), 'withdraw_collateral', [sc.address(margin), sc.address(token), sc.u256(amountWad)], 'Withdraw'),
  borrow: (margin: string, symbol: string, amountWad: bigint | string) =>
    invokeWrite(CL(), 'borrow', [sc.address(margin), sc.address(tokenAddressFor(symbol)), sc.u256(amountWad)], 'Borrow'),
  /** Repays from the margin account's own balance of the token; capped at the debt on-chain. */
  repay: (margin: string, symbol: string, amountWad: bigint | string) =>
    invokeWrite(CL(), 'repay', [sc.address(margin), sc.address(tokenAddressFor(symbol)), sc.u256(amountWad)], 'Repay'),
  execute: (
    margin: string,
    target: string,
    action: ExternalAction,
    tokens: string[],
    amountsWad: (bigint | string | number)[],
    minOut: bigint | string | number = 0,
  ) =>
    invokeWrite(
      CL(),
      'margin_execute',
      [sc.address(margin), sc.address(target), sc.unitEnum(action), sc.addresses(tokens), sc.u128s(amountsWad), sc.u128(minOut)],
      action,
    ),
  /** Closes venue positions and repays debts from what the account holds. */
  unwind: (margin: string) => invokeWrite(CL(), 'unwind_margin', [sc.address(margin)], 'Close position'),
  liquidate: (liquidator: string, margin: string, closeVenues: boolean) =>
    invokeWrite(CL(), 'liquidate', [sc.address(liquidator), sc.address(margin), sc.bool(closeVenues)], 'Liquidate'),
};

export const ReserveCalls = {
  supply: (lender: string, symbol: string, amountWad: bigint | string) =>
    invokeWrite(reserveAddressFor(symbol), 'supply', [sc.address(lender), sc.u256(amountWad)], 'Supply'),
  redeem: (lender: string, symbol: string, sharesWad: bigint | string) =>
    invokeWrite(reserveAddressFor(symbol), 'redeem', [sc.address(lender), sc.u256(sharesWad)], 'Withdraw'),
};

/* ----------------------------------- events ---------------------------------- */

/** Event names the new contracts emit (topic[0]); topic[1] is the margin / lender / trader. */
export const CREDIT_EVENTS = {
  marginCreated: 'margin_created', // topic[1]=trader, data=margin
  deposited: 'collateral_deposited', // data {margin, token, amount WAD}
  withdrawn: 'collateral_withdrawn',
  borrowed: 'borrowed',
  repaid: 'repaid',
  executed: 'margin_executed', // data {margin, target, tokens_in, tokens_out}
  liquidated: 'liquidated', // data {margin, liquidator}
  venuesClosed: 'venues_closed',
  unwound: 'margin_unwound',
  supplied: 'supplied', // reserve; topic[1]=lender, data {lender, assets WAD, shares WAD}
  redeemed: 'redeemed',
} as const;

/** True when `who` is the connected wallet address (helper for UI guards). */
export async function connectedAddress(): Promise<string | null> {
  try {
    const r = await getAddress();
    return r && !r.error && r.address ? r.address : null;
  } catch {
    return null;
  }
}
