import { describe, it, expect, vi } from 'vitest';

// Mock RPC and wallet deps — the pure helpers don't use them
vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  return actual;
});
vi.mock('@stellar/freighter-api', () => ({ signTransaction: vi.fn() }));

import { BlendService } from '@/lib/blend-utils';
import { CONTRACT_ADDRESSES } from '@/lib/stellar-utils';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────
function makeReserve({
  bRateRaw = 1_000_000_000_000,   // 1.0 × SCALAR_12
  bSupplyRaw = 1_000_000_000,     // 100 tokens (SCALAR_7)
  dRateRaw = 1_000_000_000_000,   // 1.0 × SCALAR_12
  dSupplyRaw = 0,
  irModRaw = 10_000_000,          // 1.0 × SCALAR_7
  decimals = 7,
  rBaseRaw = 500_000,             // 5 % base (SCALAR_7)
  rOneRaw = 1_000_000,            // 10 % slope-1
  rTwoRaw = 2_000_000,            // 20 % slope-2
  rThreeRaw = 3_000_000,          // 30 % slope-3
  utilRaw = 7_000_000,            // 70 % target (SCALAR_7)
} = {}) {
  return {
    data: {
      b_rate: bRateRaw,
      b_supply: bSupplyRaw,
      d_rate: dRateRaw,
      d_supply: dSupplyRaw,
      ir_mod: irModRaw,
    },
    config: {
      decimals,
      r_base: rBaseRaw,
      r_one: rOneRaw,
      r_two: rTwoRaw,
      r_three: rThreeRaw,
      util: utilRaw,
    },
  };
}

// Cast to access the static method directly (TypeScript private is compile-time only)
const parseReserveData = (r: ReturnType<typeof makeReserve>) =>
  (BlendService as unknown as { _parseReserveData: (r: unknown) => {
    totalSupply: string; totalBorrow: string; utilizationRate: string;
    supplyAPY: string; borrowAPY: string; bRate: string; decimals: number;
  } })._parseReserveData(r);

