import { describe, it, expect } from "vitest";
import { freezePlan, verifyApprovedPlan } from "@/lib/copilot/plan-approval";
import type { RoutedIntent } from "@/lib/copilot/types";

/**
 * "Do X, then tell me Y" is two instructions. The read leg used to be filtered out of the
 * frozen plan, so the card showed one step, the fingerprint did not cover the question,
 * and approval replayed a plan the second half had been silently removed from.
 */
const plan = {
  kind: "plan",
  template_id: "write_then_report",
  summary: "lend 15 SOUSDC, then report account health",
  steps: [
    { kind: "write", op: "lend", asset: "SOUSDC", amount: 15 },
    { kind: "read", tool: "vanna_get_account_health", args: {} },
  ],
} as Extract<RoutedIntent, { kind: "plan" }>;

describe("plan read legs", () => {
  it("keeps the read leg on the card but not in the signature count", () => {
    const f = freezePlan(plan, 1_000_000);
    expect(f.steps.map((s) => s.kind)).toEqual(["write", "read"]);
    // One signature: the lend. A report asks nothing of the wallet.
    expect(f.signature_count).toBe(1);
    expect(f.steps[1].label).toMatch(/report account health/i);
    // The "no amount yet" warning is about a write that will stop to ask — a read has
    // no size to be missing, so it must not trigger it.
    expect(f.warnings.join(" ")).not.toMatch(/no amount yet/i);
  });

  it("round-trips through approval and replays the read leg", () => {
    const f = freezePlan(plan, 1_000_000);
    const approved = {
      plan_id: f.plan_id,
      created_at: f.created_at,
      steps: f.steps.map((s) => ({
        kind: s.kind,
        tool: s.tool ?? null,
        op: s.op,
        slots: s.slots,
        asset: s.asset,
        amount: s.amount,
        leverage: s.leverage,
        borrow_asset: s.borrow_asset ?? null,
      })),
    };
    const check = verifyApprovedPlan(approved as never, 1_000_500);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.plan.steps.map((s) => s.kind)).toEqual(["write", "read"]);
    expect(check.plan.steps[1].tool).toBe("vanna_get_account_health");
  });

  it("refuses a plan whose reporting step was dropped after approval", () => {
    const f = freezePlan(plan, 1_000_000);
    // A client that strips the read leg must fail the fingerprint, exactly as one that
    // strips a slot does — otherwise the question can be removed after approval.
    const tampered = {
      plan_id: f.plan_id,
      created_at: f.created_at,
      steps: [{ kind: "write", op: "lend", slots: f.steps[0].slots }],
    };
    const check = verifyApprovedPlan(tampered as never, 1_000_500);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toBe("fingerprint_mismatch");
  });
});
