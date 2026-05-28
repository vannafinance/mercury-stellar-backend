import { describe, it, expect } from 'vitest';
import { computeBorrowApr, RATE_MODEL_PARAMS } from '@/lib/utils/borrow-rate';

const { baseRate, optimalUtil, slope1, slope2 } = RATE_MODEL_PARAMS;

describe('computeBorrowApr', () => {
  it('returns base rate at zero utilization', () => {
    expect(computeBorrowApr(0)).toBe(baseRate);
  });

  it('returns base rate for negative utilization', () => {
    expect(computeBorrowApr(-10)).toBe(baseRate);
  });

  it('returns base + full slope1 at optimal utilization (kink point)', () => {
    expect(computeBorrowApr(optimalUtil)).toBe(baseRate + slope1);
  });

  it('returns linearly interpolated rate below kink', () => {
    const halfUtil = optimalUtil / 2;
    const expected = baseRate + (halfUtil / optimalUtil) * slope1;
    expect(computeBorrowApr(halfUtil)).toBeCloseTo(expected, 6);
  });

  it('returns maximum rate at 100% utilization', () => {
    const expected = baseRate + slope1 + slope2;
    expect(computeBorrowApr(100)).toBeCloseTo(expected, 6);
  });

  it('caps utilization at 100 for values above 100', () => {
    expect(computeBorrowApr(200)).toBe(computeBorrowApr(100));
  });

  it('rate increases monotonically from 0 to 100', () => {
    const rates = [0, 20, 40, 60, 80, 90, 100].map((u) => computeBorrowApr(u));
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i]).toBeGreaterThanOrEqual(rates[i - 1]);
    }
  });

  it('returns a finite number for all reasonable inputs', () => {
    for (const u of [0, 25, 50, 75, 80, 90, 95, 100]) {
      expect(Number.isFinite(computeBorrowApr(u))).toBe(true);
    }
  });
});
