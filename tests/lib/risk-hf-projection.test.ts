/**
 * Reported live: depositing 5 XLM as collateral (debt unchanged) projected the health
 * factor to WORSEN (1.50 → 1.35 in the staged-action card), when adding collateral with
 * no new debt can only ever raise or leave health factor unchanged — never lower it.
 *
 * Root cause: `hfFrom()` multiplied collateral by a `DEFAULT_LT` of 0.9 that does not
 * exist anywhere in the actual product formula (`avgHealthFactor = grossCollateralValue /
 * effectiveDebtValue` in lib/margin-health.ts, confirmed by the Margin page's own
 * displayed number). `hf_before` almost always comes straight from a real MCP/snapshot
 * read and bypasses this, but `hf_after` — a hypothetical future state — has no such
 * real read and ALWAYS went through the discounted formula, so every write's projected
 * post-action health factor was ~10% off from what the same formula would show once the
 * write actually landed.
 */
import { describe, expect, it } from "vitest";
import { evaluateWriteRisk } from "@/lib/copilot/risk";
import type { MCPClient } from "@/lib/copilot/mcp-client";
import type { CopilotAction } from "@/lib/copilot/types";

const XLM_PRICE = 0.1578;
const COLLATERAL_BEFORE = 473.40;
const DEBT_BEFORE = 315.67;

function mcpWithHealth(healthFactor?: number): MCPClient {
  return {
    async call(tool: string) {
      if (tool === "vanna_get_price") return { price_usd: String(XLM_PRICE) };
      if (tool === "vanna_get_account_health") {
        return {
          collateral_usd: String(COLLATERAL_BEFORE),
          debt_usd: String(DEBT_BEFORE),
          ...(healthFactor != null ? { health_factor: String(healthFactor) } : {}),
        };
      }
      return {};
    },
  };
}

const depositAction: CopilotAction = {
  op: "deposit_collateral",
  asset: "XLM",
  amount: 5,
  requires_account: true,
  requires_amount: true,
};

describe("deposit-collateral health-factor projection matches the real formula", () => {
  it("never predicts a worse health factor from adding collateral with no new debt", async () => {
    const realHfBefore = COLLATERAL_BEFORE / DEBT_BEFORE; // 1.4996… — the undiscounted, real formula
    const { simulation } = await evaluateWriteRisk(mcpWithHealth(realHfBefore), {
      action: depositAction,
      smartAccount: "CTEST",
      amount: 5,
    });
    expect(simulation).not.toBeNull();
    expect(simulation!.hf_before).toBeCloseTo(realHfBefore, 4);
    // The failure mode reported live: hf_after < hf_before after a pure deposit.
    expect(simulation!.hf_after!).toBeGreaterThanOrEqual(simulation!.hf_before!);
  });

  it("computes hf_after with the same undiscounted collateral/debt ratio as hf_before", async () => {
    const realHfBefore = COLLATERAL_BEFORE / DEBT_BEFORE;
    const { simulation } = await evaluateWriteRisk(mcpWithHealth(realHfBefore), {
      action: depositAction,
      smartAccount: "CTEST",
      amount: 5,
    });
    const expectedAfter = (COLLATERAL_BEFORE + 5 * XLM_PRICE) / DEBT_BEFORE;
    expect(simulation!.hf_after).toBeCloseTo(expectedAfter, 3);
  });

  it("uses the undiscounted ratio for the fallback hf_before too, when MCP omits health_factor", async () => {
    // MCP sometimes returns collateral/debt with no health_factor field at all — the
    // fallback formula must match the real one just as strictly as the happy path.
    const { simulation } = await evaluateWriteRisk(mcpWithHealth(undefined), {
      action: depositAction,
      smartAccount: "CTEST",
      amount: 5,
    });
    const realHfBefore = COLLATERAL_BEFORE / DEBT_BEFORE;
    expect(simulation!.hf_before).toBeCloseTo(realHfBefore, 4);
  });

  it("still projects a lower health factor for a borrow (debt increases, collateral does not)", async () => {
    const realHfBefore = COLLATERAL_BEFORE / DEBT_BEFORE;
    const borrowAction: CopilotAction = {
      op: "borrow",
      asset: "XLM",
      amount: 50,
      requires_account: true,
      requires_amount: true,
    };
    const { simulation } = await evaluateWriteRisk(mcpWithHealth(realHfBefore), {
      action: borrowAction,
      smartAccount: "CTEST",
      amount: 50,
    });
    const expectedAfter = COLLATERAL_BEFORE / (DEBT_BEFORE + 50 * XLM_PRICE);
    expect(simulation!.hf_after).toBeCloseTo(expectedAfter, 3);
    expect(simulation!.hf_after!).toBeLessThan(simulation!.hf_before!);
  });
});
