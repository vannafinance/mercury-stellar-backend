/**
 * Phase 3 differential harness — workflow expand vs legacy expand.
 *
 * Gate from COPILOT_CONSOLIDATION_PLAN: an op moves only when the two expanders
 * produce an identical step list over the corpus. Empty diff = safe.
 */
import { describe, expect, it } from "vitest";
import {
  expandPlanWrites,
  expandPlanWritesLegacy,
  type PlanStep,
} from "@/lib/copilot/multi-leg-agent";
import { WORKFLOWS, workflowLegCount } from "@/lib/copilot/registry/workflows";
import { routeMessage } from "@/lib/copilot/router";

function writeStep(
  op: string,
  opts: Partial<PlanStep> & { asset?: string | null; amount?: number | null } = {},
): PlanStep {
  return {
    kind: "write",
    op,
    asset: opts.asset ?? null,
    amount: opts.amount ?? null,
    args: opts.args ?? {},
    ...opts,
  } as PlanStep;
}

/** Comparable fingerprint of an expanded leg list (order + money fields). */
function finger(legs: ReturnType<typeof expandPlanWrites>) {
  return legs.map((l) => ({
    op: l.op,
    asset: l.asset ?? null,
    amount: l.amount ?? null,
    leverage: l.leverage ?? null,
    borrow_asset: l.borrow_asset ?? null,
    token_in: l.token_in ?? null,
    token_out: l.token_out ?? null,
    label: l.label,
    multi_leg: l.multi_leg ?? false,
  }));
}

function assertSameExpand(steps: PlanStep[], label: string) {
  const via = finger(expandPlanWrites(steps));
  const legacy = finger(expandPlanWritesLegacy(steps));
  expect(via, label).toEqual(legacy);
}

describe("Phase 3 — workflows registry", () => {
  it("declares every op group the plan named", () => {
    const ids = Object.keys(WORKFLOWS);
    for (const need of [
      "create_account",
      "lend",
      "redeem",
      "deploy_to_blend",
      "supply_to_blend",
      "swap",
      "deposit_collateral",
      "borrow",
      "deposit_and_borrow",
    ]) {
      expect(ids, need).toContain(need);
    }
  });

  it("documents non-atomic margin + farm splits", () => {
    expect(WORKFLOWS.deposit_and_borrow.atomic).toBe(false);
    expect(WORKFLOWS.deposit_and_borrow.splitWhy).toMatch(/is_borrow_allowed/i);
    expect(WORKFLOWS.deploy_to_blend.steps.map((s) => s.op)).toEqual([
      "deposit_collateral",
      "borrow",
      "supply_to_blend",
    ]);
  });

  it("leg counts match expand for levered ops", () => {
    expect(workflowLegCount("deploy_to_blend", 2)).toBe(3);
    expect(workflowLegCount("deploy_to_blend", 1)).toBe(1);
    expect(workflowLegCount("deposit_and_borrow", 2)).toBe(2);
    expect(workflowLegCount("lend", null)).toBe(1);
  });
});

describe("Phase 3 — differential expand (empty diff gate)", () => {
  // ── Account lifecycle ───────────────────────────────────────────────────
  it("create_account", () => {
    assertSameExpand([writeStep("create_account")], "create_account");
  });

  // ── Earn ────────────────────────────────────────────────────────────────
  it("lend / redeem", () => {
    assertSameExpand([writeStep("lend", { asset: "XLM", amount: 20 })], "lend");
    assertSameExpand([writeStep("redeem", { asset: "BLUSDC", amount: 5 })], "redeem");
  });

  // ── Farm ────────────────────────────────────────────────────────────────
  it("unlevered + levered Blend", () => {
    assertSameExpand(
      [writeStep("supply_to_blend", { asset: "BLUSDC", amount: 10 })],
      "supply 1x",
    );
    assertSameExpand(
      [
        writeStep("deploy_to_blend", {
          asset: "BLUSDC",
          amount: 10,
          args: { leverage: 2 },
        }),
      ],
      "deploy 2x",
    );
  });

  it("swap keeps token pair", () => {
    assertSameExpand(
      [
        writeStep("swap", {
          amount: 10,
          args: { token_in: "XLM", token_out: "BLUSDC", amount: 10 },
        }),
      ],
      "swap",
    );
  });

  // ── Margin ──────────────────────────────────────────────────────────────
  it("atomic margin legs", () => {
    assertSameExpand(
      [writeStep("deposit_collateral", { asset: "XLM", amount: 5 })],
      "deposit",
    );
    assertSameExpand([writeStep("borrow", { asset: "XLM", amount: 5 })], "borrow");
    assertSameExpand([writeStep("repay", { asset: "BLUSDC", amount: 2 })], "repay");
  });

  it("same-asset deposit_and_borrow splits; cross-asset stays whole", () => {
    assertSameExpand(
      [
        writeStep("deposit_and_borrow", {
          asset: "BLUSDC",
          amount: 100,
          args: { leverage: 2 },
        }),
      ],
      "same-asset 2x",
    );
    assertSameExpand(
      [
        writeStep("deposit_and_borrow", {
          asset: "AQUSDC",
          amount: 500,
          args: { leverage: 3, borrow_asset: "XLM" },
        }),
      ],
      "cross-asset stays whole",
    );
  });

  it("routed multi-leg prompts match legacy expand", () => {
    const prompts = [
      "park 20 XLM for yield then farm 10 BLUSDC at 2x keep HF above 1.4",
      "swap 10 XLM to BLUSDC then farm Blend at 2x with 10 BLUSDC",
      "deposit 5 XLM as collateral",
      "lend 10 XLM",
    ];
    for (const p of prompts) {
      const routed = routeMessage(p);
      if (routed.kind === "plan") {
        assertSameExpand(routed.steps as PlanStep[], p);
      } else if (routed.kind === "write") {
        assertSameExpand(
          [
            writeStep(routed.op, {
              asset: routed.asset,
              amount: routed.amount,
              args: {
                leverage: routed.leverage,
                borrow_asset: routed.borrow_asset,
              },
            }),
          ],
          p,
        );
      }
    }
  });
});
