import { describe, expect, it } from "vitest";
import { plainDashes } from "@/lib/copilot/plain-text";

describe("plainDashes", () => {
  it("writes a hyphen where an em dash would go, in every string leaf", () => {
    const view = {
      message: "Lend 5 XLM — settled on-chain.",
      blocks: [{ type: "paragraph", segments: [{ text: "Plan A—no new borrowing" }] }],
      warnings: ["a — b"],
      nested: { deeper: { label: "x — y" } },
    };
    expect(plainDashes(view)).toEqual({
      message: "Lend 5 XLM - settled on-chain.",
      blocks: [{ type: "paragraph", segments: [{ text: "Plan A-no new borrowing" }] }],
      warnings: ["a - b"],
      nested: { deeper: { label: "x - y" } },
    });
  });

  it("leaves everything else exactly as it was: numbers, booleans, null, other dashes, sealed tokens", () => {
    const view = { n: 1.5, ok: true, none: null, range: "10–30 seconds", token: "eyJhbGciOi-_9aZ", hash: "73f69a17" };
    expect(plainDashes(view)).toEqual(view);
  });

  it("does not mutate its input", () => {
    const view = { message: "a — b" };
    plainDashes(view);
    expect(view.message).toBe("a — b");
  });
});
