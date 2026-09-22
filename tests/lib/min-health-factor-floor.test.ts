import { describe, expect, it } from "vitest";
import { parseMinHealthFactor } from "@/lib/copilot/router";

/**
 * How users actually state a health-factor floor.
 *
 * The owner's own acceptance prompt says "so health factor does not go below 1.3", and
 * that phrasing parsed as NO floor — the matcher only knew "above / over / at least".
 * A floor that does not parse is not enforced anywhere, including the write-risk gate,
 * so the constraint the user cared most about was silently dropped.
 */
describe("parseMinHealthFactor — floor phrasings", () => {
  it.each([
    ["Use both USDC and XLM to build a strategy so health factor does not go below 1.3.", 1.3],
    ["keep health factor above 1.3", 1.3],
    ["health factor should not drop below 1.45", 1.45],
    ["make sure my HF never falls below 2", 2],
    ["hf must not go under 1.75", 1.75],
    ["health factor no lower than 1.6", 1.6],
    ["do not let the health factor dip below 1.25", 1.25],
    ["maintain my health factor at least 1.5", 1.5],
  ])("reads %s as %s", (message, expected) => {
    expect(parseMinHealthFactor(message)).toBe(expected);
  });

  it("does not invent a floor from an unrelated number", () => {
    expect(parseMinHealthFactor("swap 10 XLM to AQUSDC then add liquidity")).toBeNull();
    expect(parseMinHealthFactor("deposit 5 XLM as collateral")).toBeNull();
  });
});
