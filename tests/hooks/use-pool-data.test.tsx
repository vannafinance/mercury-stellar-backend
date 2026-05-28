// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ─── Mock the ledger tick so we can control it in tests ───────────────────────
let currentTick = 0;
vi.mock('@/contexts/ledger-subscriber', () => ({
  useLedgerTick: () => ({ tick: currentTick, latestLedger: 0 }),
}));

// ─── Mock pool stats so tests don't hit RPC ───────────────────────────────────
// Note: the object is inlined directly — vi.mock factories are hoisted before
// variable initialisers, so top-level const references would be undefined.
vi.mock('@/lib/stellar-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/stellar-utils')>();
  return {
    ...actual,
    ContractService: {
      ...actual.ContractService,
      getPoolStats: vi.fn().mockResolvedValue({
        totalSupply: '100.0000000',
        totalBorrowed: '50.0000000',
        availableLiquidity: '50.0000000',
        utilizationRate: '50.00',
        vTokenSupply: '95.0000000',
      }),
    },
  };
});

import { usePoolData } from '@/hooks/use-earn';
import { ContractService } from '@/lib/stellar-utils';

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe('usePoolData — tick-driven cache invalidation', () => {
  let qc: QueryClient;

  beforeEach(() => {
    currentTick = 0;
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    qc.clear();
  });

  it('fetches pool stats on initial mount', async () => {
    const { result } = renderHook(usePoolData, { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(ContractService.getPoolStats).toHaveBeenCalled();
  });

  it('calls getPoolStats for all four pools', async () => {
    renderHook(usePoolData, { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(ContractService.getPoolStats).toHaveBeenCalledTimes(4));

    const calledWith = (ContractService.getPoolStats as ReturnType<typeof vi.fn>)
      .mock.calls.map((c: unknown[]) => c[0]);
    expect(calledWith).toContain('XLM');
    expect(calledWith).toContain('USDC');
  });

  it('does not enter isLoading=true when tick increments (stale-while-revalidate)', async () => {
    const { result, rerender } = renderHook(usePoolData, { wrapper: makeWrapper(qc) });

    // Wait for initial data to be populated
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Advance tick — cache is invalidated + refetch triggered
    await act(async () => {
      currentTick = 1;
      rerender();
    });

    // isLoading must stay false (we have stale data — stale-while-revalidate)
    expect(result.current.isLoading).toBe(false);
  });

  it('re-fetches after tick change (invalidate on tick)', async () => {
    const { rerender } = renderHook(usePoolData, { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(ContractService.getPoolStats).toHaveBeenCalledTimes(4));

    const callsBefore = (ContractService.getPoolStats as ReturnType<typeof vi.fn>).mock.calls.length;

    await act(async () => {
      currentTick = 1;
      rerender();
    });

    await waitFor(() => {
      const callsAfter = (ContractService.getPoolStats as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });
});
