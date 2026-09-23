/**
 * 23 Sep, X11: "deposit 100 XLM, borrow 5563 XLM" put only the deposit to the protocol, and
 * the borrow, the leg that moves health most, stood on the projection alone. A health-lowering
 * step with only health-raising steps before it is now previewed against today's account:
 * "allowed" there still holds after the deposit; a refusal is inconclusive and stays projected.
 */
import { describe, expect, it, vi } from "vitest";
import { conservativelyPreviewable, simulateSteps } from "@/lib/copilot/investigation/simulate";
import type { ProposalStep } from "@/lib/copilot/workflow/types";

const SCOPE = { trader: "GTRADER", smartAccount: "CACCOUNT" };
const step = (id: string, op: ProposalStep["op"], amount: string): ProposalStep => ({
  id, op, asset: "XLM", amount, label: `${op} ${amount} XLM`, tool: `vanna_${op}`,
  args: { symbol: "XLM", amount, trader: SCOPE.trader, smart_account: SCOPE.smartAccount },
});
const signal = () => new AbortController().signal;
const answer = (allowed: boolean) => ({ call: vi.fn(async (_tool: string, args: Record<string, unknown>) => ({
  allowed: args.operation === "borrow" ? allowed : true,
  reason: allowed ? "permitted" : "pool borrow cap reached",
  projected_position: { collateral_usd: "162", debt_usd: "54", ltv_pct: "33.33", is_healthy: true },
})) });

describe("a borrow after a deposit", () => {
  it("is put to the protocol, and an allow is reported without the before-deposit LTV", async () => {
    const mcp = answer(true);
    const result = await simulateSteps([step("s0", "deposit_collateral", "100"), step("s1", "borrow", "5563")], SCOPE, mcp, signal());
    expect(mcp.call).toHaveBeenCalledTimes(2);
    expect(result.verdict).toBe("runnable");
    expect(result.steps.map((s) => s.verdict)).toEqual(["allowed", "allowed"]);
    expect(result.summary).toBe("Simulated against the protocol: deposit_collateral 100 XLM allowed (LTV 33.33% after); borrow 5563 XLM allowed (checked before the steps ahead of it).");
  });

  it("stays projected when the protocol refuses it on today's account", async () => {
    const result = await simulateSteps([step("s0", "deposit_collateral", "100"), step("s1", "borrow", "5563")], SCOPE, answer(false), signal());
    expect(result.steps.map((s) => s.verdict)).toEqual(["allowed", "dependent"]);
    expect(result.summary).toBe("Simulated against the protocol: deposit_collateral 100 XLM allowed (LTV 33.33% after); the other step follows from it and stands on the projection.");
  });
});

describe("which dependent steps qualify", () => {
  const deposit = step("s0", "deposit_collateral", "100"), borrow = step("s1", "borrow", "50"), supply = step("s2", "supply_blend", "100");
  it("only a health-lowering step whose earlier steps all raise health", () => {
    expect(conservativelyPreviewable([deposit, borrow], 1)).toBe(true);
    expect(conservativelyPreviewable([deposit, supply], 1)).toBe(false);          // needs the deposited tokens
    expect(conservativelyPreviewable([deposit, supply, borrow], 2)).toBe(false);  // a neutral step before it
    expect(conservativelyPreviewable([borrow, step("s3", "withdraw_collateral", "10")], 1)).toBe(false); // earlier step lowers health
  });
});
