import { describe, expect, it } from "vitest";

import {
  DEFAULT_GUARDIAN_FLOOR,
  extractStatedFloor,
  judgeFloor,
  parseStatedFloor,
} from "@/lib/copilot/guardian-floor";

describe("extractStatedFloor — reads the number the user actually typed", () => {
  it("parses the live prompt that the old regex missed (abbreviation + 'the')", () => {
    expect(
      extractStatedFloor(
        "Create a startegy in such a way that My HF will stay above the 1.1 and use USDC and XLM as collateral and deploy them in farm",
      ),
    ).toBe(1.1);
  });

  it.each([
    ["keep health factor above 1.15", 1.15],
    ["keep my HF over 1.2", 1.2],
    ["maintain HF at least 1.5", 1.5],
    ["health factor >= 1.4", 1.4],
    ["hf of 1.35 please", 1.35],
    ["Health Factor above the 1.25", 1.25],
  ])("%s → %s", (text, expected) => {
    expect(extractStatedFloor(text)).toBe(expected);
  });

  it("ignores numbers that are not a health factor", () => {
    expect(extractStatedFloor("borrow above 50 USDC")).toBeNull(); // no HF mention
    expect(extractStatedFloor("keep HF above 100")).toBeNull(); // implausible
    expect(extractStatedFloor("what is the XLM price?")).toBeNull();
  });
});

describe("judgeFloor — honours the user above the line, refuses at or under it", () => {
  it("rejects anything at or under the 1.1 liquidation line, and says which floor stays", () => {
    for (const v of [1.0, 1.05, 1.1]) {
      const r = judgeFloor(v, 1.3);
      expect(r.verdict).toBe("reject");
      expect(r.message).toMatch(/liquidation line/);
      expect(r.message).toMatch(/Keeping your floor at 1\.30/);
      expect(r.message).toMatch(/1\.15/); // tells them what to say instead
    }
  });

  it("accepts a thin floor like 1.15 and warns how thin it is", () => {
    const r = judgeFloor(1.15);
    expect(r.verdict).toBe("warn");
    expect(r.value).toBe(1.15);
    expect(r.message).toMatch(/Floor set to 1\.15/);
    expect(r.message).toMatch(/4\.5% buffer/);
    expect(r.message).toMatch(/auto-repay at 1\.15/);
  });

  it("accepts 1.2 as the last thin value, and 1.21+ silently", () => {
    expect(judgeFloor(1.2).verdict).toBe("warn");
    expect(judgeFloor(1.21).verdict).toBe("ok");
    expect(judgeFloor(1.5)).toEqual({ verdict: "ok", value: 1.5, message: null });
  });
});

describe("parseStatedFloor — the one call the workspace makes", () => {
  it("returns null when no floor is stated", () => {
    expect(parseStatedFloor("lend my idle USDC")).toBeNull();
  });

  it("the live prompt: 1.1 is rejected, not silently replaced", () => {
    const r = parseStatedFloor("My HF will stay above the 1.1 and use USDC", DEFAULT_GUARDIAN_FLOOR);
    expect(r?.verdict).toBe("reject");
    expect(r?.value).toBe(1.1);
  });

  it("the user's example: 1.15 is executed with a warning", () => {
    const r = parseStatedFloor("keep health factor above 1.15");
    expect(r?.verdict).toBe("warn");
    expect(r?.value).toBe(1.15);
  });
});
