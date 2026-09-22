import { describe, expect, it } from "vitest";
import { ClaimRegistry, collectStandardConstraints, matchMinHealthFactor, parseMinHealthFactor, routeMessage } from "@/lib/copilot/router";

/**
 * "floor" is how the product names this number, so a user echoing it back must be read.
 *
 * The approval card says "your 1.3 health-factor floor", and #84's refusal says "does
 * not pass your 1.3 health-factor floor" — then "borrow BLUSDC to HF floor 1.40"
 * matched none of the floor patterns, because the connector list held `above`, `over`
 * and `at least` but not the product's own word.
 *
 * Both halves failed at once, which is what makes this worth its own test:
 *
 * - the stated floor parsed as NO floor, so nothing enforced it
 * - and 1.40, the only number in the sentence, was left unclaimed by the registry, so
 *   the amount scan read it as the borrow size (findings C1, 15 Sep)
 *
 * Fixed in `matchMinHealthFactor` rather than beside either symptom: the registry
 * claims what that detector matches, so one change answers both.
 */

const amountOf = (message: string): number | null | undefined => {
  const routed = routeMessage(message) as { kind: string; amount?: number | null };
  return routed.kind === "write" ? routed.amount : undefined;
};

describe("THE LIVE BUG: a floor stated as 'floor' was read as neither", () => {
  it("reads the floor the user stated", () => {
    expect(parseMinHealthFactor("borrow BLUSDC to HF floor 1.40")).toBe(1.4);
  });

  it("does not read that floor as the borrow size", () => {
    expect(amountOf("borrow BLUSDC to HF floor 1.40")).toBeNull();
  });

  it("reads the spelled-out form the same way", () => {
    expect(parseMinHealthFactor("borrow BLUSDC to health factor floor of 1.4")).toBe(1.4);
    expect(amountOf("borrow BLUSDC to health factor floor of 1.4")).toBeNull();
  });

  /**
   * The registry is what keeps the number away from the amount scan, so the span has
   * to be claimed — not merely parsed.
   */
  it("claims the floor's span so the amount scan cannot see it", () => {
    const text = "borrow BLUSDC to HF floor 1.40";
    const registry = new ClaimRegistry();
    collectStandardConstraints(text, registry);
    const match = matchMinHealthFactor(text)!;
    expect(text.slice(match.start, match.end)).toMatch(/HF floor 1\.40/i);
    expect(registry.mask(text)).not.toMatch(/1\.40/);
  });
});

describe("the phrasings that already worked still do", () => {
  it("keeps a stated size beside a floor", () => {
    expect(amountOf("lend 50 XLM keeping HF above 1.4")).toBe(50);
    expect(parseMinHealthFactor("lend 50 XLM keeping HF above 1.4")).toBe(1.4);
  });

  it("keeps a stated size beside a negated floor", () => {
    expect(amountOf("borrow 500 USDC so health factor does not go below 1.3")).toBe(500);
    expect(parseMinHealthFactor("borrow 500 USDC so health factor does not go below 1.3")).toBe(1.3);
  });

  it("finds no floor where none is stated, and leaves the size alone", () => {
    expect(parseMinHealthFactor("lend 50 XLM")).toBeNull();
    expect(amountOf("lend 50 XLM")).toBe(50);
  });
});
