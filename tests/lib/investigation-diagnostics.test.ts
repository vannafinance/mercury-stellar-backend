import { describe, expect, it } from "vitest";
import { parseDecision } from "@/lib/copilot/investigation/decision";
import { reusableObservations } from "@/lib/copilot/investigation/evidence";
import { boundedLimits } from "@/lib/copilot/investigation/runtime";
import type { ResearchEvidence } from "@/lib/copilot/investigation/evidence";

/**
 * 23 Sep, "aquarius lp": the follow-up turn reused reads that were 54s old, the turn took
 * 23s, and the finish-time freshness check refused them at 71-77s, voiding the whole run.
 * Carried reads are only reused when they will still be fresh at the END of the loop.
 */
describe("carried reads are reused only if they outlive the turn", () => {
  const NOW = 1_700_000_000_000;
  const evidenceAged = (ageMs: number): ResearchEvidence => ({
    capturedAt: NOW - ageMs,
    capacity: null,
    observations: [{ id: "p1", capability: "account_position", args: {}, observedAt: NOW - ageMs, status: "ok", data: {} }],
  } as unknown as ResearchEvidence);
  const horizon = NOW + boundedLimits().maxDurationMs;

  it("re-reads evidence that is fresh now but would expire mid-turn", () => {
    expect(reusableObservations(evidenceAged(54_000), NOW)).toHaveLength(1);
    expect(reusableObservations(evidenceAged(54_000), horizon)).toHaveLength(0);
  });

  it("still reuses evidence from a quick follow-up", () => {
    expect(reusableObservations(evidenceAged(5_000), horizon)).toHaveLength(1);
  });
});

/**
 * 23 Sep, XS5: two unwind plans vanished as "could not be read" with nothing to say which
 * rule fired. Each dropped plan now carries the validator's reason (diagnostics only).
 */
describe("a dropped plan says why", () => {
  const decide = (plans: unknown) => parseDecision({
    kind: "research_complete",
    goal: { objective: "Unwind", constraints: [], borrowing: "forbidden" },
    findings: [{ summary: "Positions were read.", evidenceIds: ["e1"] }],
    openQuestions: [],
    plans,
  });

  it("names the sizing word that carried an extra key", () => {
    const parsed = decide([{ title: "Exit everything", rationale: "r", evidenceIds: ["e1"], legs: [
      { op: "redeem", asset: "XLM", sizing: { kind: "all_position", amount: "44.8" } },
    ] }]);
    expect(parsed?.kind).toBe("research_complete");
    if (parsed?.kind !== "research_complete") return;
    expect(parsed.droppedPlans).toBe(1);
    expect(parsed.droppedPlanReasons?.[0]).toMatch(/^Exit everything: leg 1: redeem XLM: sizing all_position takes no other keys/);
  });

  it("names an unknown key on a leg", () => {
    const parsed = decide([{ title: "LP exit", rationale: "r", evidenceIds: ["e1"], legs: [
      { op: "remove_liquidity", asset: "XLM", assetOut: "AQUSDC", sizing: { kind: "all_position" } },
    ] }]);
    if (parsed?.kind !== "research_complete") throw new Error("not complete");
    expect(parsed.droppedPlanReasons?.[0]).toContain("keys op,asset,assetOut,sizing");
  });

  it("records nothing for plans that parse", () => {
    const parsed = decide([{ title: "Redeem", rationale: "r", evidenceIds: ["e1"], legs: [
      { op: "redeem", asset: "XLM", sizing: { kind: "all_position" } },
    ] }]);
    if (parsed?.kind !== "research_complete") throw new Error("not complete");
    expect(parsed.droppedPlanReasons).toBeUndefined();
  });
});
