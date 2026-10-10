/**
 * 23 Sep, from the dev diagnostics file:
 *  - XS5 "unwind my positions safely": the model's 7-leg unwind was dropped ("legs 7") by a
 *    parser cap of 6, stricter than the 8 steps one approval can run.
 *  - X14: blend_markets and farm_lp_position failed as "MCP read failed. No value was
 *    inferred.", which cannot tell a timeout from an MCP error.
 */
import { describe, expect, it } from "vitest";
import { parseDecision } from "@/lib/copilot/investigation/decision";
import { capToOneApproval, planCandidateId } from "@/lib/copilot/investigation/plan";
import { isCandidateId } from "@/lib/copilot/investigation/candidate-id";
import { readFailureText } from "@/lib/copilot/investigation/runtime";
import { MCPError } from "@/lib/copilot/mcp-client";
import { MAX_WORKFLOW_STEPS } from "@/lib/copilot/workflow/types";
import type { ProposedPlan } from "@/lib/copilot/investigation/types";

const legs = (n: number, asset = "BLUSDC") => Array.from({ length: n }, () => ({ op: "redeem", asset, sizing: { kind: "all_position" } }));

describe("a plan as long as one approval can run", () => {
  const decide = (n: number) => parseDecision({
    kind: "research_complete",
    goal: { objective: "Unwind", constraints: [], borrowing: "forbidden" },
    findings: [{ summary: "Positions were read.", evidenceIds: ["e1"] }],
    openQuestions: [],
    plans: [{ title: "Exit everything", rationale: "r", evidenceIds: ["e1"], legs: legs(n) }],
  });

  it("parses a 7-leg plan (XS5) and one at the approval limit", () => {
    for (const n of [7, MAX_WORKFLOW_STEPS]) {
      const parsed = decide(n);
      if (parsed?.kind !== "research_complete") throw new Error("not complete");
      expect(parsed.plans?.[0].legs).toHaveLength(n);
    }
  });

  it("still drops one past the limit, and says the limit", () => {
    const parsed = decide(MAX_WORKFLOW_STEPS + 1);
    if (parsed?.kind !== "research_complete") throw new Error("not complete");
    expect(parsed.droppedPlanReasons?.[0]).toContain(`(limit ${MAX_WORKFLOW_STEPS})`);
  });
});

describe("a long plan's id", () => {
  const plan = (assets: string[]): ProposedPlan => ({ title: "t", rationale: "r", evidenceIds: [],
    legs: assets.map((asset) => ({ op: "remove_liquidity" as const, asset, sizing: { kind: "all_position" as const } })) });

  it("stays readable when it fits", () => {
    expect(planCandidateId(plan(["XLM", "BLUSDC"]))).toBe("composed:rl.XLM+rl.BLUSDC");
  });

  it("becomes a valid, stable fingerprint instead of throwing when it does not", () => {
    const long = plan(Array.from({ length: 8 }, () => "AQUSDC"));
    const id = planCandidateId(long);
    expect(isCandidateId(id)).toBe(true);
    expect(planCandidateId(long)).toBe(id);
    expect(planCandidateId(plan(Array.from({ length: 8 }, () => "SOUSDC")))).not.toBe(id);
  });
});

describe("a sized plan past one approval", () => {
  it("is refused with the transaction count", () => {
    const candidate = { label: "Withdraw everything", steps: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}` })) } as never;
    const capped = capToOneApproval({ candidates: [candidate], rejected: [] }, 8);
    expect(capped.candidates).toEqual([]);
    expect(capped.rejected[0].reason).toBe("this needs 12 transactions, more than one approval can run (8)");
  });
});

describe("a failed read says what kind of failure, never the message", () => {
  it("names a timeout", () => {
    expect(readFailureText(new Error("x"), true)).toBe("MCP read exceeded its time limit. No value was inferred.");
  });
  it("names the error class, MCP code and HTTP status, and no message text", () => {
    const text = readFailureText(new MCPError("token=secret-value", { code: "upstream_error" as never, httpStatus: 503 }), false);
    expect(text).toBe("MCP read failed (MCPError, code upstream_error, HTTP 503). No value was inferred.");
    expect(text).not.toContain("secret");
  });
});
