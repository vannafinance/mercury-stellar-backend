import { describe, expect, it } from "vitest";
import { BORROW_AUTHORITY, simplifyQuestion } from "@/lib/copilot/investigation/ask";
import { parseDecision } from "@/lib/copilot/investigation/decision";
import { decisionFromFunctionCalls } from "@/lib/copilot/investigation/decls";

describe("clarify vs rank", () => {
  it("does not ask which pool when ranking already exists", () => {
    expect(simplifyQuestion("Which USDC variant should I supply?", {
      hasRankedOptions: true,
      borrowing: "unspecified",
    })).toBeNull();
  });

  it("asks a preference that no read can supply", () => {
    expect(simplifyQuestion("How long do you expect to hold this?", {
      hasRankedOptions: true,
      borrowing: "unspecified",
    })).toBe("How long do you expect to hold this?");
  });

  it("keeps the model's borrow question instead of replacing it", () => {
    expect(simplifyQuestion("Which pool, and may I borrow?", {
      hasRankedOptions: true,
      borrowing: "unspecified",
    })).toBe("Which pool, and may I borrow?");
  });

  it("classifies a preference whose wording is in no regex in ask.ts", () => {
    const text = "What's your time frame?";
    expect(simplifyQuestion(text, {
      hasRankedOptions: true,
      borrowing: "unspecified",
      questionKind: "preference",
    })).toBe(text);
  });

  it("still drops a resolvable question when ranked options exist", () => {
    expect(simplifyQuestion("What's your time frame?", {
      hasRankedOptions: true,
      borrowing: "unspecified",
      questionKind: "resolvable",
    })).toBeNull();
  });
});

describe("typed clarify kind", () => {
  it("parses questionKind from structured output", () => {
    const parsed = parseDecision({
      kind: "clarify",
      question: "What's your time frame?",
      questionKind: "preference",
    });
    expect(parsed).toMatchObject({
      kind: "clarify",
      question: "What's your time frame?",
      questionKind: "preference",
    });
  });

  it("accepts a function call with kind=preference", () => {
    const decision = decisionFromFunctionCalls([
      { name: "clarify", args: { question: "What's your time frame?", kind: "preference" } },
    ]);
    expect(decision).toMatchObject({
      kind: "clarify",
      question: "What's your time frame?",
      questionKind: "preference",
    });
  });

  it("does not use BORROW_AUTHORITY as a substitute", () => {
    expect(BORROW_AUTHORITY.length).toBeGreaterThan(0);
    expect(simplifyQuestion("May I borrow?", {
      hasRankedOptions: false,
      borrowing: "unspecified",
      questionKind: "preference",
    })).toBe("May I borrow?");
  });
});
