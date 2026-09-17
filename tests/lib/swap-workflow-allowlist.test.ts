import { describe, expect, it } from "vitest";
import { allowedInvocation, writeArgsFor } from "@/lib/copilot/workflow/allowlist";
import type { ProposalStep } from "@/lib/copilot/workflow/types";

const scope = { trader: "GTEST", smartAccount: "CTEST" };

function exactOutputStep(tokenOut: string, venue: string, minOut = "10"): ProposalStep {
  return {
    id: "swap", op: "swap", asset: "XLM", amount: "50", label: "Swap",
    tool: "vanna_swap", targetOut: "10",
    args: writeArgsFor("swap", "XLM", "50", scope, { tokenOut, venue, minOut }),
  };
}

describe("exact output swap allowlist", () => {
  it("accepts a matching floor on Aquarius and Soroswap", () => {
    expect(() => allowedInvocation(exactOutputStep("AQUSDC", "aquarius"), scope)).not.toThrow();
    expect(() => allowedInvocation(exactOutputStep("SOUSDC", "soroswap"), scope)).not.toThrow();
  });

  it("refuses a lowered target floor or the wrong pool", () => {
    expect(() => allowedInvocation(exactOutputStep("AQUSDC", "aquarius", "9"), scope)).toThrow("exact_output_floor_mismatch");
    expect(() => allowedInvocation(exactOutputStep("AQUSDC", "soroswap"), scope)).toThrow("write_not_allowed");
  });
});
