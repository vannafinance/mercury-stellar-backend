/**
 * Reported live: "Can You Deposit 100 XLM and Borrow BLUSDC & AQUSDC at 3x Leverage" —
 * leg 1 (deposit 100 XLM) settled on-chain, but leg 2 (borrow BLUSDC) was immediately
 * rejected: "Borrow of 30.602352 USDC rejected by risk engine pre-flight check." The same
 * deposit-then-borrow succeeds from the real Margin page, which blocks on
 * `pollTransactionStatus` between every leg (lib/margin-utils.ts) — several seconds of
 * natural ledger-close latency a human's manual clicks get for free. The copilot's
 * multi-leg loop fired leg 2's own on-chain pre-flight the instant MCP returned leg 1's
 * tx_hash, before that deposit had actually closed in a ledger, so the risk engine's own
 * `is_borrow_allowed` read still saw the PRE-deposit collateral.
 *
 * `waitForLedgerClose` (lib/copilot/handle.ts) is the fix: poll the same way
 * `pollTransactionStatus` does — `getTransaction` until its status moves off `NOT_FOUND` —
 * before the next leg runs. These tests pin its polling/backoff/best-effort behaviour
 * directly, since a full end-to-end repro would require faking the risk engine's own
 * on-chain staleness window, which isn't something this test environment can simulate.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ getTransaction: vi.fn() }));
vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {
    // `new StellarSdk.rpc.Server(...)` requires a real constructor function — an arrow-
    // function mock implementation cannot be invoked with `new`.
    Server: vi.fn().mockImplementation(function MockServer() {
      return { getTransaction: mocks.getTransaction };
    }),
  },
}));
vi.mock("@/lib/stellar-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar-utils")>();
  return { ...actual, SOROBAN_RPC_URL: "https://example.test/rpc" };
});

import { waitForLedgerClose } from "@/lib/copilot/handle";

describe("waitForLedgerClose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("returns immediately once the transaction is off NOT_FOUND", async () => {
    mocks.getTransaction.mockResolvedValue({ status: "SUCCESS" });
    await waitForLedgerClose("deadbeef");
    expect(mocks.getTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.getTransaction).toHaveBeenCalledWith("deadbeef");
  });

  it("keeps polling while the transaction is still NOT_FOUND, then returns once it lands", async () => {
    mocks.getTransaction
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValueOnce({ status: "SUCCESS" });
    await waitForLedgerClose("deadbeef");
    expect(mocks.getTransaction).toHaveBeenCalledTimes(3);
  }, 10_000);

  it("a transient RPC error does not abort the wait — it just keeps polling", async () => {
    mocks.getTransaction
      .mockRejectedValueOnce(new Error("rpc hiccup"))
      .mockResolvedValueOnce({ status: "SUCCESS" });
    await expect(waitForLedgerClose("deadbeef")).resolves.toBeUndefined();
    expect(mocks.getTransaction).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("gives up after its attempt cap instead of hanging the plan forever", async () => {
    vi.useFakeTimers();
    try {
      mocks.getTransaction.mockResolvedValue({ status: "NOT_FOUND" });
      const pending = waitForLedgerClose("deadbeef");
      for (let i = 0; i < 8; i++) {
        await vi.advanceTimersByTimeAsync(1500);
      }
      await expect(pending).resolves.toBeUndefined();
      // Best-effort cap, not infinite — a doomed RPC must never strand a multi-leg run.
      expect(mocks.getTransaction.mock.calls.length).toBeGreaterThan(1);
      expect(mocks.getTransaction.mock.calls.length).toBeLessThanOrEqual(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never throws even if getTransaction itself throws on every attempt", async () => {
    vi.useFakeTimers();
    try {
      mocks.getTransaction.mockImplementation(() => {
        throw new Error("should not matter — a wedged RPC is the point");
      });
      const pending = waitForLedgerClose("deadbeef");
      for (let i = 0; i < 8; i++) {
        await vi.advanceTimersByTimeAsync(1500);
      }
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
