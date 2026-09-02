import { describe, expect, it } from "vitest";
import {
  BORROW_ORIGINATION_FEE_BUFFER,
  capToFreeBalance,
  netOfOriginationFee,
} from "@/lib/borrow-fee";
import { expandPlanWrites } from "@/lib/copilot/multi-leg-agent";

describe("netOfOriginationFee", () => {
  it("shaves ~0.35% so gross borrow is never spent in full", () => {
    expect(netOfOriginationFee(10)).toBeLessThan(10);
    expect(netOfOriginationFee(10)).toBeCloseTo(10 * BORROW_ORIGINATION_FEE_BUFFER, 5);
  });

  it("floors to 7 decimals (no floating overshoot)", () => {
    const n = netOfOriginationFee(10);
    expect(n).toBe(Math.floor(n * 1e7) / 1e7);
  });
});

describe("capToFreeBalance", () => {
  it("caps requested above free balance — the live #10 bug", () => {
    const r = capToFreeBalance(10, 9.965);
    expect(r.capped).toBe(true);
    expect(r.amount).toBeLessThanOrEqual(9.965);
    expect(r.amount).toBeGreaterThan(9);
  });

  it("passes through when free covers the ask", () => {
    const r = capToFreeBalance(9.965, 9.965);
    expect(r.capped).toBe(false);
    expect(r.amount).toBe(9.965);
  });

  it("returns 0 when free is empty", () => {
    expect(capToFreeBalance(10, 0).amount).toBe(0);
  });
});

describe("levered Blend expand uses net borrow for supply", () => {
  it("does not plan supply equal to gross borrow (HostError #10)", () => {
    const legs = expandPlanWrites([
      {
        kind: "write",
        op: "deploy_to_blend",
        asset: "BLUSDC",
        amount: 10,
        leverage: 2,
        label: "Farm 10 BLUSDC at 2x",
      } as Parameters<typeof expandPlanWrites>[0][number],
    ]);
    const supply = legs.find((l) => l.op === "supply_to_blend");
    const borrow = legs.find((l) => l.op === "borrow");
    expect(borrow?.amount).toBe(10);
    expect(supply?.amount).toBe(netOfOriginationFee(10));
    expect(supply!.amount!).toBeLessThan(borrow!.amount!);
  });
});
