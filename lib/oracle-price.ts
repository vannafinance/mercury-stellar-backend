// USD price oracle reads with a short, ledger-aligned cache. Resolves token
// aliases (BLUSDC→USDC, BLEND_XLM→XLM, …) to a base symbol, maps it to a token
// address (toCreditAsset / LP token), then reads the credit-layer oracle
// `get_price(asset, account, Liquidation)` → USD WAD via simulation. A
// per-symbol cache (PRICE_TTL_MS ≈ one ledger) and an in-flight map de-dupe the
// many concurrent reads a single page issues; static fallbacks cover the
// unreachable-oracle case.
//
// Old contract: ORACLE.get_price_latest(symbol) -> (price, decimals). Gone.

import { CREDIT_ASSETS, oraclePriceWad, toCreditAsset, wadToNumber } from './credit-layer';
import { CONTRACT_ADDRESSES } from './stellar-utils';

// UI aliases that name the same asset. Each USDC variant (BLUSDC / SOUSDC) is
// its own token with its own oracle feed, so they are NOT collapsed onto one
// another; plain "USDC" means Blend USDC, as everywhere else. The old Aquarius
// USDC names (AQUSDC / AQUARIUS_USDC) now mean Blend USDC: Aquarius trades it.
const PRICE_ALIASES: Record<string, string> = {
  BLUSDC: 'USDC',
  BLEND_USDC: 'USDC',
  AQUARIUS_USDC: 'USDC',
  AQUSDC: 'USDC',
  SOROSWAP_USDC: 'SOUSDC',
  BLXLM: 'XLM',
  BLEND_XLM: 'XLM',
};

/** Token address the oracle prices for a resolved symbol (credit asset or LP token). */
function assetAddressForSymbol(symbol: string): string | null {
  if (symbol === 'SS_XLM_USDC') return CONTRACT_ADDRESSES.SOROSWAP_XLM_USDC_POOL;
  if (symbol === 'AQ_XLM_USDC') return CONTRACT_ADDRESSES.AQUARIUS_XLM_USDC_SHARE;
  const a = toCreditAsset(symbol);
  return a ? CREDIT_ASSETS[a].token : null;
}

// Static fallbacks used only when the oracle is unreachable on first probe
// (network hiccup before any cache entry exists). Once we have a real price
// it overrides this. Numbers reflect the long-run testnet prices.
const FALLBACK_PRICES: Record<string, number> = {
  XLM: 0.16,
  USDC: 1.0,
  SOUSDC: 1.0,
  /** Rough LP-token USD when oracle has no feed — matches analytics canon. */
  AQ_XLM_USDC: 0.4,
  SS_XLM_USDC: 0.4,
};

// Aligned to the ledger cadence (~5 s) so the price tracks the on-chain oracle
// per ledger close, matching the app-wide tick pattern. Just under one ledger so
// each tick reads fresh while still de-duping multiple same-ledger reads (with
// the inflight map). Revisit on mainnet if oracle RPC cost warrants a longer TTL.
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

async function fetchOnce(symbol: string): Promise<number> {
  const fallback = FALLBACK_PRICES[symbol] ?? 1;
  try {
    const asset = assetAddressForSymbol(symbol);
    if (!asset) throw new Error(`no oracle asset for ${symbol}`);
    const price = wadToNumber(await oraclePriceWad(asset));
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
