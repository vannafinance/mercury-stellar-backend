import { describe, expect, it } from "vitest";
import { isMarginHealthOp, shouldPauseForHealthFloor } from "@/lib/copilot/hf-pause";

describe("shouldPauseForHealthFloor", () => {
  it("pauses when HF drops below a stated floor on a borrow tail", () => {
    expect(
      shouldPauseForHealthFloor({
        floor: 2,
        hf: 1.5,
        remainingOps: ["borrow"],
        settledOps: ["deposit_collateral"],
      }),
    ).toBe(true);
  });

  it("pauses when the borrow already landed and only farm remains", () => {
    expect(
      shouldPauseForHealthFloor({
        floor: 2,
        hf: 1.5,
        remainingOps: ["supply_to_blend"],
        settledOps: ["deposit_collateral", "borrow"],
      }),
    ).toBe(true);
  });

  it("does not pause a swap → LP run even if HF is below a painted floor", () => {
    expect(
      shouldPauseForHealthFloor({
        floor: 2,
        hf: 1.5,
        remainingOps: ["add_liquidity"],
        settledOps: ["swap"],
      }),
    ).toBe(false);
  });

  it("does not pause when HF is at or above the floor", () => {
    expect(
      shouldPauseForHealthFloor({
        floor: 2,
        hf: 2,
        remainingOps: ["borrow"],
        settledOps: ["deposit_collateral"],
      }),
    ).toBe(false);
  });

  it("does not pause with no remaining legs", () => {
    expect(
      shouldPauseForHealthFloor({
        floor: 2,
        hf: 1.5,
        remainingOps: [],
        settledOps: ["borrow"],
      }),
    ).toBe(false);
  });

  it("does not pause without a numeric floor or HF", () => {
    expect(
      shouldPauseForHealthFloor({
        floor: null,
        hf: 1.5,
        remainingOps: ["borrow"],
      }),
    ).toBe(false);
    expect(
      shouldPauseForHealthFloor({
        floor: 2,
        hf: null,
        remainingOps: ["borrow"],
      }),
    ).toBe(false);
  });
});

describe("isMarginHealthOp", () => {
  it("treats collateral and debt writes as margin health ops", () => {
    expect(isMarginHealthOp("deposit_collateral")).toBe(true);
    expect(isMarginHealthOp("borrow")).toBe(true);
    expect(isMarginHealthOp("repay")).toBe(true);
    expect(isMarginHealthOp("swap")).toBe(false);
    expect(isMarginHealthOp("add_liquidity")).toBe(false);
  });
});
