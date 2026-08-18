/**
 * The farm leg's asset was scanned across the WHOLE message, not scoped to its own
 * clause — "swap 10 XLM to AQUSDC then farm Blend with 5 BLUSDC" names AQUSDC for the
 * swap and BLUSDC for the farm leg, but whichever variant matched first in the
 * (blusdc, aqusdc, sousdc) checklist won regardless of which clause it actually
 * appeared in. Contributed to a live bug where a swap leg's resolved token leaked into
 * the farm leg after a multi-leg plan re-parsed.
 */
import { describe, expect, it } from "vitest";
import { routeMessage } from "@/lib/copilot/router";

describe("the farm leg's asset is scoped to its own clause", () => {
  it("uses BLUSDC for the farm leg when the swap clause names AQUSDC", () => {
    const r = routeMessage("swap 10 XLM to AQUSDC then farm Blend with 5 BLUSDC");
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    const farmLeg = r.steps.find((s) => s.op === "deploy_to_blend");
    expect(farmLeg?.asset).toBe("BLUSDC");
    const swapLeg = r.steps.find((s) => s.op === "swap");
    expect((swapLeg?.args as Record<string, unknown> | undefined)?.token_out).toBe("AQUSDC");
  });

  it("uses SOUSDC for the farm leg when the swap clause names AQUSDC", () => {
    const r = routeMessage("swap 10 XLM to AQUSDC then farm Blend with 5 SOUSDC");
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    const farmLeg = r.steps.find((s) => s.op === "deploy_to_blend");
    expect(farmLeg?.asset).toBe("SOUSDC");
  });

  it("still reads the same-token common case correctly (swap into X, farm with X)", () => {
    const r = routeMessage("swap 10 XLM to BLUSDC then farm Blend at 2x with 10 BLUSDC");
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    const farmLeg = r.steps.find((s) => s.op === "deploy_to_blend");
    expect(farmLeg?.asset).toBe("BLUSDC");
    expect(farmLeg?.leverage).toBe(2);
  });
});
