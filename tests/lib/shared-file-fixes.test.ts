import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoist mocks for network-bound external services used by account-snapshot
const mocks = vi.hoisted(() => ({
  mergeFarmTrackingCollateralIntoBalances: vi.fn().mockResolvedValue({}),
  reconcileMarginRawSacCollateral: vi.fn().mockResolvedValue(0),
  getPoolStats: vi.fn().mockResolvedValue({ utilizationRate: "0.5" }),
}));

vi.mock("@/lib/analytics/stellar/farmTrackingCollateral", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics/stellar/farmTrackingCollateral")>();
  return {
    ...actual,
    mergeFarmTrackingCollateralIntoBalances: mocks.mergeFarmTrackingCollateralIntoBalances,
    reconcileMarginRawSacCollateral: mocks.reconcileMarginRawSacCollateral,
  };
});

vi.mock("@/lib/stellar-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar-utils")>();
  return {
    ...actual,
    ContractService: {
      ...actual.ContractService,
      getPoolStats: mocks.getPoolStats,
    },
  };
});

import {
  computeMarginSnapshot,
  computeMarginSnapshotUncached,
  resetMarginSnapshotCache,
  SnapshotTimeoutError,
  SnapshotUnavailableError,
} from "@/lib/account-snapshot";
import { MarginAccountService } from "@/lib/margin-utils";
import * as oraclePrice from "@/lib/oracle-price";
import { POST as mercuryPost } from "@/app/api/mercury/route";
import { GET as mercuryEventsGet } from "@/app/api/mercury/events/route";
import { NextRequest } from "next/server";

const TEST_ACCOUNT = "CBOQAN5NFII4P5HD73M2IRSFYZSXC5XC76FQWQ5JU7LJAO66TFFPG5XY";

