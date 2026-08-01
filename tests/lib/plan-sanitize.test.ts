import { describe, it, expect } from "vitest";
import {
  isLikelyHfFloorAmount,
  preferMultiGoalPlan,
  looksLikeMultiGoal,
  sanitizePlan,
} from "@/lib/copilot/plan-sanitize";
import { routeMessage } from "@/lib/copilot/router";

const PROMPT = "park 20 XLM for yield then farm 10 BLUSDC at 2x keep HF above 1.4";

describe("plan-sanitize", () => {
  it("detects multi-goal prompts", () => {
    expect(looksLikeMultiGoal(PROMPT)).toBe(true);
    expect(looksLikeMultiGoal("deposit 5 XLM as collateral")).toBe(false);
  });

  it("treats HF floor as non-amount", () => {
    expect(isLikelyHfFloorAmount(1.4, PROMPT)).toBe(true);
    expect(isLikelyHfFloorAmount(20, PROMPT)).toBe(false);
    expect(isLikelyHfFloorAmount(10, PROMPT)).toBe(false);
  });

  it("recovers when Vertex collapses multi-goal to a bad single write", () => {
    const kw = routeMessage(PROMPT);
    expect(kw.kind).toBe("plan");
    const collapsed = {
      kind: "write" as const,
      op: "deploy_to_blend",
      asset: "BLUSDC",
      amount: 1.4,
      multi_leg: true,
      requires_account: true,
      requires_amount: true,
      template_id: "deploy_to_blend",
      leverage: 2,
    };
    const recovered = preferMultiGoalPlan(collapsed, kw, PROMPT);
    expect(recovered.kind).toBe("plan");
    if (recovered.kind !== "plan") return;
    const san = sanitizePlan(recovered, PROMPT);
    expect(san.steps.some((s) => s.kind === "write" && s.amount === 1.4)).toBe(false);
    const lend = san.steps.find((s) => s.kind === "write" && s.op === "lend");
    const farm = san.steps.find((s) => s.kind === "write" && s.op === "deploy_to_blend");
    expect(lend?.amount).toBe(20);
    expect(farm?.amount).toBe(10);
  });
});
