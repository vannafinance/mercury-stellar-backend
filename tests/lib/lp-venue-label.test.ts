import { describe, it, expect } from "vitest";
import { freezePlan } from "@/lib/copilot/plan-approval";
import type { RoutedIntent } from "@/lib/copilot/types";

/**
 * Aquarius and Soroswap LP legs share the "farm" venue bucket with Blend (same as the
 * app's own Farm tab covers all three), but that bucket's label suffix was a flat "into
 * Blend" — so a genuine Soroswap add_liquidity step rendered "Add liquidity with 5 SOUSDC
 * into Blend". Reported live after a swap-into-SOUSDC-then-add-liquidity plan: the leg
 * showed a Blend transaction card, and running it deposited into Blend instead of
 * Soroswap. The venue actually applies is determined by the USDC variant named, not by
 * the shared badge category.
 */
const planFor = (asset: string) =>
  ({
    kind: "plan",
    template_id: "add_liquidity",
    summary: `add liquidity with 5 ${asset}`,
    steps: [
      {
        kind: "write",
        op: "add_liquidity",
        asset,
        amount: 5,
        args: { token_a: "XLM", token_b: asset },
      },
    ],
  }) as unknown as Extract<RoutedIntent, { kind: "plan" }>;

describe("an LP leg's label names the real venue, not a shared 'Blend' suffix", () => {
  it("names Soroswap for a SOUSDC leg", () => {
    const f = freezePlan(planFor("SOUSDC"), 1_000_000);
    expect(f.steps[0].label).toMatch(/on Soroswap/i);
    expect(f.steps[0].label).not.toMatch(/blend/i);
  });

  it("names Aquarius for an AQUSDC leg", () => {
    const f = freezePlan(planFor("AQUSDC"), 1_000_000);
    expect(f.steps[0].label).toMatch(/on Aquarius/i);
    expect(f.steps[0].label).not.toMatch(/blend/i);
  });

  it("still badges the leg under the farm venue (Farm tab covers all three)", () => {
    const f = freezePlan(planFor("SOUSDC"), 1_000_000);
    expect(f.steps[0].venue).toBe("farm");
  });
});
