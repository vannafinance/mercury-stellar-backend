import { describe, expect, it } from "vitest";
import { parseDecision } from "@/lib/copilot/investigation/decision";
import { anchoredLifecycleWrite } from "@/lib/copilot/workflow/lifecycle";
import { WORKFLOW_OPS } from "@/lib/copilot/workflow/types";

const base = {
  kind: "research_complete",
  goal: {
    intent: "strategy",
    objective: "open a margin account",
    constraints: [],
    borrowing: "unspecified",
    write: { op: "create_account", sourceQuote: "open a margin account" },
  },
  findings: [{ summary: "Opening a margin account for the connected wallet.", evidenceIds: [] }],
  openQuestions: [],
};

describe("lifecycle writes are not plan ops", () => {
  it("keeps create_account off the sized op table", () => {
    expect(WORKFLOW_OPS).not.toContain("create_account");
  });

  it("parses goal.write and only runs it when the quote is in the user message", () => {
    const decision = parseDecision(base);
    expect(decision?.kind).toBe("research_complete");
    if (decision?.kind !== "research_complete") return;
    expect(decision.goal.write).toEqual({ op: "create_account", sourceQuote: "open a margin account" });
    expect(anchoredLifecycleWrite(decision.goal.write, ["open a margin account"], false)).toBe("create_account");
    expect(anchoredLifecycleWrite(decision.goal.write, ["lend 10 XLM"], false)).toBeNull();
    expect(anchoredLifecycleWrite(decision.goal.write, ["open a margin account"], true)).toBeNull();
  });
});
