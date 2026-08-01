import { describe, it, expect } from 'vitest';
import { buildPrices, getStablePrice } from '@/lib/prices';

describe('buildPrices', () => {
  it('uses the supplied XLM price and pegs USDC to 1', () => {
    const prices = buildPrices(0.25);
    expect(prices.XLM).toBe(0.25);
    expect(prices.USDC).toBe(1);
  });
});

describe('getStablePrice', () => {
  it('returns 1 for known stablecoins (incl. legacy aliases), case-insensitively', () => {
    expect(getStablePrice('USDC')).toBe(1);
    expect(getStablePrice('aqusdc')).toBe(1);
    expect(getStablePrice('Soroswap_USDC')).toBe(1);
    expect(getStablePrice('BLUSDC')).toBe(1);
  });

  it('returns undefined for non-stable assets (e.g. XLM)', () => {
    expect(getStablePrice('XLM')).toBeUndefined();
    expect(getStablePrice('UNKNOWN')).toBeUndefined();
  });
});
