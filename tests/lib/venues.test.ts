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
