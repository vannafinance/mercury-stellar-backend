import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Borrowing headroom, and the two inputs it must never guess.
 *
 * Sizing uses RiskEngine `liquidation_snapshot` (the function that decides
 * liquidation) once that agrees with the app snapshot. Display still uses the
 * app snapshot. The FLOOR has to come from the user's own words.
 */

const mocks = vi.hoisted(() => ({
  computeMarginSnapshot: vi.fn(),
  readLiquidationSnapshot: vi.fn(),
}));
vi.mock("@/lib/account-snapshot", () => ({ computeMarginSnapshot: mocks.computeMarginSnapshot }));
vi.mock("@/lib/copilot/investigation/contract-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/investigation/contract-health")>();
  return { ...actual, readLiquidationSnapshot: mocks.readLiquidationSnapshot };
});

import {
  computeBorrowCapacity,
  reconcileSizingBasis,
} from "@/lib/copilot/investigation/capacity";

const ACCOUNT = "CAHLZMJMMKNC2OUX2334UP3AXWEQFXHOJNQFE26M5MOIDOQNRSHQGLLJ";

/** The live authorised account as dev computes it. */
function snapshot(grossCollateralValue: number, totalBorrowedValue: number) {
  mocks.computeMarginSnapshot.mockResolvedValue({ grossCollateralValue, totalBorrowedValue });
}

function contract(collateralUsd: number, debtUsd: number) {
  return { contract: { collateralUsd, debtUsd, liquidatable: false } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readLiquidationSnapshot.mockRejectedValue(new Error("simulate unavailable"));
});

describe("borrow capacity", () => {
  it("sizes headroom from the contract snapshot when it agrees with the app", async () => {
    snapshot(4219.36, 1736.19);
    const capacity = await computeBorrowCapacity(
      ACCOUNT, ["keep health factor above 1.3 and borrow for me"], undefined, undefined,
      contract(4219.36, 1736.19),
    );

    expect(capacity).toEqual({
      floor: "1.3",
      grossCollateralUsd: "4219.36",
      debtUsd: "1736.19",
      healthFactor: "2.430240929852147518",
      // (4219.36 - 1.3*1736.19) / 0.3
      maxBorrowUsd: "6541.043333333333333333",
    });
  });

  it("sizes from the contract numbers when they differ only by rounding", async () => {
    snapshot(4219.36, 1736.19);
    const capacity = await computeBorrowCapacity(
      ACCOUNT, ["keep health factor above 1.3"], undefined, undefined,
      contract(4219.40, 1736.20),
    );
    expect(capacity?.grossCollateralUsd).toBe("4219.4");
    expect(capacity?.debtUsd).toBe("1736.2");
  });

  it("refuses to quote a size when the Phase 2.5 debt gap shows up", async () => {
    snapshot(4230.94, 1684.99);
    await expect(computeBorrowCapacity(
      ACCOUNT, ["keep health factor above 1.3"], undefined, undefined,
      contract(4230.94, 2705.60),
    )).rejects.toThrow("sizing_sources_disagree");
  });

  it("refuses to size from the app snapshot when the contract read is missing", async () => {
    snapshot(4219.36, 1736.19);
    await expect(computeBorrowCapacity(ACCOUNT, ["keep health factor above 1.3"]))
      .rejects.toThrow("sizing_contract_unavailable");
  });

  it("falls back to a direct contract simulate when MCP does not expose the snapshot", async () => {
    snapshot(4219.36, 1736.19);
    mocks.readLiquidationSnapshot.mockResolvedValue({
      collateralUsd: 4219.36, debtUsd: 1736.19, liquidatable: false, ledger: 4602720,
    });
    const mcp = {
      call: vi.fn(async () => ({
        error: "invalid_input",
        message: "Unknown action 'liquidation_snapshot' for vanna_margin_status.",
      })),
    };
    const capacity = await computeBorrowCapacity(
      ACCOUNT, ["keep health factor above 1.3"], undefined, undefined,
      { mcp, trader: "GTEST" },
    );
    expect(capacity?.maxBorrowUsd).toBe("6541.043333333333333333");
    expect(mocks.readLiquidationSnapshot).toHaveBeenCalledWith(ACCOUNT, expect.anything());
  });

  it("fetches the contract snapshot through MCP when one is not preloaded", async () => {
    snapshot(4219.36, 1736.19);
    const mcp = {
      call: vi.fn(async () => ({
        collateral_usd: "4219.36", debt_usd: "1736.19", liquidatable: false,
        source: "risk_engine.liquidation_snapshot",
      })),
    };
    const capacity = await computeBorrowCapacity(
      ACCOUNT, ["keep health factor above 1.3"], undefined, undefined,
      { mcp, trader: "GTEST" },
    );
    expect(mcp.call).toHaveBeenCalledWith(
      "vanna_get_liquidation_snapshot",
      { smart_account: ACCOUNT },
      "GTEST",
    );
    expect(capacity?.maxBorrowUsd).toBe("6541.043333333333333333");
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
    ], undefined, undefined, contract(4219.36, 1736.19));
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
    const capacity = await computeBorrowCapacity(
      ACCOUNT, ["keep health factor above 1.3"], undefined, undefined, contract(1300, 1000),
    );
    expect(capacity).toMatchObject({ maxBorrowUsd: "0", healthFactor: "1.3" });
  });

  it("omits the health factor when there is no debt to divide by", async () => {
    snapshot(500, 0);
    const capacity = await computeBorrowCapacity(
      ACCOUNT, ["keep health factor above 1.5"], undefined, undefined, contract(500, 0),
    );
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
    await expect(computeBorrowCapacity(
      ACCOUNT, ["keep health factor above 1.3"], undefined, undefined, contract(4219.36, 1736.19),
    )).rejects.toThrow();
  });
});

describe("reconcileSizingBasis", () => {
  it("treats a sub-dollar gap as agreement", () => {
    const result = reconcileSizingBasis(
      { grossCollateralValue: 1000, totalBorrowedValue: 400 },
      { collateralUsd: 1000.25, debtUsd: 400.10, liquidatable: false },
    );
    expect(result.ok).toBe(true);
  });

  it("treats a 60% debt miss as disagreement", () => {
    const result = reconcileSizingBasis(
      { grossCollateralValue: 4230.94, totalBorrowedValue: 1684.99 },
      { collateralUsd: 4230.94, debtUsd: 2705.60, liquidatable: false },
    );
    expect(result).toEqual({ ok: false, reason: "sizing_sources_disagree" });
  });
});
