import { describe, expect, it } from "vitest";
import { candidateId, isCandidateId } from "@/lib/copilot/investigation/candidate-id";

describe("candidateId", () => {
  it("lowercases minted ids so the propose route accepts them", () => {
    expect(candidateId("supply_idle", "BLUSDC")).toBe("supply_idle_blusdc");
    expect(isCandidateId(candidateId("supply_idle", "BLUSDC"))).toBe(true);
  });

  it("mints a fourth kind with a digit and a hyphen without the route knowing the kind", () => {
    const id = candidateId("farm_rebalance", "USDC-2");
    expect(id).toBe("farm_rebalance_usdc_2");
    expect(isCandidateId(id)).toBe(true);
  });

  it("rejects an empty mint", () => {
    expect(() => candidateId("***")).toThrow(/invalid_candidate_id/);
  });
});
