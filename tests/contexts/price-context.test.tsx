// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import React from 'react';

// ─── Control the ledger tick ─────────────────────────────────────────────────
let currentTick = 0;
vi.mock('@/contexts/ledger-subscriber', () => ({
  useLedgerTick: () => ({ tick: currentTick, latestLedger: 0 }),
}));

// ─── Mock the on-chain Reflector oracle so the provider never hits RPC ────────
// (and, critically, never CoinGecko). Inlined per the vi.mock hoisting rule.
vi.mock('@/lib/oracle-price', () => ({
  fetchTokenPrice: vi.fn().mockResolvedValue(0.25),
  getCachedTokenPrice: vi.fn().mockReturnValue(0.16),
}));

import { PriceProvider, useTokenPrices } from '@/contexts/price-context';
import { fetchTokenPrice, getCachedTokenPrice } from '@/lib/oracle-price';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

function Wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(PriceProvider, null, children);
}

describe('PriceProvider — XLM sourced from the Reflector oracle (not CoinGecko)', () => {
  beforeEach(() => {
    currentTick = 0;
    vi.clearAllMocks();
    asMock(getCachedTokenPrice).mockReturnValue(0.16);
    asMock(fetchTokenPrice).mockResolvedValue(0.25);
  });

  it('seeds the synchronous initial price from the oracle cache', async () => {
    const { result } = renderHook(() => useTokenPrices(), { wrapper: Wrapper });
    // First paint reads getCachedTokenPrice("XLM") — no async, no fallback const.
    expect(getCachedTokenPrice).toHaveBeenCalledWith('XLM');
    await waitFor(() => expect(result.current.xlmUsd).toBe(0.25));
  });

  it('fetches the live XLM price from the oracle on mount', async () => {
    const { result } = renderHook(() => useTokenPrices(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.xlmUsd).toBe(0.25));
    expect(fetchTokenPrice).toHaveBeenCalledWith('XLM');
  });

  it('never calls CoinGecko / global fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useTokenPrices(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.xlmUsd).toBe(0.25));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('prices XLM from the oracle and stablecoins at 1 via getPrice', async () => {
    const { result } = renderHook(() => useTokenPrices(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.xlmUsd).toBe(0.25));

    expect(result.current.getPrice('XLM')).toBe(0.25);
    expect(result.current.getPrice('USDC')).toBe(1);
    expect(result.current.getPrice('AQUARIUS_USDC')).toBe(1);
    expect(result.current.prices.XLM).toBe(0.25);
    expect(result.current.prices.USDC).toBe(1);
  });

  it('refreshes the XLM price from the oracle on each ledger tick', async () => {
    const { result, rerender } = renderHook(() => useTokenPrices(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.xlmUsd).toBe(0.25));
    const callsBefore = asMock(fetchTokenPrice).mock.calls.length;

    asMock(fetchTokenPrice).mockResolvedValue(0.3);
    await act(async () => {
      currentTick = 1;
      rerender();
    });

    await waitFor(() => expect(result.current.xlmUsd).toBe(0.3));
    expect(asMock(fetchTokenPrice).mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
