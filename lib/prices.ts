// USD price helpers for assets used across the app. XLM is sourced live from
// the on-chain Reflector oracle (see lib/oracle-price.ts); stablecoins peg 1:1.

const STABLE_PRICE_USD: Record<string, number> = {
  USDC: 1.0,
  BLUSDC: 1.0,
  AQUSDC: 1.0,
  SOUSDC: 1.0,
  AQUARIUS_USDC: 1.0,
  SOROSWAP_USDC: 1.0,
};

export interface TokenPrices {
  XLM: number;
  USDC: number;
  BLUSDC: number;
  AQUSDC: number;
  SOUSDC: number;
  AQUARIUS_USDC: number;
  SOROSWAP_USDC: number;
}

export const buildPrices = (xlmUsd: number): TokenPrices => ({
  XLM: xlmUsd,
  ...(STABLE_PRICE_USD as Omit<TokenPrices, "XLM">),
});

export const getStablePrice = (asset: string): number | undefined =>
  STABLE_PRICE_USD[asset.toUpperCase()];
