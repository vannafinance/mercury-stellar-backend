import { describe, expect, it } from "vitest";
import { routeMessage } from "@/lib/copilot/router";
import { findBalanceFraction } from "@/lib/copilot/amount-intent";

/**
 * "Idle" names the pot and the share at once: everything not already at work.
 *
 * Live, 22 Sep: "can you invest my idle tokens in farm market" answered "How much XLM
 * do you want to supply to Blend?" — asking for a number the sentence had given, and
 * naming an asset and a venue the user never did. Every idle phrasing did it.
 *
 * Two separate faults, both needed:
 *
 * 1. `findBalanceFraction` did not read "idle" as a size. "idle tokens" and "idle
 *    funds" name no balance its `namesBalance` gate recognises, and "my idle balance"
 *    names one but then says neither "all" nor "max", so the share came back null.
 * 2. Two write branches could not carry a share even when one was found:
 *    `invest_max_yield` and `deploy_to_blend` both hard-coded `requires_amount: true`.
 *    That one also swallowed "invest all my USDC for max profit", where the size was
 *    stated outright.
 */

type Routed = {
  kind: string;
  op?: string;
  asset?: string | null;
  amount?: number | null;
  fraction?: number | null;
  requires_amount?: boolean;
};

const route = (message: string) => routeMessage(message) as Routed;

describe("THE LIVE BUG: an idle balance asked for a number it had already given", () => {
  const IDLE = [
    "can You invest my idle tokens in farm market",
    "invest my idle balance for best yield",
    "deploy my idle funds into blend",
    "lend my idle XLM",
  ];

  for (const message of IDLE) {
    it(`sizes "${message}" off the idle balance instead of asking`, () => {
      const routed = route(message);
      expect(routed.kind).toBe("write");
      expect(routed.fraction).toBe(1);
      expect(routed.requires_amount).toBe(false);
    });
  }

  /**
   * Stated outright, and still asked for — the same branch, reached without the word
   * "idle" at all, which is why the fix belongs in the shared reading and not beside
   * one caller.
   */
  it("sizes a plainly stated share under a max-yield ask", () => {
    const routed = route("invest all my USDC for max profit");
    expect(routed.fraction).toBe(1);
    expect(routed.requires_amount).toBe(false);
  });
});

describe("the share is read, not assumed", () => {
  it("keeps a stated amount in front of a fraction", () => {
    const routed = route("supply 20 XLM to blend");
    expect(routed.amount).toBe(20);
    expect(routed.fraction).toBeNull();
  });

  it("reads a partial share of an idle balance as that share", () => {
    expect(findBalanceFraction("half my idle balance into blend")).toBe(0.5);
    expect(findBalanceFraction("25% of my idle XLM")).toBe(0.25);
  });

  /**
   * The ranking preference is not a size — the guard that keeps "max yield" from
   * meaning "all of it" has to survive a branch that now reads shares.
   */
  it("still refuses to read the max of max yield as a size", () => {
    expect(findBalanceFraction("invest for max yield")).toBeNull();
    expect(findBalanceFraction("earn me the best return")).toBeNull();
  });

  it("still refuses a bare all with no balance named", () => {
    expect(findBalanceFraction("lend everything")).toBeNull();
  });
});
