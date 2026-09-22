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

import { NextRequest } from "next/server";

import { GET } from "@/app/api/pools/route";

/** The handler reads `?fresh=1` off the request, so every call needs one. */
const req = (url = "http://localhost/api/pools") => new NextRequest(url);

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
  AQUARIUS_USDC: poolStat(),
  SOROSWAP_USDC: poolStat(),
});

describe("GET /api/pools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("200s and passes the AllPoolStats shape through unchanged", async () => {
    const pools = allPools();
    mocks.getAllPoolStats.mockResolvedValue(pools);

    const res = await GET(req());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      ["AQUARIUS_USDC", "SOROSWAP_USDC", "USDC", "XLM"],
    );
    expect(body).toEqual(pools);
    // Each pool carries the enriched fields the Earn page reads.
    for (const key of Object.keys(body)) {
      expect(body[key]).toHaveProperty("supplyAPY");
      expect(body[key]).toHaveProperty("borrowAPY");
      expect(body[key]).toHaveProperty("exchangeRate");
    }
  });

  it("sets a short edge-cache header so post-tx UIs catch up in ~1-2s", async () => {
    mocks.getAllPoolStats.mockResolvedValue(allPools());
    const res = await GET(req());
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=5, stale-while-revalidate=30",
    );
  });

  it("bypasses the CDN entirely on ?fresh=1 (post-tx resync)", async () => {
    mocks.getAllPoolStats.mockResolvedValue(allPools());
    const res = await GET(req("http://localhost/api/pools?fresh=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("502s with pool_stats_failed + no-store when the chain read throws", async () => {
    mocks.getAllPoolStats.mockRejectedValue(new Error("rpc timeout"));

    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = await res.json();
    expect(body.error).toBe("pool_stats_failed");
    expect(body.detail).toBe("rpc timeout"); // Error.message surfaced for ops
  });

  it("502 detail falls back to a string when a non-Error is thrown", async () => {
    mocks.getAllPoolStats.mockRejectedValue("boom");
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect((await res.json()).detail).toBe("pool stats failed");
  });
});
