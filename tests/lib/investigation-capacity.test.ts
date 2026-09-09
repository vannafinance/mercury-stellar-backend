import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Borrowing headroom, and the two inputs it must never guess.
 *
 * The BASE has to be the app's own `grossCollateralValue` — the figure `margin-health.ts`
 * divides by debt, confirmed by the owner as dev's correct number. MCP's `account_health`
 * reports a materially different collateral total for the same account at the same ledger
 * (measured 4,219.36 vs 3,164.34), so quoting headroom off the MCP read would size against
 * a base nothing else in the product agrees with.
 *
 * The FLOOR has to come from the user's own words. Inventing 1.3 for someone who never
 * asked for it fabricates the most important input of the calculation, so no floor means
 * no answer rather than a default one.
 */

const mocks = vi.hoisted(() => ({ computeMarginSnapshot: vi.fn() }));
vi.mock("@/lib/account-snapshot", () => ({ computeMarginSnapshot: mocks.computeMarginSnapshot }));

import { computeBorrowCapacity } from "@/lib/copilot/investigation/capacity";

const ACCOUNT = "CAHLZMJMMKNC2OUX2334UP3AXWEQFXHOJNQFE26M5MOIDOQNRSHQGLLJ";

/** The live authorised account as dev computes it. */
function snapshot(grossCollateralValue: number, totalBorrowedValue: number) {
  mocks.computeMarginSnapshot.mockResolvedValue({ grossCollateralValue, totalBorrowedValue });
}

beforeEach(() => vi.clearAllMocks());

describe("borrow capacity", () => {
  it("sizes headroom from the app's gross collateral and the user's stated floor", async () => {
    snapshot(4219.36, 1736.19);
    const capacity = await computeBorrowCapacity(ACCOUNT, ["keep health factor above 1.3 and borrow for me"]);

    expect(capacity).toEqual({
      floor: "1.3",
      grossCollateralUsd: "4219.36",
      debtUsd: "1736.19",
      healthFactor: "2.430240929852147518",
      // (4219.36 - 1.3*1736.19) / 0.3
      maxBorrowUsd: "6541.043333333333333333",
    });
  });

  it("returns nothing when the user never stated a floor", async () => {
    snapshot(4219.36, 1736.19);
    expect(await computeBorrowCapacity(ACCOUNT, ["swap 10 XLM to AQUSDC then add liquidity"])).toBeNull();
    // The authoritative read is not even attempted; there is nothing to size against.
    expect(mocks.computeMarginSnapshot).not.toHaveBeenCalled();
  });

  it("takes the latest floor the user gave, not the first", async () => {
    snapshot(4219.36, 1736.19);
    const capacity = await computeBorrowCapacity(ACCOUNT, [
      "build a strategy keeping health factor above 1.3",
      "actually keep health factor above 2.0",
    ]);
    expect(capacity?.floor).toBe("2");
    // (4219.36 - 2*1736.19) / 1 = 746.98
    expect(capacity?.maxBorrowUsd).toBe("746.98");
  });

  it("refuses a floor at or under the liquidation threshold", async () => {
    snapshot(4219.36, 1736.19);
    for (const message of ["keep health factor above 1.1", "keep health factor above 1.05"]) {
      expect(await computeBorrowCapacity(ACCOUNT, [message])).toBeNull();
    }
    expect(mocks.computeMarginSnapshot).not.toHaveBeenCalled();
  });

  it("reports zero headroom rather than a negative number when already at the floor", async () => {
    snapshot(1300, 1000);
    const capacity = await computeBorrowCapacity(ACCOUNT, ["keep health factor above 1.3"]);
    expect(capacity).toMatchObject({ maxBorrowUsd: "0", healthFactor: "1.3" });
  });

  it("omits the health factor when there is no debt to divide by", async () => {
    snapshot(500, 0);
    const capacity = await computeBorrowCapacity(ACCOUNT, ["keep health factor above 1.5"]);
    expect(capacity?.healthFactor).toBeNull();
    // With no debt, capacity is G/(F-1) = 500/0.5 = 1000.
    expect(capacity?.maxBorrowUsd).toBe("1000");
  });

  it("returns nothing without a smart account instead of sizing against zero", async () => {
    expect(await computeBorrowCapacity(null, ["keep health factor above 1.3"])).toBeNull();
    expect(mocks.computeMarginSnapshot).not.toHaveBeenCalled();
  });

  it("propagates a failed position read instead of reporting no headroom", async () => {
    mocks.computeMarginSnapshot.mockRejectedValue(new Error("RPC unavailable"));
    // The caller turns this into an explicit warning; silently returning null here would
    // render as "you have no headroom", which is a different and wrong claim.
    await expect(computeBorrowCapacity(ACCOUNT, ["keep health factor above 1.3"])).rejects.toThrow();
  });
});
