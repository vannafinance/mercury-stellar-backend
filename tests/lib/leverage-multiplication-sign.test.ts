/**
 * The app's own rendered summaries and labels write leverage as "2×" (U+00D7), not "2x"
 * (see step-extractor.ts's summary text and plan-approval.ts's labelFor) — but both
 * `findLeverage` (router.ts) and step-extractor.ts's own LEVERAGE regex matched only
 * ascii "x". A message containing a resent/rendered "at 2×" summary therefore silently
 * lost its leverage on any round trip, surfacing live as a leveraged plan resuming with
 * no leverage at all.
 */
import { describe, expect, it } from "vitest";
import { findLeverage } from "@/lib/copilot/router";

describe("findLeverage accepts the × multiplication sign the same as ascii x", () => {
  it("reads '2×' the same as '2x'", () => {
    expect(findLeverage("farm Blend at 2× with 10 BLUSDC")).toBe(2);
    expect(findLeverage("farm Blend at 2x with 10 BLUSDC")).toBe(2);
  });

  it("reads '3×' with no space before it", () => {
    expect(findLeverage("deploy at 3×")).toBe(3);
  });

  it("does not treat a bare '×' with no number as leverage", () => {
    expect(findLeverage("what does × mean")).toBeNull();
  });
});
