// Live USD price source for assets used across the app.
// Stablecoins are pegged 1:1 to USD; XLM is fetched live from CoinGecko.

export type SupportedAsset =
  | "XLM"
  | "USDC"
  | "BLUSDC"
  | "AQUSDC"
  | "SOUSDC"
  | "EURC"
  | "AQUARIUS_USDC"
  | "SOROSWAP_USDC";

const STABLE_PRICE_USD: Record<string, number> = {
  USDC: 1.0,
  BLUSDC: 1.0,
  AQUSDC: 1.0,
  SOUSDC: 1.0,
  EURC: 1.0,
  AQUARIUS_USDC: 1.0,
  SOROSWAP_USDC: 1.0,
};

// Fallback used only if the live fetch fails on first load and there is no
// cached value. Kept conservative; will be replaced by a live value within
// seconds of provider mount.
export const XLM_FALLBACK_PRICE = 0.16;

const CACHE_KEY = "vanna:xlmPriceUsd";
const CACHE_TTL_MS = 60_000;

export interface TokenPrices {
  XLM: number;
  USDC: number;
  BLUSDC: number;
  AQUSDC: number;
  SOUSDC: number;
  EURC: number;
  AQUARIUS_USDC: number;
  SOROSWAP_USDC: number;
}

export const buildPrices = (xlmUsd: number): TokenPrices => ({
  XLM: xlmUsd,
  ...(STABLE_PRICE_USD as Omit<TokenPrices, "XLM">),
});

export const getStablePrice = (asset: string): number | undefined =>
  STABLE_PRICE_USD[asset.toUpperCase()];

// Read the last known XLM price from localStorage so the first paint after a
// reload uses the most recent value instead of the fallback constant.
export const readCachedXlmPrice = (): number | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { price: number; ts: number };
    if (typeof parsed.price !== "number" || !isFinite(parsed.price) || parsed.price <= 0) return null;
    return parsed.price;
  } catch {
    return null;
  }
};

const writeCachedXlmPrice = (price: number) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ price, ts: Date.now() }));
  } catch {
    // ignore quota / private mode errors
  }
};

let inFlight: Promise<number> | null = null;
let lastFetched: { price: number; ts: number } | null = null;

export const fetchXlmPriceUsd = async (force = false): Promise<number> => {
  if (!force && lastFetched && Date.now() - lastFetched.ts < CACHE_TTL_MS) {
    return lastFetched.price;
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd",
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
      const data = (await res.json()) as { stellar?: { usd?: number } };
      const price = data?.stellar?.usd;
      if (typeof price !== "number" || !isFinite(price) || price <= 0) {
        throw new Error("Invalid price payload");
      }
      lastFetched = { price, ts: Date.now() };
      writeCachedXlmPrice(price);
      return price;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
};

// Synchronous accessor for non-React code paths (utils, stores). Returns the
// most recently fetched value, or the cached/fallback value if none yet.
export const getXlmPriceUsdSync = (): number => {
  if (lastFetched) return lastFetched.price;
  const cached = readCachedXlmPrice();
  return cached ?? XLM_FALLBACK_PRICE;
};

// Generic accessor for any supported asset, useful for non-React utilities
// that previously read from the per-file TOKEN_PRICES tables.
export const getTokenPriceUsdSync = (asset: string): number => {
  const key = asset?.toUpperCase?.() ?? "";
  if (key === "XLM") return getXlmPriceUsdSync();
  return STABLE_PRICE_USD[key] ?? 1;
};
