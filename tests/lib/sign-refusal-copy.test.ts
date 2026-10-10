import { describe, expect, it } from "vitest";
import { signRefusalCopy } from "@/components/copilot/sign-refusal-copy";

describe("signRefusalCopy", () => {
  it("says a spend over a limit is outside the user's limits", () => {
    expect(signRefusalCopy("over_per_tx_cap")).toMatch(/outside your auto-approve limits/);
    expect(signRefusalCopy("over_daily_cap")).toMatch(/outside your auto-approve limits/);
  });
  it("gives any other refusal the plain form, still telling the user to sign", () => {
    for (const code of ["rejected", "unavailable", "usd_valuation_unavailable"]) {
      expect(signRefusalCopy(code)).toMatch(/needs your own signature/);
      expect(signRefusalCopy(code)).not.toMatch(/outside your auto-approve limits/);
    }
  });
  it("says nothing when auto-approve was not in force", () => {
    expect(signRefusalCopy(undefined)).toBeUndefined();
    expect(signRefusalCopy("")).toBeUndefined();
  });
});
