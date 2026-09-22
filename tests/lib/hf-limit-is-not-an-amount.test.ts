import { describe, expect, it } from "vitest";
import { routeMessage, matchHealthFactorCeiling, matchHealthFactorCeilingSpan } from "@/lib/copilot/router";

/**
 * A health-factor limit is a threshold, never a size.
 *
 * Live, 22 Sep: "deploy my idle funds into blend keeping HF above 1.4" staged
 * `Supply 1.4 XLM to Blend`. The projected impact gave it away — health factor 59.43 →
 * 59.43, collateral unchanged — because 1.4 XLM does nothing. The user never stated a
 * size in that sentence; the only number in it was the limit they set ON the size, and
 * the floor was consumed as the amount.
 *
 * `plan-sanitize.ts` already guards this with `isLikelyHfFloorAmount` — "keep HF above
 * 1.4 must never become amount=1.4", in its own words — but it is wired into
 * `llm-planner.ts` alone, and the router reaches its bare-number fallback without ever
 * passing through it.
 */

const amountOf = (message: string): number | null | undefined => {
  const routed = routeMessage(message) as { kind: string; amount?: number | null };
  return routed.kind === "write" ? routed.amount : undefined;
};

describe("THE LIVE BUG: a health-factor limit read as a size", () => {
  it("does not take the floor as the amount", () => {
    expect(amountOf("deploy my idle funds into blend and keeping HF above 1.4")).toBeNull();
  });

  /**
   * The same hole, entered from the other side. A user who types `<` where they meant
   * `>` was already having their limit dropped before `matchHealthFactorCeiling`
   * existed; reading it as a size is the worse half of that.
   */
  it("does not take the ceiling as the amount", () => {
    expect(amountOf("deploy my idle funds into blend keeping HF below 2")).toBeNull();
  });

  /**
   * "to HF floor 1.40" states the threshold in a phrasing neither detector reads, and
   * read 1.40 as the borrow size (findings C1, 15 Sep).
   */
  it("does not take a stated floor phrase as the amount", () => {
    expect(amountOf("borrow BLUSDC to HF floor 1.40")).toBeNull();
  });
});

describe("a real size still survives beside a limit", () => {
  it("keeps an amount the user actually stated", () => {
    expect(amountOf("supply 20 XLM to blend keeping HF above 1.4")).toBe(20);
  });

  it("keeps an amount stated before a negated floor", () => {
    expect(amountOf("borrow 500 USDC so health factor does not go below 1.3")).toBe(500);
  });

  it("does not disturb a plain sized write", () => {
    expect(amountOf("lend 50 XLM")).toBe(50);
  });
});

describe("the ceiling detector reports where it matched", () => {
  /**
   * Split the way `matchMinHealthFactor` / `parseMinHealthFactor` already are, so the
   * value-only reading is derived from the span and the two cannot disagree.
   */
  it("returns the span, and the value reading matches it", () => {
    const text = "deploy my idle funds into blend keeping HF below 2";
    const span = matchHealthFactorCeilingSpan(text);
    expect(span?.value).toBe(2);
    expect(matchHealthFactorCeiling(text)).toBe(span?.value);
    expect(text.slice(span!.start, span!.end)).toMatch(/HF below 2/i);
  });

  it("still reports nothing when no ceiling is stated", () => {
    expect(matchHealthFactorCeilingSpan("lend 50 XLM")).toBeNull();
    expect(matchHealthFactorCeiling("lend 50 XLM")).toBeNull();
  });
});
