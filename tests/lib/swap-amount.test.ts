import { describe, it, expect } from 'vitest';
import {
  parseTokenAmountToStroops,
  stroopsToAmountString,
  getMaxSwappableBalance,
  amountFromBalancePercent,
  stroopsToWad,
  capAmountToMaxBalance,
} from '@/lib/utils/swap-amount';

// TOKEN_DECIMALS = 7 → 1 token = 1e7 stroops = 10_000_000n

describe('parseTokenAmountToStroops', () => {
  it('parses 1 token to 1e7 stroops', () => {
    expect(parseTokenAmountToStroops('1')).toBe(BigInt(10_000_000));
  });

  it('parses 10 tokens to 1e8 stroops', () => {
    expect(parseTokenAmountToStroops('10')).toBe(BigInt(100_000_000));
  });

  it('parses 1.5 tokens to 15_000_000 stroops', () => {
    expect(parseTokenAmountToStroops('1.5')).toBe(BigInt(15_000_000));
  });

  it('truncates past 7 decimal places (floors)', () => {
    // 1.00000001 → floor to 7 decimals → 1.0000000 = 10_000_000 stroops
    expect(parseTokenAmountToStroops('1.00000001')).toBe(BigInt(10_000_000));
  });

  it('returns 0 for empty or invalid input', () => {
    expect(parseTokenAmountToStroops('')).toBe(BigInt(0));
    expect(parseTokenAmountToStroops('.')).toBe(BigInt(0));
  });

  it('strips commas from formatted amounts', () => {
    // 1,000 tokens = 1000 × 1e7 = 1e10 stroops
    expect(parseTokenAmountToStroops('1,000')).toBe(BigInt(10_000_000_000));
  });
});

describe('stroopsToAmountString', () => {
  it('converts 1e7 stroops to "1"', () => {
    expect(stroopsToAmountString(BigInt(10_000_000))).toBe('1');
  });

  it('converts 1.5 tokens worth of stroops to "1.5"', () => {
    expect(stroopsToAmountString(BigInt(15_000_000))).toBe('1.5');
  });

  it('strips trailing zeros from fractional part', () => {
    // 1.5000000 → '1.5'
    expect(stroopsToAmountString(BigInt(15_000_000))).toBe('1.5');
  });

  it('returns "0" for zero or negative stroops', () => {
    expect(stroopsToAmountString(BigInt(0))).toBe('0');
    expect(stroopsToAmountString(BigInt(-1))).toBe('0');
  });
});

describe('getMaxSwappableBalance', () => {
  it('leaves 1 stroop buffer on a round balance', () => {
    // 1.0 token = 10_000_000 stroops - 1 = 9_999_999 stroops = '0.9999999'
    expect(getMaxSwappableBalance('1')).toBe('0.9999999');
  });

  it('returns "0" for zero balance', () => {
    expect(getMaxSwappableBalance('0')).toBe('0');
  });
});

describe('amountFromBalancePercent', () => {
  it('returns safe max (minus 1 stroop) at 100%', () => {
    // 10 tokens at 100% = 9.9999999
    expect(amountFromBalancePercent('10', 100)).toBe('9.9999999');
  });

  it('returns 0 at 0%', () => {
    expect(amountFromBalancePercent('100', 0)).toBe('0');
  });

  it('returns floor-divided half at 50%', () => {
    // 100 tokens, 50% → 50 tokens (floor division on stroops)
    expect(amountFromBalancePercent('100', 50)).toBe('50');
  });
});

describe('stroopsToWad', () => {
  it('scales 1 token (1e7 stroops) to 1e18 WAD', () => {
    // scale = 18 - 7 = 11; 1e7 * 1e11 = 1e18
    expect(stroopsToWad(BigInt(10_000_000))).toBe(BigInt('1000000000000000000'));
  });

  it('handles 1 stroop correctly (1e11 WAD)', () => {
    expect(stroopsToWad(BigInt(1))).toBe(BigInt(100_000_000_000));
  });
});

describe('capAmountToMaxBalance', () => {
  it('caps amount that exceeds balance', () => {
    // balance = 10 tokens, safe max ≈ 9.9999999
    const result = capAmountToMaxBalance(200, '10');
    expect(result).toBeLessThanOrEqual(10);
    expect(result).toBeGreaterThan(9.99);
  });

  it('passes through amount within balance', () => {
    const result = capAmountToMaxBalance(5, '10');
    expect(result).toBeCloseTo(5, 5);
  });
});