// ─────────────────────────────────────────────────────────────────────────────
// _parseReserveData — utilization tiers
// ─────────────────────────────────────────────────────────────────────────────
describe('BlendService._parseReserveData', () => {
  describe('zero utilization', () => {
    it('utilizationRate is 0.00', () => {
      const { utilizationRate } = parseReserveData(makeReserve({ dSupplyRaw: 0 }));
      expect(utilizationRate).toBe('0.00');
    });

    it('supplyAPY is 0 when no borrowers', () => {
      const { supplyAPY } = parseReserveData(makeReserve({ dSupplyRaw: 0 }));
      expect(parseFloat(supplyAPY)).toBe(0);
    });

    it('borrowAPY reflects base rate (≥ 5% APY for 5% APR)', () => {
      const { borrowAPY } = parseReserveData(makeReserve({ dSupplyRaw: 0 }));
      expect(parseFloat(borrowAPY)).toBeGreaterThanOrEqual(5);
    });
  });

  describe('Tier 1 — below target utilization (50%, target=70%)', () => {
    it('utilizationRate is 50.00', () => {
      const { utilizationRate } = parseReserveData(
        makeReserve({ dSupplyRaw: 500_000_000 }) // 50 tokens borrowed
      );
      expect(utilizationRate).toBe('50.00');
    });

    it('supplyAPY > 0', () => {
      const { supplyAPY } = parseReserveData(makeReserve({ dSupplyRaw: 500_000_000 }));
      expect(parseFloat(supplyAPY)).toBeGreaterThan(0);
    });

    it('borrowAPY > borrowAPY at zero util', () => {
      const atZero = parseFloat(parseReserveData(makeReserve()).borrowAPY);
      const atHalf = parseFloat(
        parseReserveData(makeReserve({ dSupplyRaw: 500_000_000 })).borrowAPY
      );
      expect(atHalf).toBeGreaterThan(atZero);
    });
  });

  describe('Tier 2 — between target and 95% utilization (80%)', () => {
    it('utilizationRate is 80.00', () => {
      const { utilizationRate } = parseReserveData(
        makeReserve({ dSupplyRaw: 800_000_000 })
      );
      expect(utilizationRate).toBe('80.00');
    });

    it('borrowAPY higher than at 50% utilization', () => {
      const at50 = parseFloat(
        parseReserveData(makeReserve({ dSupplyRaw: 500_000_000 })).borrowAPY
      );
      const at80 = parseFloat(
        parseReserveData(makeReserve({ dSupplyRaw: 800_000_000 })).borrowAPY
      );
      expect(at80).toBeGreaterThan(at50);
    });
  });

  describe('Tier 3 — above 95% utilization (97%)', () => {
    it('utilizationRate is 97.00', () => {
      const { utilizationRate } = parseReserveData(
        makeReserve({ dSupplyRaw: 970_000_000 })
      );
      expect(utilizationRate).toBe('97.00');
    });

    it('borrowAPY is significantly higher than at 80%', () => {
      const at80 = parseFloat(
        parseReserveData(makeReserve({ dSupplyRaw: 800_000_000 })).borrowAPY
      );
      const at97 = parseFloat(
        parseReserveData(makeReserve({ dSupplyRaw: 970_000_000 })).borrowAPY
      );
      expect(at97).toBeGreaterThan(at80 * 1.5);
    });
  });

  describe('output fields', () => {
    it('bRate reflects exchange rate correctly (1.05 × SCALAR_12)', () => {
      const reserve = makeReserve({ bRateRaw: 1_050_000_000_000 }); // 1.05
      const { bRate } = parseReserveData(reserve);
      expect(parseFloat(bRate)).toBeCloseTo(1.05, 5);
    });

    it('totalSupply = bTokens × bRate in token units', () => {
      // 100 tokens supply × 1.0 rate = 100
      const { totalSupply } = parseReserveData(makeReserve());
      expect(parseFloat(totalSupply)).toBeCloseTo(100, 2);
    });

    it('totalBorrow = dTokens × dRate in token units', () => {
      const { totalBorrow } = parseReserveData(makeReserve({ dSupplyRaw: 500_000_000 }));
      expect(parseFloat(totalBorrow)).toBeCloseTo(50, 2);
    });

    it('supplyAPY never exceeds borrowAPY', () => {
      for (const dSupplyRaw of [0, 300_000_000, 700_000_000, 950_000_000]) {
        const { supplyAPY, borrowAPY } = parseReserveData(makeReserve({ dSupplyRaw }));
        expect(parseFloat(supplyAPY)).toBeLessThanOrEqual(parseFloat(borrowAPY));
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildExternalProtocolCallBytes — structural checks
// ─────────────────────────────────────────────────────────────────────────────
describe('BlendService.buildExternalProtocolCallBytes', () => {
  const poolAddr = CONTRACT_ADDRESSES.BLEND_POOL;
  const marginAddr = CONTRACT_ADDRESSES.ACCOUNT_MANAGER; // real address with valid checksum
  const amount = BigInt('100000000000000000000'); // 100 tokens in WAD

  it('returns a non-empty Buffer for Deposit action', () => {
    const buf = BlendService.buildExternalProtocolCallBytes(
      poolAddr, 'Deposit', 'XLM', amount, marginAddr
    );
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.byteLength).toBeGreaterThan(0);
  });

  it('returns a non-empty Buffer for Withdraw action', () => {
    const buf = BlendService.buildExternalProtocolCallBytes(
      poolAddr, 'Withdraw', 'USDC', amount, marginAddr
    );
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.byteLength).toBeGreaterThan(0);
  });

  it('Deposit and Withdraw produce different XDR bytes (action is encoded)', () => {
    const deposit = BlendService.buildExternalProtocolCallBytes(
      poolAddr, 'Deposit', 'XLM', amount, marginAddr
    );
    const withdraw = BlendService.buildExternalProtocolCallBytes(
      poolAddr, 'Withdraw', 'XLM', amount, marginAddr
    );
    expect(deposit.equals(withdraw)).toBe(false);
  });
});
