import { describe, it, expect } from 'vitest';
import { buildPrices, getStablePrice } from '@/lib/prices';

describe('buildPrices', () => {
  it('uses the supplied XLM price and pegs every stablecoin to 1', () => {
    const prices = buildPrices(0.25);
    expect(prices.XLM).toBe(0.25);
    expect(prices.USDC).toBe(1);
    expect(prices.BLUSDC).toBe(1);
    expect(prices.AQUSDC).toBe(1);
    expect(prices.SOUSDC).toBe(1);
    expect(prices.AQUARIUS_USDC).toBe(1);
    expect(prices.SOROSWAP_USDC).toBe(1);
  });
});

describe('getStablePrice', () => {
  it('returns 1 for known stablecoins, case-insensitively', () => {
    expect(getStablePrice('USDC')).toBe(1);
    expect(getStablePrice('aqusdc')).toBe(1);
    expect(getStablePrice('Soroswap_USDC')).toBe(1);
  });

  it('returns undefined for non-stable assets (e.g. XLM)', () => {
    expect(getStablePrice('XLM')).toBeUndefined();
    expect(getStablePrice('UNKNOWN')).toBeUndefined();
  });
});
