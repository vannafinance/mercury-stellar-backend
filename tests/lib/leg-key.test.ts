import { describe, it, expect } from "vitest";
import { isUsdcVariantResolution, labelHasAmount, legKey, legKeyLoose } from "@/components/copilot/leg-key";

describe("leg identity survives an amount being filled in", () => {
  /**
   * The observed failure: a carry's borrow leg was planned as "Borrow XLM", the user typed
   * 15, and the executor returned "Borrow 15 XLM". The exact keys differ, so the resolved
   * leg was appended instead of updating the original — leaving the original stuck on
   * "paused · needs input" with its question still open, a duplicate row reporting settled,
   * a leg count of 5 for a 4-step plan, and a restarted server index that renumbered leg 2
   * as leg 1.
   */
  it("exact keys differ once the amount is known", () => {
    expect(legKey("Borrow XLM")).not.toBe(legKey("Borrow 15 XLM"));
  });

  it("loose keys match, so the original is updated not duplicated", () => {
    expect(legKeyLoose("Borrow XLM")).toBe(legKeyLoose("Borrow 15 XLM"));
  });

  it("knows which side carries the amount", () => {
    expect(labelHasAmount("Borrow XLM")).toBe(false);
    expect(labelHasAmount("Borrow 15 XLM")).toBe(true);
  });

  it("never collapses two real borrows of different sizes", () => {
    // Both carry amounts, so the loose path is never taken for this pair.
    expect(labelHasAmount("Borrow 15 XLM")).toBe(true);
    expect(labelHasAmount("Borrow 20 XLM")).toBe(true);
    expect(legKey("Borrow 15 XLM")).not.toBe(legKey("Borrow 20 XLM"));
  });

  it("keeps different assets apart even loosely", () => {
    expect(legKeyLoose("Borrow XLM")).not.toBe(legKeyLoose("Borrow BLUSDC"));
  });

  it("keeps different verbs apart even loosely", () => {
    expect(legKeyLoose("Lend XLM on Earn")).not.toBe(legKeyLoose("Borrow XLM"));
  });

  it("still separates earn from blend for the ambiguous verbs", () => {
    // "supply" means two different legs depending on venue, so venue stays in both keys.
    expect(legKeyLoose("Supply XLM into Blend")).not.toBe(
      legKeyLoose("Supply XLM into the Vanna earn pool"),
    );
  });
});

describe("leg identity survives a USDC variant being filled in", () => {
  /**
   * Observed failure: multi-leg paused on "Lend 125 USDC on Earn" asking which USDC;
   * user picked AQUSDC; executor returned "Lend 125 AQUSDC on Earn". Exact keys differ
   * on the asset, amount-loose also differs, so the resolved leg was appended and the
   * original stayed stuck on clarification forever.
   */
  it("exact keys differ once the variant is known", () => {
    expect(legKey("Lend 125 USDC on Earn")).not.toBe(legKey("Lend 125 AQUSDC on Earn"));
  });

  it("recognises bare USDC resolving to a concrete variant", () => {
    expect(isUsdcVariantResolution("Lend 125 USDC on Earn", "Lend 125 AQUSDC on Earn")).toBe(
      true,
    );
    expect(isUsdcVariantResolution("Lend 125 USDC on Earn", "Lend 125 BLUSDC on Earn")).toBe(
      true,
    );
    expect(isUsdcVariantResolution("Lend 125 USDC on Earn", "Lend 125 SOUSDC on Earn")).toBe(
      true,
    );
  });

  it("never collapses two concrete variants into each other", () => {
    expect(isUsdcVariantResolution("Lend 125 BLUSDC on Earn", "Lend 125 AQUSDC on Earn")).toBe(
      false,
    );
  });

  it("still requires the same verb, amount, and venue", () => {
    expect(isUsdcVariantResolution("Lend 125 USDC on Earn", "Lend 250 AQUSDC on Earn")).toBe(
      false,
    );
    expect(isUsdcVariantResolution("Lend 125 USDC on Earn", "Borrow 125 AQUSDC")).toBe(false);
    expect(
      isUsdcVariantResolution("Supply 125 USDC into Blend", "Supply 125 AQUSDC on Earn"),
    ).toBe(false);
  });
});
