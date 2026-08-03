import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Contract tests for the GET /api/pools route handler.
 *
 * The route is a thin cache+error wrapper over getAllPoolStats (whose math
 * is covered by tests/lib/pool-stats.test.ts). These tests pin the parts the
 * handler itself owns: the success passthrough shape, the edge Cache-Control
 * header (high-hit-rate s-maxage=30), and the 502/no-store error contract.
 */
const mocks = vi.hoisted(() => ({
  getAllPoolStats: vi.fn(),
}));

vi.mock("@/lib/pool-stats", () => ({
  getAllPoolStats: mocks.getAllPoolStats,
}));

import { GET } from "@/app/api/pools/route";

const poolStat = (over: Partial<Record<string, string>> = {}) => ({
  utilizationRate: "47.00",
  totalSupply: "100",
  vTokenSupply: "95",
  supplyAPY: "6.70",
  borrowAPY: "8.00",
  exchangeRate: "1.0526316",
  ...over,
});

const allPools = () => ({
  XLM: poolStat(),
  USDC: poolStat(),
});

describe("GET /api/pools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("200s and passes the AllPoolStats shape through unchanged", async () => {
    const pools = allPools();
    mocks.getAllPoolStats.mockResolvedValue(pools);

    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      ["USDC", "XLM"],
    );
    expect(body).toEqual(pools);
    // Each pool carries the enriched fields the Earn page reads.
    for (const key of Object.keys(body)) {
      expect(body[key]).toHaveProperty("supplyAPY");
      expect(body[key]).toHaveProperty("borrowAPY");
      expect(body[key]).toHaveProperty("exchangeRate");
    }
  });

  it("sets the long edge-cache header (pool stats are identical per user)", async () => {
    mocks.getAllPoolStats.mockResolvedValue(allPools());
    const res = await GET();
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=30, stale-while-revalidate=120",
    );
  });

  it("502s with pool_stats_failed + no-store when the chain read throws", async () => {
    mocks.getAllPoolStats.mockRejectedValue(new Error("rpc timeout"));

    const res = await GET();
    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = await res.json();
    expect(body.error).toBe("pool_stats_failed");
    expect(body.detail).toBe("rpc timeout"); // Error.message surfaced for ops
  });

  it("502 detail falls back to a string when a non-Error is thrown", async () => {
    mocks.getAllPoolStats.mockRejectedValue("boom");
    const res = await GET();
    expect(res.status).toBe(502);
    expect((await res.json()).detail).toBe("pool stats failed");
  });
});