describe("Shared File Fixes", () => {
  beforeEach(() => {
    resetMarginSnapshotCache();
    vi.clearAllMocks();
    mocks.mergeFarmTrackingCollateralIntoBalances.mockResolvedValue({});
    mocks.reconcileMarginRawSacCollateral.mockResolvedValue(0);
    mocks.getPoolStats.mockResolvedValue({ utilizationRate: "0.5" });
  });

  afterEach(() => {
    resetMarginSnapshotCache();
    vi.restoreAllMocks();
  });

  describe("1 & 2. Snapshot Deadline & Inflight Promise Poisoning", () => {
    it("deadline fires: a stalled uncached read throws SnapshotTimeoutError within deadline", async () => {
      vi.spyOn(MarginAccountService, "getCurrentBorrowedBalances").mockImplementation(
        () => new Promise(() => {}), // never resolves
      );
      vi.spyOn(MarginAccountService, "getCollateralBalances").mockImplementation(
        () => new Promise(() => {}),
      );
      vi.spyOn(oraclePrice, "fetchTokenPrices").mockResolvedValue(undefined as any);

      const start = Date.now();
      await expect(
        computeMarginSnapshotUncached(TEST_ACCOUNT, { timeoutMs: 50 }),
      ).rejects.toThrow(SnapshotTimeoutError);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(elapsed).toBeLessThan(500);
    });

    it("inflight promise clears on timeout: second caller starts a fresh read and succeeds", async () => {
      let callCount = 0;
      vi.spyOn(MarginAccountService, "getCurrentBorrowedBalances").mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First call hangs
          return new Promise(() => {});
        }
        // Second call succeeds immediately
        return {
          success: true,
          data: {
            XLM: { amount: "100.000000", usdValue: "12.00" },
          },
        };
      });

      vi.spyOn(MarginAccountService, "getCollateralBalances").mockImplementation(async () => {
        if (callCount === 1) {
          return new Promise(() => {});
        }
        return {
          success: true,
          data: {
            USDC: { amount: "200.000000", usdValue: "200.00" },
          },
        };
      });

      vi.spyOn(oraclePrice, "fetchTokenPrices").mockResolvedValue(undefined as any);
      vi.spyOn(oraclePrice, "getCachedTokenPrice").mockImplementation((token: string) => {
        if (token === "XLM") return 0.12;
        if (token.includes("USDC")) return 1.0;
        return 1.0;
      });

      // Caller 1 times out
      await expect(
        computeMarginSnapshot(TEST_ACCOUNT, { timeoutMs: 50 }),
      ).rejects.toThrow(SnapshotTimeoutError);

      expect(callCount).toBe(1);

      // Caller 2 calls the exact same account after caller 1 timed out.
      // Must NOT return or throw caller 1's expired promise!
      // Must launch a fresh read and succeed.
      const snap2 = await computeMarginSnapshot(TEST_ACCOUNT, { timeoutMs: 500 });
      expect(callCount).toBe(2);
      expect(snap2.totalBorrowedValue).toBeCloseTo(12.0, 1);
      expect(snap2.totalCollateralValue).toBeCloseTo(200.0, 1);
    });

    it("concurrent callers join the same inflight read, and clean up when settled", async () => {
      let callCount = 0;
      vi.spyOn(MarginAccountService, "getCurrentBorrowedBalances").mockImplementation(async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 20));
        return {
          success: true,
          data: {
            XLM: { amount: "50.000000", usdValue: "6.00" },
          },
        };
      });
      vi.spyOn(MarginAccountService, "getCollateralBalances").mockResolvedValue({
        success: true,
        data: {
          USDC: { amount: "100.000000", usdValue: "100.00" },
        },
      });
      vi.spyOn(oraclePrice, "fetchTokenPrices").mockResolvedValue(undefined as any);
      vi.spyOn(oraclePrice, "getCachedTokenPrice").mockReturnValue(1.0);

      const [res1, res2] = await Promise.all([
        computeMarginSnapshot(TEST_ACCOUNT, { timeoutMs: 500 }),
        computeMarginSnapshot(TEST_ACCOUNT, { timeoutMs: 500 }),
      ]);

      expect(callCount).toBe(1);
      expect(res1.totalBorrowedValue).toBe(res2.totalBorrowedValue);

      // Subsequent call after settling starts a fresh read
      await computeMarginSnapshot(TEST_ACCOUNT, { timeoutMs: 500 });
      expect(callCount).toBe(2);
    });
  });

  describe("3. Fail-Closed Debt Balances", () => {
    it("computeMarginSnapshot throws SnapshotUnavailableError when getCurrentBorrowedBalances fails", async () => {
      vi.spyOn(MarginAccountService, "getCurrentBorrowedBalances").mockResolvedValue({
        success: false,
        error: "Failed to read debt balance for token USDC: RPC simulation failed",
      });
      vi.spyOn(MarginAccountService, "getCollateralBalances").mockResolvedValue({
        success: true,
        data: {
          XLM: { amount: "100.000000", usdValue: "12.00" },
        },
      });
      vi.spyOn(oraclePrice, "fetchTokenPrices").mockResolvedValue(undefined as any);

      await expect(
        computeMarginSnapshot(TEST_ACCOUNT, { timeoutMs: 500 }),
      ).rejects.toThrow(SnapshotUnavailableError);
    });

    it("computeMarginSnapshot throws SnapshotUnavailableError when getCollateralBalances fails", async () => {
      vi.spyOn(MarginAccountService, "getCurrentBorrowedBalances").mockResolvedValue({
        success: true,
        data: {},
      });
      vi.spyOn(MarginAccountService, "getCollateralBalances").mockResolvedValue({
        success: false,
        error: "Failed to read collateral balance for token XLM: RPC call failed",
      });
      vi.spyOn(oraclePrice, "fetchTokenPrices").mockResolvedValue(undefined as any);

      await expect(
        computeMarginSnapshot(TEST_ACCOUNT, { timeoutMs: 500 }),
      ).rejects.toThrow(SnapshotUnavailableError);
    });

    it("getCurrentBorrowedBalances returns success: false when one debt leg rejects", async () => {
      const StellarSdk = await import("@stellar/stellar-sdk");
      const validGAddr = StellarSdk.Keypair.random().publicKey();
      vi.spyOn(StellarSdk.rpc.Server.prototype, "getAccount").mockResolvedValue(
        new StellarSdk.Account(validGAddr, "100"),
      );

      let simCall = 0;
      vi.spyOn(StellarSdk.rpc.Server.prototype, "simulateTransaction").mockImplementation(async () => {
        simCall++;
        // First call: get_all_borrowed_tokens
        if (simCall === 1) {
          return {
            result: {
              retval: StellarSdk.nativeToScVal(["XLM", "USDC"]),
            },
          } as any;
        }
        // Second call: get_borrowed_token_debt for XLM -> success
        if (simCall === 2) {
          return {
            result: {
              retval: StellarSdk.nativeToScVal(BigInt("1000000000000000000")), // 1 WAD
            },
          } as any;
        }
        // Third call: get_borrowed_token_debt for USDC -> RPC error or rejected
        return {
          error: "read ECONNRESET",
        } as any;
      });
      vi.spyOn(oraclePrice, "fetchTokenPrice").mockResolvedValue(1.0);

      const res = await MarginAccountService.getCurrentBorrowedBalances(TEST_ACCOUNT, { includePrices: false });
      expect(res.success).toBe(false);
      expect(res.error).toBeDefined();
      expect(res.error).toContain("Failed to read debt balance for token");
    });
  });

  describe("4. Mercury Graceful Degradation when Unconfigured", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
      delete process.env.MERCURY_URL;
      delete process.env.MERCURY_KEY;
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("POST /api/mercury returns 200 with X-Mercury-Configured: 0 and degraded errors", async () => {
      const req = new NextRequest("http://localhost:3000/api/mercury", {
        method: "POST",
        body: JSON.stringify({ query: "{ test }" }),
      });

      const res = await mercuryPost(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Mercury-Configured")).toBe("0");
      expect(res.headers.get("Cache-Control")).toBe("no-store");

      const body = await res.json();
      expect(body.data).toBeNull();
      expect(body.errors[0].extensions.code).toBe("not_configured");
    });

    it("GET /api/mercury/events returns 200 with X-Mercury-Configured: 0 and empty list", async () => {
      const req = new NextRequest("http://localhost:3000/api/mercury/events?contract=C123");

      const res = await mercuryEventsGet(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Mercury-Configured")).toBe("0");
      expect(res.headers.get("Cache-Control")).toBe("no-store");

      const body = await res.json();
      expect(body).toEqual([]);
    });
  });
});
