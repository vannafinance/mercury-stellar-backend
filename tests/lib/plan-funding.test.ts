import { describe, expect, it } from "vitest";
import { PLAN_TTL_MS } from "@/lib/copilot/plan-ttl";
import { freezePlan, verifyApprovedPlan } from "@/lib/copilot/plan-approval";
import {
  earnDepositKey,
  fundingCovers,
  marginBalanceKey,
  projectFundingRows,
  spendPocket,
  walletBalanceKey,
} from "@/lib/copilot/plan-funding";
import { stepFundingPreview, type ProposalStep, type WorkflowView } from "@/lib/copilot/workflow/types";

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

  it("credits planned deposits before checking both legs of a later LP step", () => {
    const proposalSteps: ProposalStep[] = [
      { id: "deposit-xlm", op: "deposit_collateral", asset: "XLM", amount: "100", label: "Deposit XLM",
        tool: "vanna_deposit_collateral", args: {} },
      { id: "deposit-sousdc", op: "deposit_collateral", asset: "SOUSDC", amount: "25000", label: "Deposit SOUSDC",
        tool: "vanna_deposit_collateral", args: {} },
      { id: "lp", op: "add_liquidity", asset: "XLM", amount: "100", label: "Add liquidity",
        tool: "vanna_add_liquidity", args: { token_b: "SOUSDC", amount_b: "29.0724972" } },
    ];
    const steps = proposalSteps.map((step) => ({
      id: step.id, op: step.op, asset: step.asset, amount: step.amount, label: step.label,
      funding: stepFundingPreview(step), status: "pending" as const,
    })) satisfies WorkflowView["steps"];
    const balances = new Map([
      ["wallet:XLM", 7450.0805377], ["wallet:SOUSDC", 25000],
      ["account:XLM", 50.6250002], ["account:SOUSDC", 0],
    ]);

    const rows = projectFundingRows(steps, (pocket, asset) => balances.get(`${pocket}:${asset}`) ?? null);
    expect(rows.find((row) => row.id === "lp:account:XLM")).toMatchObject({
      available: 150.6250002, needed: 100, projected: true,
    });
    expect(rows.find((row) => row.id === "lp:account:SOUSDC")).toMatchObject({
      available: 25000, needed: 29.0724972, projected: true,
    });
    expect(rows.every((row) => fundingCovers(row.available, row.needed) !== false)).toBe(true);
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
