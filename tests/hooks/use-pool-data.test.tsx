// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ─── Mock the ledger tick so we can control it ────────────────────────────────
let currentTick = 0;
vi.mock("@/contexts/ledger-subscriber", () => ({
  useLedgerTick: () => ({ tick: currentTick, latestLedger: 0 }),
}));

import { usePoolData } from "@/hooks/use-earn";

// usePoolData fetches the cached /api/pools edge route (since D25, #40) — it no
// longer calls ContractService.getPoolStats directly. The previous version of
// this test mocked getPoolStats and timed out because the real fetch hung in
// happy-dom; it now mocks /api/pools to match the actual implementation.
const poolStub = {
  totalSupply: "100.0000000",
  totalBorrowed: "50.0000000",
  availableLiquidity: "50.0000000",
  utilizationRate: "50.00",
  vTokenSupply: "95.0000000",
  supplyAPY: "7.00",
  borrowAPY: "4.50",
  exchangeRate: "1.0526316",
};
const mockPools = {
  XLM: poolStub,
  USDC: poolStub,
};

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe("usePoolData — /api/pools fetch + tick invalidation", () => {
  let qc: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    currentTick = 0;
    fetchMock = vi.fn(
      async () =>
        ({ ok: true, status: 200, json: async () => mockPools }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  });

  afterEach(() => {
    qc.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("fetches /api/pools on mount and populates pools", async () => {
    const { result } = renderHook(usePoolData, { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(fetchMock).toHaveBeenCalledWith("/api/pools");
    expect(result.current.pools.XLM.supplyAPY).toBe("7.00");
    expect(result.current.pools.USDC.exchangeRate).toBe("1.0526316");
  });

  it("does not enter isLoading=true when tick increments (stale-while-revalidate)", async () => {
    const { result, rerender } = renderHook(usePoolData, { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      currentTick = 1;
      rerender();
    });

    // We already have data — a tick triggers a background refetch, not a spinner.
    expect(result.current.isLoading).toBe(false);
  });

  it("re-fetches /api/pools after a tick change (invalidate on tick)", async () => {
    const { rerender } = renderHook(usePoolData, { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const before = fetchMock.mock.calls.length;
    await act(async () => {
      currentTick = 1;
      rerender();
    });

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });
});
