import { describe, expect, it } from "vitest";
import { anchoredVenueOps, unusedVenueOps, venueSentence } from "@/lib/copilot/investigation/venues";
import { parseDecision } from "@/lib/copilot/investigation/decision";

describe("venues the user allowed", () => {
  const messages = ["use my xlm, you can use spots and farm markets yourself"];
  const goal = { venuesAllowed: [
    { op: "swap" as const, sourceQuote: "you can use spots" },
    { op: "add_liquidity" as const, sourceQuote: "farm markets yourself" },
    { op: "lend" as const, sourceQuote: "lend it wherever" },
  ] };

  it("keeps only the permissions whose sentence the user really wrote", () => {
    expect(anchoredVenueOps(goal, messages)).toEqual(["swap", "add_liquidity"]);
    expect(anchoredVenueOps(undefined, messages)).toEqual([]);
  });

  it("names what no plan uses, read off the plans' own steps", () => {
    const plans = [{ steps: [{ op: "lend" as const }, { op: "swap" as const }] }];
    expect(unusedVenueOps(["swap", "add_liquidity"], plans)).toEqual(["add_liquidity"]);
    expect(unusedVenueOps(["swap"], plans)).toEqual([]);
  });

  it("says nothing when every allowed operation is used, and names several in plain words", () => {
    expect(venueSentence([])).toBe("");
    expect(venueSentence(["swap", "add_liquidity"])).toBe(" You said I could use swap and add liquidity; no plan that sizes on the current reads uses them.");
  });
});

describe("the venuesAllowed field of a conclusion", () => {
  const conclude = (venuesAllowed: unknown) => parseDecision({
    kind: "research_complete",
    goal: { objective: "o", constraints: [], borrowing: "unspecified", intent: "strategy", venuesAllowed },
    findings: [{ summary: "s", evidenceIds: [] }], openQuestions: [],
  });

  it("keeps well-formed rows and drops a row with an unknown operation or no quote, alone", () => {
    const out = conclude([
      { op: "swap", sourceQuote: "you can use spots" },
      { op: "teleport", sourceQuote: "x" },
      { op: "lend", sourceQuote: "" },
    ]);
    expect(out?.kind).toBe("research_complete");
    if (out?.kind === "research_complete") expect(out.goal.venuesAllowed).toEqual([{ op: "swap", sourceQuote: "you can use spots" }]);
  });
});

describe("the reason an allowed operation was left out", () => {
  it("is said for that operation and the rest are named together", () => {
    const reasons = new Map([["swap" as const, "Blend already pays more on the same tokens."]]);
    expect(venueSentence(["swap", "add_liquidity"], reasons)).toBe(
      " You said I could use swap; I left it out: Blend already pays more on the same tokens. You said I could use add liquidity; no plan that sizes on the current reads uses it.",
    );
  });

  it("is kept from the model's row only when it states no figure of its own", () => {
    const conclude = (whyNotUsed: string) => parseDecision({
      kind: "research_complete",
      goal: { objective: "o", constraints: [], borrowing: "unspecified", intent: "strategy", venuesAllowed: [{ op: "swap", sourceQuote: "you can use spots", whyNotUsed }] },
      findings: [{ summary: "s", evidenceIds: [] }], openQuestions: [],
    });
    const kept = conclude("The pool pays less than Blend here.");
    const dropped = conclude("The pool pays 3% less.");
    if (kept?.kind !== "research_complete" || dropped?.kind !== "research_complete") throw new Error("not parsed");
    expect(kept.goal.venuesAllowed?.[0].whyNotUsed).toBe("The pool pays less than Blend here.");
    expect(dropped.goal.venuesAllowed?.[0].whyNotUsed).toBeUndefined();
  });
});

describe("the reading and the request that ride on a conclusion", () => {
  const conclude = (extra: Record<string, unknown>, row: Record<string, unknown> = { op: "swap", sourceQuote: "spt bhi chaiye" }) => parseDecision({
    kind: "research_complete",
    goal: { objective: "o", constraints: [], borrowing: "unspecified", intent: "strategy", venuesAllowed: [row], ...extra },
    findings: [{ summary: "s", evidenceIds: [] }], openQuestions: [],
  });

  it("keeps how the model read a misspelled message, and that the user asked for the operation", () => {
    const out = conclude({ reading: "Adding a spot trade to the plan" }, { op: "swap", sourceQuote: "spt bhi chaiye", asked: true });
    if (out?.kind !== "research_complete") throw new Error("not parsed");
    expect(out.goal.reading).toBe("Adding a spot trade to the plan");
    expect(out.goal.venuesAllowed).toEqual([{ op: "swap", sourceQuote: "spt bhi chaiye", asked: true }]);
  });

  it("drops an empty reading and a non-boolean request", () => {
    const out = conclude({ reading: "  " }, { op: "swap", sourceQuote: "spt bhi chaiye", asked: "yes" });
    if (out?.kind !== "research_complete") throw new Error("not parsed");
    expect(out.goal.reading).toBeUndefined();
    expect(out.goal.venuesAllowed?.[0].asked).toBeUndefined();
  });
});
