import { describe, expect, it } from "vitest";
import { PLAN_TTL_MS } from "@/lib/copilot/plan-ttl";
import { freezePlan, verifyApprovedPlan } from "@/lib/copilot/plan-approval";
import {
  earnDepositKey,
  fundingCovers,
  marginBalanceKey,
  spendPocket,
  walletBalanceKey,
} from "@/lib/copilot/plan-funding";

describe("plan wait-to-approve funding", () => {
  it("keeps a plan clickable for hours, not five minutes", () => {
    expect(PLAN_TTL_MS).toBe(24 * 60 * 60_000);
    expect(10 * 60_000).toBeLessThan(PLAN_TTL_MS);
  });

  it("maps Earn and wallet spellings onto the live wallet store", () => {
    expect(walletBalanceKey("XLM")).toBe("XLM");
    expect(walletBalanceKey("BLUSDC")).toBe("BLEND_USDC");
    expect(walletBalanceKey("USDC")).toBe("BLEND_USDC");
    expect(walletBalanceKey("AQUSDC")).toBe("AQUARIUS_USDC");
    expect(earnDepositKey("BLUSDC")).toBe("USDC");
    expect(marginBalanceKey("BLUSDC")).toBe("USDC");
  });

  it("only treats wallet, Earn and account spends as balance checks", () => {
    expect(spendPocket("lend")).toBe("wallet");
    expect(spendPocket("redeem")).toBe("earn");
    expect(spendPocket("deposit_collateral")).toBe("wallet");
    expect(spendPocket("repay")).toBe("account");
    expect(spendPocket("borrow")).toBeNull();
    expect(spendPocket("swap")).toBe("account");
  });

  it("does not block Approve when the live read is missing", () => {
    expect(fundingCovers(null, 100)).toBeNull();
    expect(fundingCovers(100, 100)).toBe(true);
    expect(fundingCovers(99, 100)).toBe(false);
  });

  it("still accepts a frozen plan after several minutes of waiting", () => {
    const created = 1_700_000_000_000;
    const frozen = freezePlan(
      {
        kind: "plan",
        template_id: "lend_xlm",
        steps: [{ kind: "write", op: "lend", asset: "XLM", amount: 100, args: {} }],
      },
      created,
    );
    const approved = {
      plan_id: frozen.plan_id,
      created_at: frozen.created_at,
      steps: frozen.steps.map((s) => ({ op: s.op, slots: s.slots, asset: s.asset, amount: s.amount })),
    };
    expect(verifyApprovedPlan(approved, created + 10 * 60_000).ok).toBe(true);
    expect(verifyApprovedPlan(approved, created + PLAN_TTL_MS + 1).ok).toBe(false);
  });
});
