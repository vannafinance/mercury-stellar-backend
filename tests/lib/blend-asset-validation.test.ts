/**
 * A Blend supply must never silently accept a token Blend doesn't hold.
 *
 * Found live: "Swap 10 XLM to BLUSDC then farm Blend at 2x with 10 BLUSDC" paused on the
 * swap leg (BLUSDC can't be swapped into) and, once the plan resumed with SOUSDC as the
 * swap destination, the SAME asset leaked into the farm leg too — "deploy_to_blend" with
 * SOUSDC. The old code silently coerced AQUSDC/SOUSDC (and anything else unrecognised)
 * into Blend's own USDC reserve, so a Soroswap-flavored token got quietly supplied to
 * Blend instead — confirmed on-chain: real "Supply 2.00 USDC" / "Supply 10.00 USDC"
 * transactions landed in Blend when the user's actual intent (having just swapped into
 * SOUSDC) could only ever have been Soroswap liquidity.
 */
import { describe, expect, it } from "vitest";
import { mapOpToMcpStep } from "@/lib/copilot/mcp-write";

const CTX = {
  trader: "G".padEnd(56, "A"),
  smartAccount: "C".padEnd(56, "B"),
} as never;

const deploy = (params: Record<string, unknown>) =>
  mapOpToMcpStep("deploy_to_blend", { amount: 10, ...params } as never, CTX);
const supply = (params: Record<string, unknown>) =>
  mapOpToMcpStep("supply_to_blend", { amount: 10, ...params } as never, CTX);

describe("Blend supply refuses a non-Blend token instead of silently substituting one", () => {
  it("refuses SOUSDC rather than quietly supplying Blend's own USDC", () => {
    const r = supply({ asset: "SOUSDC" });
    expect(r.step).toBeUndefined();
    expect(r.blocker).toMatch(/SOUSDC/);
    expect(r.blocker).toMatch(/soroswap/i);
  });

  it("refuses AQUSDC the same way, naming Aquarius", () => {
    const r = supply({ asset: "AQUSDC" });
    expect(r.step).toBeUndefined();
    expect(r.blocker).toMatch(/AQUSDC/);
    expect(r.blocker).toMatch(/aquarius/i);
  });

  it("still accepts BLUSDC (Blend's own USDC) and XLM", () => {
    expect(supply({ asset: "BLUSDC" }).step?.args.symbol).toBe("USDC");
    expect(supply({ asset: "XLM" }).step?.args.symbol).toBe("XLM");
    expect(supply({ asset: "USDC" }).step?.args.symbol).toBe("USDC");
  });

  it("the leveraged (deploy) path refuses SOUSDC the same way as the plain supply path", () => {
    const r = deploy({ asset: "SOUSDC", leverage: 2, blend_pool_address: "C".padEnd(56, "D") });
    expect(r.step).toBeUndefined();
    expect(r.blocker).toMatch(/SOUSDC/);
  });
});
