import { describe, expect, it } from "vitest";
import { sizeLegs } from "@/lib/copilot/investigation/sizing";
import { matchHealthFactorCeiling, matchMinHealthFactor } from "@/lib/copilot/router";
import { statedCeilingFrom, statedFloorFrom } from "@/lib/copilot/investigation/floor";

/**
 * Two health-factor defects reported live on 21 Sep, from the same message:
 *
 *   "add 100 xlm and deployed my fund in farm ... and HF > 1.3"
 *
 * It produced "Borrow BLUSDC to the 1.3 floor", showed "Health factor after 1.30", and
 * was then refused against that very floor: "The proposed steps do not pass your 1.3
 * health-factor floor (health_floor_breached)". A plan cannot be built and rejected by
 * the same number.
 */

const base = { grossCollateralUsd: "10000", debtUsd: "2000" };

describe("a derived max is sized inside the floor, not onto it", () => {
  const sized = sizeLegs(base, [{ op: "borrow", amountUsd: "max", label: "Borrow to the floor" }], "1.3");

  it("sizes the borrow", () => {
    expect(sized.ok).toBe(true);
  });

  /**
   * The whole point: landing ON the floor is what made the plan invalid the instant
   * debt accrued between sizing and the pre-write re-validation.
   */
  it("leaves the health factor strictly above the floor, not equal to it", () => {
    if (!sized.ok) throw new Error(sized.reason);
    const hf = Number(sized.finalHealthFactor);
    expect(hf).toBeGreaterThan(1.3);
  });

  it("gives up only a sliver of borrowing power — it is a margin, not a different answer", () => {
    if (!sized.ok) throw new Error(sized.reason);
    const hf = Number(sized.finalHealthFactor);
    // One basis point of a 1.3 floor is 0.00013 of health factor.
    expect(hf).toBeLessThan(1.3005);
  });

  it("re-validates against the floor it was sized for, which is the check that used to fail", () => {
    if (!sized.ok) throw new Error(sized.reason);
    const again = sizeLegs(
      base,
      [{ op: "borrow", amountUsd: sized.legs[0]!.amountUsd, label: "Borrow, restated" }],
      "1.3",
    );
    expect(again.ok).toBe(true);
  });

  /**
   * G=10000, D=2000, floor 1.3. A borrow adds to BOTH sides, so the exact max is
   * ~24666.67 (HF lands on 1.3) and the margined max is ~24655.1.
   *
   * An amount BETWEEN the two is the interesting case: larger than this change would
   * size, but still inside the floor. It must be accepted, because the margin is a
   * sizing choice and must never become a stricter gate on what the user asked for.
   */
  it("accepts a stated amount above the margined max but still inside the floor", () => {
    const stated = sizeLegs(base, [{ op: "borrow", amountUsd: "24660", label: "Borrow 24660" }], "1.3");
    expect(stated.ok).toBe(true);
    if (stated.ok) expect(Number(stated.finalHealthFactor)).toBeGreaterThan(1.3);
  });

  it("still refuses a stated amount that genuinely breaches the floor", () => {
    // 24700 pushes HF to ~1.2996 — under the floor, and correctly refused.
    const tooBig = sizeLegs(base, [{ op: "borrow", amountUsd: "24700", label: "Borrow 24700" }], "1.3");
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.reason).toBe("health_floor_breached");
  });
});

/**
 * `matchMinHealthFactor` reads `>=?`, so "HF > 1.3" is a floor. It reads no ceiling at
 * all, so "HF < 1.3" matched nothing and the turn ran with NO health-factor constraint
 * while the user believed they had set one.
 */
describe("a health-factor ceiling is read, not silently dropped", () => {
  it("still reads '>' and '>=' as the floor they always were", () => {
    expect(matchMinHealthFactor("keep HF > 1.3")?.value).toBe(1.3);
    expect(matchMinHealthFactor("keep HF >= 1.3")?.value).toBe(1.3);
    expect(matchMinHealthFactor("keep hf at least 1.3")?.value).toBe(1.3);
  });

  it("recognises the ceiling phrasings that used to parse as nothing", () => {
    expect(matchHealthFactorCeiling("keep HF < 1.3")).toBe(1.3);
    expect(matchHealthFactorCeiling("HF below 1.3")).toBe(1.3);
    expect(matchHealthFactorCeiling("keep hf under 1.25")).toBe(1.25);
  });

  it("a ceiling is not a floor — it must not be quietly turned into one", () => {
    expect(statedFloorFrom(["keep HF < 1.3"])).toBeNull();
    expect(statedCeilingFrom(["keep HF < 1.3"])).toBe("1.3");
  });

  /**
   * The negated forms are FLOORS and already parsed as such. A sentence that is a floor
   * can never also be a ceiling, which is why the floor is resolved first and wins.
   */
  it("leaves 'do not let hf go below 1.3' as the floor it is", () => {
    expect(statedFloorFrom(["do not let hf go below 1.3"])).toBe("1.3");
    expect(statedCeilingFrom(["do not let hf go below 1.3"])).toBeNull();
  });

  it("reports no ceiling when a real floor was stated in the same breath", () => {
    expect(statedCeilingFrom(["keep HF above 1.4"])).toBeNull();
  });

  it("says nothing when no health factor was mentioned at all", () => {
    expect(statedCeilingFrom(["swap 10 XLM for AQUSDC"])).toBeNull();
    expect(matchHealthFactorCeiling("swap 10 XLM for AQUSDC")).toBeNull();
  });
});
