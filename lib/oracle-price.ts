// USD price oracle reads with a short, ledger-aligned cache. Resolves token
// aliases (legacy BLUSDC/AQUSDC/SOUSDC → USDC, BLEND_XLM→XLM, …) to a base
// symbol, then reads `get_price_latest` off the on-chain oracle via simulation.
// A per-symbol cache (PRICE_TTL_MS ≈ one ledger) and an in-flight map de-dupe
// the many concurrent reads a single page issues; static fallbacks cover the
// unreachable-oracle case.

import * as StellarSdk from '@stellar/stellar-sdk';
import { CONTRACT_ADDRESSES, NETWORK_PASSPHRASE, SOROBAN_RPC_URL } from './stellar-utils';

// Tokens without their own oracle entry are priced off a base symbol that
// represents the same underlying USD value. Mainnet: single Circle USDC;
// legacy testnet variant aliases still resolve here for safety.
const PRICE_ALIASES: Record<string, string> = {
  BLUSDC: 'USDC',
  BLEND_USDC: 'USDC',
  AQUSDC: 'USDC',
  AQUARIUS_USDC: 'USDC',
  SOUSDC: 'USDC',
  SOROSWAP_USDC: 'USDC',
  AqUSDC: 'USDC',
  SoUSDC: 'USDC',
  BLXLM: 'XLM',
  BLEND_XLM: 'XLM',
};

// Static fallbacks used only when the oracle is unreachable on first probe
// (network hiccup before any cache entry exists). Once we have a real price
// it overrides this.
const FALLBACK_PRICES: Record<string, number> = {
  XLM: 0.16,
  USDC: 1.0,
  /** Rough LP-token USD when oracle has no feed — matches analytics canon. */
  AQ_XLM_USDC: 0.4,
  SS_XLM_USDC: 0.4,
};

// Aligned to the ledger cadence (~5 s) so the price tracks the on-chain oracle
// per ledger close, matching the app-wide tick pattern. Just under one ledger so
// each tick reads fresh while still de-duping multiple same-ledger reads (with
// the inflight map).
const PRICE_TTL_MS = 4_000;
// On error we cache the fallback briefly so a flaky RPC doesn't trigger a
// flood of retries from every component on the page.
const ERROR_TTL_MS = 5_000;

interface CacheEntry {
  price: number;
  expiresAt: number;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<number>>();
const subscribers = new Set<() => void>();

const resolveSymbol = (token: string): string => {
  const u = (token || '').toUpperCase().trim();
  return PRICE_ALIASES[u] ?? u;
};

const notify = () => {
  for (const cb of subscribers) {
    try { cb(); } catch { /* ignore subscriber errors */ }
  }
};

// Funded mainnet G-account for simulation source when no wallet is connected
// (`vanna_mainnet_deployer`). Prefer the connected wallet when available.
const FALLBACK_SOURCE = 'GDT7ZBFWPYUY44QOA5TH3TGUYNPP6R5CF7EVXNYIW4U2ZQBUZ5NM3WYP';

async function buildSimulationTx(
  server: StellarSdk.rpc.Server,
  symbol: string
): Promise<StellarSdk.Transaction> {
  let sourceAddr = FALLBACK_SOURCE;
  try {
    const { getAddress } = await import('@/lib/wallet-adapter');
    const got = await getAddress();
    if (!got.error && got.address) sourceAddr = got.address;
  } catch {
    // Freighter unavailable in SSR / non-browser — use the fallback source.
  }
  const src = await server.getAccount(sourceAddr);
  const c = new StellarSdk.Contract(CONTRACT_ADDRESSES.ORACLE);
  return new StellarSdk.TransactionBuilder(src, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(c.call('get_price_latest', StellarSdk.nativeToScVal(symbol, { type: 'symbol' })))
    .setTimeout(30)
    .build();
}

async function fetchOnce(symbol: string): Promise<number> {
  const fallback = FALLBACK_PRICES[symbol] ?? 1;
  try {
    const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
    const tx = await buildSimulationTx(server, symbol);
    const r = await server.simulateTransaction(tx);
    if (!('result' in r) || !r.result?.retval) throw new Error('oracle simulation returned no result');
    const native = StellarSdk.scValToNative(r.result.retval) as [bigint | string | number, number];
    const rawPrice = native[0];
    const decimals = Number(native[1] ?? 14);
    const priceStr = typeof rawPrice === 'bigint' ? rawPrice.toString() : String(rawPrice);
    const price = Number(priceStr) / Math.pow(10, decimals);
    if (!Number.isFinite(price) || price <= 0) throw new Error('oracle returned non-positive price');
    cache.set(symbol, { price, expiresAt: Date.now() + PRICE_TTL_MS, fetchedAt: Date.now() });
    notify();
    return price;
  } catch {
    const existing = cache.get(symbol);
    const cachedPrice = existing?.price ?? fallback;
    cache.set(symbol, { price: cachedPrice, expiresAt: Date.now() + ERROR_TTL_MS, fetchedAt: existing?.fetchedAt ?? 0 });
    return cachedPrice;
  }
}

/**
 * Resolve a token's USD price, preferring the fresh cache, then an in-flight
 * read, then a new oracle simulation. Aliases are resolved first, so e.g.
 * `BLUSDC` and `USDC` share one cache entry / one network read. Never throws —
 * on oracle failure it returns the last good price (or a static fallback) and
 * caches that briefly to dampen retry storms.
 */
export async function fetchTokenPrice(token: string): Promise<number> {
  const symbol = resolveSymbol(token);
  const cached = cache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) return cached.price;
  const ongoing = inflight.get(symbol);
  if (ongoing) return ongoing;
  const p = fetchOnce(symbol).finally(() => inflight.delete(symbol));
  inflight.set(symbol, p);
  return p;
}

/**
 * Batch variant of {@link fetchTokenPrice}. Upper-cases + de-dupes the input
 * symbols and resolves them concurrently; returns a `symbol → price` map keyed
 * by the de-duped (uppercased) symbol, not the alias-resolved base.
 */
export async function fetchTokenPrices(tokens: string[]): Promise<Record<string, number>> {
  const unique = Array.from(new Set(tokens.map((t) => (t || '').toUpperCase().trim()).filter(Boolean)));
  const entries = await Promise.all(
    unique.map(async (t) => [t, await fetchTokenPrice(t)] as const)
  );
  return Object.fromEntries(entries);
}

/**
 * Synchronous price read for code that can't await (render paths, formatters).
 * Returns the last cached price even if expired — staleness is acceptable here
 * — and falls back to the static table only when nothing was ever fetched for
 * this symbol. Does not trigger a network read; pair with {@link primeTokenPrices}.
 */
export function getCachedTokenPrice(token: string): number {
  const symbol = resolveSymbol(token);
  const cached = cache.get(symbol);
  if (cached && cached.price > 0) return cached.price;
  return FALLBACK_PRICES[symbol] ?? 1;
}

/**
 * Fire-and-forget cache warm-up: kicks off background reads for the given
 * symbols without awaiting. Use from non-React contexts (stores, page roots) so
 * a later {@link getCachedTokenPrice} has fresh data.
 */
export function primeTokenPrices(tokens: string[]): void {
  for (const t of tokens) {
    void fetchTokenPrice(t);
  }
}

/**
 * Subscribe to price-cache updates; `cb` fires after each successful oracle
 * fetch. Returns an unsubscribe function. Used by React stores to re-render
 * when a background refresh lands a new price.
 */
export function subscribePriceUpdates(cb: () => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}
