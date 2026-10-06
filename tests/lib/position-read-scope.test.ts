import { describe, expect, it } from "vitest";
import { missingPositionReads } from "@/lib/copilot/investigation/position-coverage";
import { catalogEntry } from "@/lib/copilot/investigation/catalog";
import { parseDecision } from "@/lib/copilot/investigation/decision";
import { decisionFromFunctionCalls } from "@/lib/copilot/investigation/decls";
import type { GoalUnderstanding, Observation } from "@/lib/copilot/investigation/types";

const observed: Observation[] = [{ id: "e0", capability: "account_collateral", args: {}, observedAt: 1, status: "ok", data: {} }];
const request = "List the two requested account pockets separately.";
const goal: GoalUnderstanding = { intent: "answer", objective: request, constraints: [], borrowing: "unspecified",
  positionReadScope: { kind: "selected", capabilities: ["account_collateral", "account_debt"], sourceQuote: request } };

function fullCoverage(reads: ReturnType<typeof missingPositionReads>) {
  const spec = catalogEntry("earn_position")!.modelArgs.asset as { values: readonly string[] };
  expect(reads.filter((read) => read.capability === "earn_position").map((read) => read.args.asset)).toEqual([...spec.values]);
  expect(reads.some((read) => read.capability === "farm_lp_position")).toBe(true);
}

describe("structured answer coverage", () => {
  it("preserves scope through the actual function-call adapter and decision parser", () => {
    const raw = decisionFromFunctionCalls([{ name: "research_complete", args: { ...goal, findings: [{ summary: "Requested balances were read", evidenceIds: ["e0"] }], openQuestions: [] } }]);
    const parsed = parseDecision(raw);
    expect(parsed?.kind).toBe("research_complete");
    if (parsed?.kind === "research_complete") expect(parsed.goal.positionReadScope).toEqual(goal.positionReadScope);
  });
  it("limits only explicitly anchored factual coverage and requests the missing debt read", () => {
    expect(missingPositionReads(observed, goal, [request])).toEqual([{ capability: "account_debt", args: {} }]);
  });
  it("keeps full coverage for broad, missing, invalid and unanchored scope", () => {
    fullCoverage(missingPositionReads(observed));
    fullCoverage(missingPositionReads(observed, { ...goal, positionReadScope: { ...goal.positionReadScope!, kind: "all" } }, [request]));
    fullCoverage(missingPositionReads(observed, goal, ["different request"]));
    fullCoverage(missingPositionReads(observed, { ...goal, positionReadScope: { ...goal.positionReadScope!, capabilities: ["unknown"] } }, [request]));
  });
  it("never narrows strategy or action dependencies even with selected metadata", () => {
    fullCoverage(missingPositionReads(observed, { ...goal, intent: "strategy" }, [request]));
    fullCoverage(missingPositionReads(observed, { ...goal, actions: [{ op: "lend", asset: "XLM", sizing: { kind: "all_idle" }, sourceQuote: request }] }, [request]));
  });
  it("does not treat a failed required read as coverage", () => {
    expect(missingPositionReads([...observed, { id: "e1", capability: "account_debt", args: {}, status: "error", observedAt: 1 }], goal, [request])).toEqual([{ capability: "account_debt", args: {} }]);
  });
});
