import { afterEach, describe, expect, it } from "vitest";
import {
  recordTokenUsage,
  resetTokenUsage,
  tokenCapMessage,
  tokenUsageToday,
  wouldExceedTokenCap,
  withTokenSubject,
  currentTokenSubject,
} from "@/lib/copilot/token-budget";

afterEach(() => resetTokenUsage());

describe("per-subject daily token cap", () => {
  it("counts usage per subject and trips at the configured ceiling", () => {
    expect(wouldExceedTokenCap("alice")).toBe(false);
    recordTokenUsage("alice", 5_000_000);
    expect(tokenUsageToday("alice")).toBe(5_000_000);
    expect(wouldExceedTokenCap("alice")).toBe(true);
    expect(wouldExceedTokenCap("bob")).toBe(false);
    expect(tokenCapMessage()).toMatch(/token budget/);
  });

  it("exposes the subject through async local storage", () => {
    expect(currentTokenSubject()).toBeUndefined();
    const inner = withTokenSubject("alice", () => currentTokenSubject());
    expect(inner).toBe("alice");
  });
});
