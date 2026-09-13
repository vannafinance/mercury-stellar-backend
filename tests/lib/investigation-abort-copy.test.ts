import { describe, expect, it } from "vitest";
import { investigationStopCopy, isAbortError, RESEARCH_ABORTED_MESSAGE, RESEARCH_DEADLINE_MESSAGE, RESEARCH_UNREACHABLE_MESSAGE } from "@/lib/copilot/investigation/abort-copy";

describe("investigation abort vs deadline copy", () => {
  it("uses distinct messages for a deadline and a replaced request", () => {
    expect(investigationStopCopy("deadline")).toEqual({
      code: "research_deadline",
      message: RESEARCH_DEADLINE_MESSAGE,
    });
    expect(investigationStopCopy("replaced")).toEqual({
      code: "research_aborted",
      message: RESEARCH_ABORTED_MESSAGE,
    });
    expect(RESEARCH_DEADLINE_MESSAGE).not.toBe(RESEARCH_ABORTED_MESSAGE);
  });

  it("does not call a hung connection an investigation timeout", () => {
    expect(investigationStopCopy("unreachable")).toEqual({
      code: "research_unreachable",
      message: RESEARCH_UNREACHABLE_MESSAGE,
    });
    expect(RESEARCH_UNREACHABLE_MESSAGE).not.toBe(RESEARCH_DEADLINE_MESSAGE);
  });

  it("treats AbortError / ResponseAborted as abort errors, not unexpected", () => {
    expect(isAbortError({ name: "AbortError", message: "" })).toBe(true);
    expect(isAbortError({ name: "ResponseAborted", message: "" })).toBe(true);
    expect(isAbortError({ name: "Error", message: "fetch failed" })).toBe(false);
  });
});
