import { afterEach, describe, expect, it } from "vitest";
import { freezePlan } from "@/lib/copilot/plan-approval";
import {
  armStandingOrder,
  createStandingOrder,
  evaluateStandingOrders,
  parseStandingOrder,
  resetStandingOrders,
} from "@/lib/copilot/standing-orders";

const TRADER = "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5";

afterEach(() => resetStandingOrders());

function frozenRepay(now: number) {
  return freezePlan(
    {
      kind: "plan",
      template_id: "standing_repay",
      steps: [{ kind: "write", op: "repay", asset: "XLM", amount: 10 }],
    },
    now,
  );
}

describe("parseStandingOrder", () => {
  it("reads a health-factor trigger plus a sized action", () => {
    expect(parseStandingOrder("when my health factor drops below 1.2 repay 10 XLM")).toEqual({
      trigger: { kind: "health_factor", op: "below", value: "1.2" },
      action: { op: "repay", asset: "XLM", amount: "10" },
    });
  });

  it("does not invent an action when the user only asked to watch", () => {
    expect(parseStandingOrder("keep an eye on my position and pull collateral if it gets risky")).toBeNull();
  });
});

describe("evaluateStandingOrders", () => {
  it("does not fire a mandate that has not been approved", () => {
    createStandingOrder({
      subject: "user",
      trader: TRADER,
      smartAccount: null,
      trigger: { kind: "health_factor", op: "below", value: "2" },
      action: { op: "repay", asset: "XLM", amount: "10" },
    });
    const due = evaluateStandingOrders({
      liveFor: () => ({ healthFactor: 1.1, priceUsd: null }),
    });
    expect(due).toEqual([]);
  });

  it("returns an armed order whose trigger is met without executing it", () => {
    const now = Date.now();
    const order = createStandingOrder({
      subject: "user",
      trader: TRADER,
      smartAccount: null,
      trigger: { kind: "health_factor", op: "below", value: "2" },
      action: { op: "repay", asset: "XLM", amount: "10" },
      now,
    });
    const frozen = frozenRepay(now);
    const armed = armStandingOrder(order.id, {
      plan_id: frozen.plan_id,
      created_at: frozen.created_at,
      steps: frozen.steps.map((step) => ({
        op: step.op,
        slots: step.slots,
        asset: step.asset,
        amount: step.amount,
        leverage: step.leverage,
        borrow_asset: step.borrow_asset,
      })),
    }, now);
    expect(armed.status).toBe("armed");
    const due = evaluateStandingOrders({
      now,
      liveFor: () => ({ healthFactor: 1.1, priceUsd: null }),
    });
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe(order.id);
    expect(due[0].status).toBe("armed");
  });
});
