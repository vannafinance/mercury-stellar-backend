import { describe, expect, it, vi } from "vitest";

import { evaluateWriteRisk } from "@/lib/copilot/risk";
import type { MCPClient } from "@/lib/copilot/mcp-client";
import type { CopilotAction } from "@/lib/copilot/types";

/**
 * Seen live on 12 Sep 2026: an account at HF 1.27 with a stated floor of 1.30 tried to
 * repay, and the risk gate blocked it with "projected HF 1.27 would breach your floor of
 * 1.30". A repay can only raise HF, so the floor was locking the user out of the one
 * action that gets them back above it — and would block the guardian's auto-repay too.
 */

const COLLATERAL = 6453.76;
const DEBT = 5091.2; // HF = 1.2676, under a 1.30 floor
const XLM_PRICE = 0.18;

vi.mock("@/lib/account-snapshot", () => ({
  computeMarginSnapshot: vi.fn().mockResolvedValue({
    collateralBalances: {},
    borrowedBalances: {},
    totalBorrowedValue: 5091.2,
    totalCollateralValue: 6453.76,
    grossCollateralValue: 6453.76,
    totalValue: 6453.76,
    avgHealthFactor: 6453.76 / 5091.2,
    collateralLeftBeforeLiquidation: 0,
    netAvailableCollateral: 6453.76 - 5091.2,
  }),
}));

function mcp(): MCPClient {
  return {
    async call(tool: string) {
      if (tool === "vanna_get_price") return { price_usd: String(XLM_PRICE) };
      if (tool === "vanna_get_account_health") {
        return {
          collateral_usd: String(COLLATERAL),
          debt_usd: String(DEBT),
          health_factor: String(COLLATERAL / DEBT),
        };
      }
      return {};
    },
  };
}

function action(op: CopilotAction["op"], amount: number): CopilotAction {
  return { op, asset: "XLM", amount, min_hf: 1.3, requires_account: true, requires_amount: true };
}

describe("an account under its floor can still climb out of it", () => {
  it("does not block a repay whose projected HF is above the current HF but still under the floor", async () => {
    // 100 XLM ≈ $18 repaid: (6453.76−18)/(5091.2−18) = 1.2685 — better than 1.2676, still < 1.30
    const { risk, simulation } = await evaluateWriteRisk(mcp(), {
      action: action("repay", 100),
      smartAccount: "CTEST",
      amount: 100,
    });
    expect(simulation!.hf_after!).toBeGreaterThan(simulation!.hf_before!);
    expect(simulation!.hf_after!).toBeLessThan(1.3);
    expect(risk.decision).not.toBe("block");
    expect(risk.reasons.join(" ")).not.toMatch(/would breach your floor/);
  });

  it("does not block a collateral deposit for the same reason", async () => {
    const { risk, simulation } = await evaluateWriteRisk(mcp(), {
      action: action("deposit_collateral", 100),
      smartAccount: "CTEST",
      amount: 100,
    });
    expect(simulation!.hf_after!).toBeGreaterThan(simulation!.hf_before!);
    expect(risk.decision).not.toBe("block");
  });

  it("still blocks a borrow that lands under the floor", async () => {
    const { risk } = await evaluateWriteRisk(mcp(), {
      action: action("borrow", 100),
      smartAccount: "CTEST",
      amount: 100,
    });
    expect(risk.decision).toBe("block");
    expect(risk.reasons.join(" ")).toMatch(/would breach your floor/);
  });
});
