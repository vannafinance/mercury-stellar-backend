/**
 * 23 Sep, live: "lend my AQUA" (no Earn pool) was answered "Best path: Supply idle XLM to
 * Blend" with five options for assets the user never named. Fixed options are narrowed to
 * the assets named; a request that names none keeps every option.
 */
import { describe, expect, it } from "vitest";
import { onlyNamedAssets, type CandidateSet } from "@/lib/copilot/investigation/candidates";

const option = (asset: string) => ({ id: `supply_idle:${asset}`, asset } as unknown as CandidateSet["feasible"][number]);
const SET: CandidateSet = {
  feasible: ["XLM", "BLUSDC", "AQUSDC", "SOUSDC"].map(option),
  rejected: [{ label: "Lend idle AQUA", reason: "AQUA has no Earn pool", asset: "AQUA" }],
};
const assets = (set: CandidateSet | null) => ({ feasible: set?.feasible.map((c) => c.asset), rejected: set?.rejected.map((r) => r.asset) });

describe("fixed options follow the assets the user named", () => {
  it("keeps nothing unrelated when the user asked about an asset with no option", () => {
    expect(assets(onlyNamedAssets(SET, ["lend my AQUA"]))).toEqual({ feasible: [], rejected: ["AQUA"] });
  });

  it("keeps only the named asset's options", () => {
    expect(assets(onlyNamedAssets(SET, ["supply my idle XLM to blend"]))).toEqual({ feasible: ["XLM"], rejected: [] });
  });

  it("treats a bare USDC as naming all three variants", () => {
    expect(assets(onlyNamedAssets(SET, ["lend my USDC"])).feasible).toEqual(["BLUSDC", "AQUSDC", "SOUSDC"]);
  });

  it("keeps every option when no asset is named", () => {
    expect(onlyNamedAssets(SET, ["use my whole wallet to earn the most"])).toBe(SET);
  });
});
