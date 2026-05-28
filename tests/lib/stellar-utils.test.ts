import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@stellar/freighter-api', () => ({
  requestAccess: vi.fn(),
  getAddress: vi.fn(),
  signTransaction: vi.fn(),
}));

import { ContractService, ASSET_TYPES, AssetType } from '@/lib/stellar-utils';

// ─────────────────────────────────────────────────────────────────────────────
// getPoolStats — aggregation logic
// ─────────────────────────────────────────────────────────────────────────────
describe('ContractService.getPoolStats', () => {
  beforeEach(() => {
    vi.spyOn(ContractService, 'getPoolLiquidity').mockResolvedValue('100.0000000');
    vi.spyOn(ContractService, 'getPoolBorrows').mockResolvedValue('50.0000000');
    vi.spyOn(ContractService, 'getVTokenTotalSupply').mockResolvedValue('90.0000000');
  });

  afterEach(() => vi.restoreAllMocks());

  it('totalSupply = liquidity + borrows', async () => {
    const stats = await ContractService.getPoolStats(ASSET_TYPES.XLM);
    expect(parseFloat(stats.totalSupply)).toBeCloseTo(150, 4);
  });

  it('utilizationRate = borrows / totalSupply × 100', async () => {
    const stats = await ContractService.getPoolStats(ASSET_TYPES.XLM);
    // 50 / 150 × 100 = 33.33...
    expect(parseFloat(stats.utilizationRate)).toBeCloseTo(33.33, 1);
  });

  it('passes through totalBorrowed and availableLiquidity unchanged', async () => {
    const stats = await ContractService.getPoolStats(ASSET_TYPES.USDC);
    expect(stats.totalBorrowed).toBe('50.0000000');
    expect(stats.availableLiquidity).toBe('100.0000000');
    expect(stats.vTokenSupply).toBe('90.0000000');
  });

  it('utilizationRate is 0 when no borrows', async () => {
    vi.spyOn(ContractService, 'getPoolBorrows').mockResolvedValue('0.0000000');
    const stats = await ContractService.getPoolStats(ASSET_TYPES.XLM);
    expect(parseFloat(stats.utilizationRate)).toBe(0);
  });

  it('returns zero-filled stats on partial failure', async () => {
    vi.spyOn(ContractService, 'getPoolLiquidity').mockRejectedValue(new Error('RPC down'));
    const stats = await ContractService.getPoolStats(ASSET_TYPES.XLM);
    expect(stats.totalSupply).toBe('0');
    expect(stats.utilizationRate).toBe('0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPoolStats — forwarded to correct asset type
// ─────────────────────────────────────────────────────────────────────────────
describe('ContractService.getPoolStats — asset routing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('calls sub-methods with the correct asset type for each pool', async () => {
    const liquiditySpy = vi.spyOn(ContractService, 'getPoolLiquidity').mockResolvedValue('0');
    vi.spyOn(ContractService, 'getPoolBorrows').mockResolvedValue('0');
    vi.spyOn(ContractService, 'getVTokenTotalSupply').mockResolvedValue('0');

    const pools: AssetType[] = [
      ASSET_TYPES.XLM,
      ASSET_TYPES.USDC,
      ASSET_TYPES.AQUARIUS_USDC,
      ASSET_TYPES.SOROSWAP_USDC,
    ];

    for (const pool of pools) {
      await ContractService.getPoolStats(pool);
    }

    for (const pool of pools) {
      expect(liquiditySpy).toHaveBeenCalledWith(pool);
    }
  });
});
