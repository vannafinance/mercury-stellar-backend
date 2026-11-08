/**
 * Reported live (25 Sep): the copilot answered "health factor 1.78" while the sidebar showed
 * 2.28 for the same account. `vanna_get_account_health` returns no `health_factor`; the
 * copilot derived one as collateral × `liquidation_threshold` / debt. That field is an LTV
 * bound (~0.909 = 1/1.1), not a collateral discount, so every derived HF was the product's
 * ratio divided by 1.1. The risk gate then compared that discounted figure against 1.0 while
 * its own projections used the plain ratio, so a write landing at HF 1.05 passed the hard
 * block even though the RiskEngine liquidates at or below 1.10.
 *
 * The fixture is the live payload shape (vanna_mcp borrow_tools.py), not a trimmed one.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/account-snapshot", () => ({ computeMarginSnapshot: vi.fn().mockResolvedValue(null) }));

import { factsForUi, groundedReadSentence } from "@/lib/copilot/explain";
import { evaluateWriteRisk } from "@/lib/copilot/risk";
import { LIQUIDATION_THRESHOLD } from "@/lib/margin-health";
import type { MCPClient } from "@/lib/copilot/mcp-client";
import type { CopilotAction } from "@/lib/copilot/types";

const PRICE = 0.2;

function livePayload(collateral: number, debt: number): Record<string, unknown> {
  const ltv = debt / collateral;
  return {
    smart_account: "CTEST",
    collateral_usd: String(collateral),
    debt_usd: String(debt),
    ltv_ratio: ltv.toFixed(4),
    is_healthy: ltv < 1 / LIQUIDATION_THRESHOLD,
    distance_to_liquidation: (1 / LIQUIDATION_THRESHOLD - ltv).toFixed(4),
    borrow_threshold: (1 / LIQUIDATION_THRESHOLD).toFixed(4),
    liquidation_threshold: (1 / LIQUIDATION_THRESHOLD).toFixed(4),
  };
}

function mcp(collateral: number, debt: number): MCPClient {
  return {
    async call(tool: string) {
      if (tool === "vanna_get_price") return { price_usd: String(PRICE) };
      if (tool === "vanna_get_account_health") return livePayload(collateral, debt);
      return {};
    },
  };
}

const withdraw = (amount: number): CopilotAction => ({
  op: "withdraw_collateral", asset: "XLM", amount, requires_account: true, requires_amount: true,
});

describe("health factor from the live account-health payload is the product's plain ratio", () => {
  it("reads the same figure the sidebar shows, in the answer and in the facts", () => {
    const data = livePayload(456, 200);
    expect(groundedReadSentence("vanna_get_account_health", data)).toContain("health factor 2.28");
    expect(factsForUi(data)["health factor"]).toBeCloseTo(456 / 200, 3);
  });

  it("uses one formula before and after a write", async () => {
    const { simulation } = await evaluateWriteRisk(mcp(456, 200), { action: withdraw(10), smartAccount: "CTEST", amount: 10 });
    expect(simulation!.hf_before).toBeCloseTo(456 / 200, 4);
    expect(simulation!.hf_after).toBeCloseTo((456 - 10 * PRICE) / 200, 4);
    expect(simulation!.liquidation_threshold).toBe(LIQUIDATION_THRESHOLD);
  });

  it("blocks a write that lands at or below the liquidation line, not only below 1.0", async () => {
    // 220 collateral / 200 debt = 1.10 before; withdrawing $10 lands at 1.05.
    const below = await evaluateWriteRisk(mcp(230, 200), { action: withdraw(100), smartAccount: "CTEST", amount: 100 });
    expect(below.risk.projected_health_factor).toBeCloseTo(1.05, 3);
    expect(below.risk.decision).toBe("block");
    expect(below.risk.reasons[0]).toMatch(/liquidation line/);

    // Exactly on the line is liquidatable too (the RiskEngine requires strictly above).
    const onLine = await evaluateWriteRisk(mcp(240, 200), { action: withdraw(100), smartAccount: "CTEST", amount: 100 });
    expect(onLine.risk.projected_health_factor).toBeCloseTo(LIQUIDATION_THRESHOLD, 6);
    expect(onLine.risk.decision).toBe("block");
  });

  it("does not hard-block a write that stays above the line", async () => {
    const above = await evaluateWriteRisk(mcp(400, 200), { action: withdraw(100), smartAccount: "CTEST", amount: 100 });
    expect(above.risk.projected_health_factor).toBeCloseTo(1.9, 3);
    expect(above.risk.decision).not.toBe("block");
  });
});
