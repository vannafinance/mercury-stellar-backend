import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * A partially-read position must not become a fact.
 *
 * Observed live on the authorised account inside one minute, while the Soroban RPC was
 * returning repeated ECONNRESET: collateral read $4,211.63, then $2,425.78, then **$10.43**,
 * with debt steady at $1,732.61. The last one rendered as "AT RISK · health factor 0.01".
 * Nothing had executed. `computeMarginSnapshot` runs the borrow and collateral scans as two
 * independent calls, so when the collateral side partly fails its total collapses while the
 * debt total survives.
 *
 * The protocol does not let an account hold debt with no collateral — it would already be
 * liquidated — so that shape is a failed read. What these tests pin is that the copilot
 * REFUSES it rather than computing on it: quoting a health factor of 0.01 is a false alarm
 * that pushes someone into an unnecessary repay, and sizing headroom against $10.43 of
 * collateral is not conservative, it is simply wrong.
 */

const snapshot = vi.hoisted(() => vi.fn());
vi.mock("@/lib/account-snapshot", () => ({ computeMarginSnapshot: snapshot }));

const { computeAccountPosition, computeBorrowCapacity } = await import("@/lib/copilot/investigation/capacity");
type MarginSnapshot = NonNullable<Parameters<typeof computeBorrowCapacity>[3]>;

const full = {
  borrowedBalances: { XLM: 7618.379044, BLUSDC: 256.440246 },
  collateralBalances: { SOUSDC: 1381.16, XLM: 3318.22 },
  totalBorrowedValue: 1732.61,
  grossCollateralValue: 4211.63,
  totalCollateralValue: 4211.63,
  totalValue: 2479.02, avgHealthFactor: 2.43,
  collateralLeftBeforeLiquidation: 0, netAvailableCollateral: 0, borrowRate: 0, debtLimit: 0,
} as unknown as MarginSnapshot;

/** The exact live failure: collateral legs missing, debt intact. */
const collapsed = { ...full, collateralBalances: {}, grossCollateralValue: 10.43, totalCollateralValue: 10.43 };

beforeEach(() => snapshot.mockReset());

describe("a position that could not be read fully", () => {
  it("returns no position rather than seeding a 0.01 health factor as evidence", async () => {
    snapshot.mockResolvedValue(collapsed);
    expect(await computeAccountPosition("CACCOUNT")).toBeNull();
  });

  it("refuses to quote headroom against a collapsed collateral read", async () => {
    snapshot.mockResolvedValue(collapsed);
    await expect(computeBorrowCapacity("CACCOUNT", ["keep hf above 1.3"]))
      .rejects.toThrow("position_read_inconsistent");
  });

  it("also refuses when collateral survives but has fallen under the liquidation threshold", async () => {
    // Debt $1,732 against $1,800 gross is HF 1.04 — below 1.10, so a live account should
    // already have been liquidated. Far likelier a half-read than a real position.
    snapshot.mockResolvedValue({ ...full, grossCollateralValue: 1800, collateralBalances: { XLM: 9500 } });
    expect(await computeAccountPosition("CACCOUNT")).toBeNull();
  });

  it("accepts the healthy read and reports it unchanged", async () => {
    snapshot.mockResolvedValue(full);
    const position = await computeAccountPosition("CACCOUNT");
    expect(position).toMatchObject({ grossCollateralUsd: "4211.63", debtUsd: "1732.61" });
    // 4211.63 / 1732.61, full precision — not the 2.43 the rail rounds to.
    expect(position?.healthFactor).toMatch(/^2\.43/);
  });

  it("accepts a debt-free account, where there is nothing to be inconsistent with", async () => {
    snapshot.mockResolvedValue({
      ...full, borrowedBalances: {}, totalBorrowedValue: 0,
      // No collateral positions either — an empty account is a legitimate read.
      collateralBalances: {}, grossCollateralValue: 0,
    });
    const position = await computeAccountPosition("CACCOUNT");
    expect(position).toMatchObject({ debtUsd: "0", healthFactor: null });
  });

  it("reuses a shared snapshot instead of reading the chain twice", async () => {
    snapshot.mockResolvedValue(full);
    await computeBorrowCapacity("CACCOUNT", ["keep hf above 1.3"], undefined, full, {
      contract: { collateralUsd: 4211.63, debtUsd: 1732.61, liquidatable: false },
    });
    // The 5-7s snapshot call is the reason the route was blowing its own deadline.
    expect(snapshot).not.toHaveBeenCalled();
  });
});
