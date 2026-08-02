import { describe, it, expect } from "vitest";
import {
  expandPlanWrites,
  humanWriteLabel,
  humanizeLegError,
  multiLegHeadline,
  multiLegUiData,
} from "@/lib/copilot/multi-leg-agent";
import { routeMessage } from "@/lib/copilot/router";
// multiLegUiData already imported above

describe("multi-leg-agent expand", () => {
  it("expands park+farm plan into 4 clean legs", () => {
    const routed = routeMessage(
      "park 20 XLM for yield then farm 10 BLUSDC at 2x keep HF above 1.4",
    );
    expect(routed.kind).toBe("plan");
    if (routed.kind !== "plan") return;

    const expanded = expandPlanWrites(routed.steps);
    expect(expanded).toHaveLength(4);
    expect(expanded.map((e) => e.op)).toEqual([
      "lend",
      "deposit_collateral",
      "borrow",
      "supply_to_blend",
    ]);
    expect(expanded[0].amount).toBe(20);
    expect(expanded[1].amount).toBe(10);
    expect(expanded[2].amount).toBe(10);
    expect(expanded[3].amount).toBe(10);
    for (const e of expanded) {
      expect(e.label).not.toMatch(/leg\s*\d|2×\s*leg/i);
    }
  });

  it("human labels stay product-grade", () => {
    expect(humanWriteLabel("borrow", 10, "BLUSDC")).toBe("Borrow 10 BLUSDC");
    expect(humanWriteLabel("lend", 20, "XLM")).toBe("Lend 20 XLM on Earn");
  });
});

describe("multi-leg-agent errors + UI payload", () => {
  it("humanizes fetch failed", () => {
    const msg = humanizeLegError("fetch failed");
    expect(msg.toLowerCase()).toMatch(/mcp|network|reach/);
    expect(msg).not.toBe("fetch failed");
  });

  it("builds clean multi_leg ui data", () => {
    const steps = [
      {
        index: 1,
        op: "lend",
        label: "Lend 20 XLM on Earn",
        status: "error" as const,
        message: "fetch failed",
      },
      {
        index: 2,
        op: "borrow",
        label: "Borrow 10 BLUSDC",
        status: "skipped" as const,
        message: "Skipped",
      },
    ];
    expect(multiLegHeadline(steps)).toMatch(/Stopped at/);
    const data = multiLegUiData({
      steps,
      summary: "test",
      minHf: 1.4,
      smartAccount: "CBOQAN5NFII4P5HD73M2IRSFYZSXC5XC76FQWQ5JU7LJAO66TFFPG5XY",
    });
    expect(data.multi_leg).toBe(true);
    expect(data.headline).toBeTruthy();
    expect(Array.isArray(data.multi_leg_steps)).toBe(true);
    const first = (data.multi_leg_steps as Array<{ message: string }>)[0];
    expect(first.message).not.toBe("fetch failed");
  });
});

describe("single-op regression", () => {
  it("does not turn simple deposit into a plan", () => {
    const r = routeMessage("deposit 5 XLM as collateral");
    expect(r.kind).toBe("write");
    if (r.kind === "write") expect(r.op).toBe("deposit_collateral");
  });

  it("keeps health as a read", () => {
    const r = routeMessage("what is my health factor");
    expect(r.kind).toBe("read");
  });
});

describe("planner breadth + resume payload", () => {
  it("plans repay then deposit as multi-goal", () => {
    const r = routeMessage("repay 5 BLUSDC then deposit 10 XLM as collateral");
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    const ops = r.steps.filter((s) => s.kind === "write").map((s) => s.op);
    expect(ops).toContain("repay");
    expect(ops.some((o) => o === "deposit_collateral" || o === "deposit_and_borrow")).toBe(true);
  });

  it("does not treat Blend as lend (substring bug)", () => {
    const r = routeMessage("swap 10 XLM to BLUSDC then farm Blend at 2x with 10 BLUSDC");
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    const ops = r.steps.filter((s) => s.kind === "write").map((s) => s.op);
    expect(ops).not.toContain("lend");
    expect(ops[0]).toBe("swap");
    expect(ops).toContain("deploy_to_blend");
    const expanded = expandPlanWrites(r.steps);
    expect(expanded.map((e) => e.op)).toEqual([
      "swap",
      "deposit_collateral",
      "borrow",
      "supply_to_blend",
    ]);
    expect(expanded[0].token_out).toBe("BLUSDC");
  });

  it("exposes resume_legs when steps failed", () => {
    const data = multiLegUiData({
      summary: "test",
      minHf: 1.4,
      steps: [
        {
          index: 1,
          op: "lend",
          label: "Lend 20 XLM on Earn",
          asset: "XLM",
          amount: 20,
          status: "error",
          message: "network",
        },
        {
          index: 2,
          op: "borrow",
          label: "Borrow 10 BLUSDC",
          asset: "BLUSDC",
          amount: 10,
          status: "skipped",
          message: "skip",
        },
      ],
    });
    expect(data.can_resume).toBe(true);
    expect(Array.isArray(data.resume_legs)).toBe(true);
    expect((data.resume_legs as unknown[]).length).toBe(2);
  });
});
