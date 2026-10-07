import { describe, expect, it } from "vitest";
import { unpostedCollateralNote } from "@/lib/copilot/investigation/sizing-copy";

/**
 * 7 Oct 2026, test account: the Margin page counted $4,744.90 and the contract $3,695.77. The $1,049.13
 * between them was $906 of a token held in the account but absent from the collateral ledger plus $194 of
 * liquidity-pool receipts (less ~$51 of Blend valuation). The note used to call all of it "not posted as
 * collateral" and to say it "can be withdrawn without touching your health factor" — wrong for the
 * pool receipts, and wrong for the figure the user is shown, which counts it.
 */
describe("unpostedCollateralNote", () => {
  const note = unpostedCollateralNote({ grossCollateralUsd: "4744.90" }, { grossCollateralUsd: "3695.77" });

  it("states the gap the contract does not count", () => {
    expect(note).toContain("$1049.13");
  });

  it("names liquidity-pool receipts as well as unposted tokens", () => {
    expect(note).toMatch(/liquidity-pool receipts/);
    expect(note).toMatch(/not posted as collateral/);
  });

  it("does not claim the amount can be taken out without moving the health factor", () => {
    expect(note).not.toMatch(/withdrawn without touching/i);
  });

  it("says nothing when the app reads at or below the contract", () => {
    expect(unpostedCollateralNote({ grossCollateralUsd: "3695.77" }, { grossCollateralUsd: "3695.77" })).toBeNull();
    expect(unpostedCollateralNote({ grossCollateralUsd: "3000" }, { grossCollateralUsd: "3695.77" })).toBeNull();
  });
});
