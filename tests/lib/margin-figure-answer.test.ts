/**
 * Reported live, three related bugs under one theme ("reply to what was asked, not
 * extra info, and never misread a question as a command"):
 *
 *   1. "What is Collateral Left Before Liquidation of my margin account?" was refused
 *      outright as a restricted keeper/liquidate action — it contains "liquidation
 *      of", indistinguishable from a real command by a bare substring check.
 *   2. "What is Net Available Collateral & Net amount Borrowed of my margin account"
 *      fell through everything to the generic capabilities blurb.
 *   3. Even once routed, a named single-figure question must answer with ONLY that
 *      figure — not the full query_all_positions card.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { routeMessage } from "@/lib/copilot/router";

const mocks = vi.hoisted(() => ({ computeMarginSnapshot: vi.fn() }));
vi.mock("@/lib/account-snapshot", () => ({ computeMarginSnapshot: mocks.computeMarginSnapshot }));

import { handleChat } from "@/lib/copilot/handle";

const base = {
  user_id: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
  smart_account: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  tier: "free" as const,
  surface: "copilot" as const,
};

const snapshot = () => ({
  borrowedBalances: {},
  collateralBalances: {},
  totalBorrowedValue: 315.71,
  totalCollateralValue: 473.82,
  grossCollateralValue: 473.82,
  totalValue: 473.82,
  avgHealthFactor: 1.5,
  collateralLeftBeforeLiquidation: 100.5,
  netAvailableCollateral: 158.11,
  borrowRate: 0,
  debtLimit: 430,
});

describe("a liquidation-threshold question is a read, not a restricted liquidate command", () => {
  it("routes 'collateral left before liquidation' to the margin-figure read", () => {
    const r = routeMessage("What is Collateral Left Before Liquidation of my margin account");
    expect(r.kind).toBe("read");
    if (r.kind === "read") {
      expect(r.template_id).toBe("query_margin_figure");
      expect(r.args?.figures).toContain("collateralLeftBeforeLiquidation");
    }
  });

  it("still refuses a genuine liquidate command", () => {
    for (const ask of ["liquidate my account", "please liquidate this position", "liquidate G" + "A".repeat(55)]) {
      const r = routeMessage(ask);
      expect(r.kind, ask).toBe("restricted");
    }
  });
});

describe("a compound 'X & Y' margin-figure question routes to both figures", () => {
  it("routes 'net available collateral & net amount borrowed' to both figures", () => {
    const r = routeMessage("What is Net Available Collateral & Net amount Borrowed of my margin account");
    expect(r.kind).toBe("read");
    if (r.kind === "read") {
      expect(r.template_id).toBe("query_margin_figure");
      expect(r.args?.figures).toEqual(
        expect.arrayContaining(["netAvailableCollateral", "totalBorrowedValue"]),
      );
    }
  });
});

describe("a borrow-APY question is a pool-stat read, not a borrow write", () => {
  it("routes 'what is borrow APY of XLM lending pool' to a read", () => {
    const r = routeMessage("What is Borrow APY of XLM Lending Pool?");
    expect(r.kind).toBe("read");
  });

  it("still routes a real borrow instruction as a write", () => {
    const r = routeMessage("borrow 50 XLM");
    expect(r.kind).toBe("write");
  });
});

describe("the margin-figure answer names ONLY the requested figure(s)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.computeMarginSnapshot.mockResolvedValue(snapshot());
  });

  it("answers a single figure with exactly one fact, no HF/collateral/borrowed card", async () => {
    const res = await handleChat({
      ...base,
      message: "What is Collateral Left Before Liquidation of my margin account",
    });
    expect(res.kind).toBe("answer");
    expect(res.answer?.facts).toHaveLength(1);
    expect(res.answer?.facts?.[0].label).toBe("collateral left before liquidation");
    expect(res.answer?.facts?.[0].value).toMatch(/100\.5/);
    expect(res.message).not.toMatch(/health factor/i);
  });

  it("answers a compound question with exactly the two named figures", async () => {
    const res = await handleChat({
      ...base,
      message: "What is Net Available Collateral & Net amount Borrowed of my margin account",
    });
    expect(res.kind).toBe("answer");
    const labels = (res.answer?.facts ?? []).map((f) => f.label);
    expect(labels).toEqual(
      expect.arrayContaining(["net available collateral", "amount borrowed"]),
    );
    expect(labels).toHaveLength(2);
  });
});
