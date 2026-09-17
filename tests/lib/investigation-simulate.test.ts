/**
 * Propose-time simulation — `simulate.ts`. The protocol's preview is asked about every
 * step that can be asked about; a "no" removes the option with the protocol's sentence;
 * silence never counts as "yes"; a step that follows from an earlier one is projected,
 * not simulated, and the card says so.
 */

import { describe, expect, it, vi } from "vitest";
import { dependsOnEarlier, simulateCandidates, simulateSteps } from "@/lib/copilot/investigation/simulate";
import type { Candidate } from "@/lib/copilot/investigation/candidates";
import type { ProposalStep } from "@/lib/copilot/workflow/types";

const SCOPE = { trader: "GTRADER", smartAccount: "CACCOUNT" };
const step = (id: string, op: ProposalStep["op"], amount: string, symbol = "XLM"): ProposalStep => ({
  id, op, asset: "XLM", amount, label: `${op} ${amount} XLM`, tool: `vanna_${op}`,
  args: op === "lend" || op === "redeem" ? { symbol, amount, lender: SCOPE.trader } : { symbol, amount, trader: SCOPE.trader, smart_account: SCOPE.smartAccount },
});
const signal = () => new AbortController().signal;

describe("dependsOnEarlier — from the op-flow table", () => {
  it("a step fed by the one before it, or a margin step after one that moves health, cannot be previewed ahead", () => {
    const deposit = step("s0", "deposit_collateral", "100"), supply = step("s1", "supply_blend", "100"), borrow = step("s2", "borrow", "50");
    expect(dependsOnEarlier([deposit, supply, borrow], 0)).toBe(false);
    expect(dependsOnEarlier([deposit, supply, borrow], 1)).toBe(true);   // takes what the deposit put in
    expect(dependsOnEarlier([deposit, supply, borrow], 2)).toBe(true);   // the deposit raised health first
    const lend = step("l0", "lend", "10"), redeem = step("l1", "redeem", "5");
    expect(dependsOnEarlier([lend, redeem], 1)).toBe(true);              // the lend grows the position the redeem draws on
    expect(dependsOnEarlier([redeem, lend], 1)).toBe(true);              // the redeem lands in the wallet the lend spends
    expect(dependsOnEarlier([lend, step("l2", "deposit_collateral", "5")], 1)).toBe(false); // different pockets: both ask the chain as it is
  });
});

describe("simulateSteps", () => {
  it("asks the margin preview with the step's own arguments and reads the contract's verdict", async () => {
    const mcp = { call: vi.fn(async (tool: string, args: Record<string, unknown>) => {
      expect(tool).toBe("vanna_preview_margin");
      expect(args).toEqual({ symbol: "XLM", amount: "50", operation: "borrow", smart_account: SCOPE.smartAccount });
      return { allowed: true, operation: "borrow", reason: "Borrowing 50 XLM is permitted: projected collateral $150, debt $59, projected LTV 39.33%.",
        limiting_factor: null, projected_position: { collateral_usd: "150", debt_usd: "59", ltv_pct: "39.33", is_healthy: true } };
    }) };
    const result = await simulateSteps([step("s0", "borrow", "50")], SCOPE, mcp, signal());
    expect(result.verdict).toBe("runnable");
    expect(result.steps[0]).toMatchObject({ verdict: "allowed", projected: { collateralUsd: "150", debtUsd: "59", ltvPct: "39.33", healthy: true } });
    expect(result.summary).toBe("Simulated against the protocol: borrow 50 XLM allowed (LTV 39.33% after).");
  });

  it("a refusal carries the protocol's own sentence and the limiting factor", async () => {
    const mcp = { call: vi.fn(async () => ({ allowed: false, reason: "Your collateral supports borrowing 5000 XLM, but pool limit (available_liquidity) is exceeded. Max borrow right now is 1200 XLM.", limiting_factor: "available_liquidity" })) };
    const result = await simulateSteps([step("s0", "borrow", "5000")], SCOPE, mcp, signal());
    expect(result.verdict).toBe("blocked");
    expect(result.steps[0].limitingFactor).toBe("available_liquidity");
    expect(result.summary).toBe('The protocol refuses "borrow 5000 XLM": Your collateral supports borrowing 5000 XLM, but pool limit (available_liquidity) is exceeded. Max borrow right now is 1200 XLM.');
  });

  it("an older server without the action, a timeout or a thrown call never blocks — the option stays, labelled not simulated", async () => {
    const older = { call: vi.fn(async () => ({ error: "invalid_input", message: "Unknown action 'preview' for vanna_margin_status. Allowed: collateral, debt, health." })) };
    const result = await simulateSteps([step("s0", "deposit_collateral", "100")], SCOPE, older, signal());
    expect(result.verdict).toBe("unavailable");
    expect(result.summary).toBe("Not simulated against the protocol: Unknown action 'preview' for vanna_margin_status. Allowed: collateral, debt, health..");
    const thrown = { call: vi.fn(async () => { throw new Error("ECONNRESET"); }) };
    expect((await simulateSteps([step("s0", "lend", "1")], SCOPE, thrown, signal())).steps[0]).toMatchObject({ verdict: "unavailable", reason: "the protocol preview could not be reached" });
  });

  it("previews the first step of a composed plan and says the rest stand on the projection", async () => {
    const mcp = { call: vi.fn(async () => ({ allowed: true, reason: "Depositing 100 XLM is permitted", projected_position: { collateral_usd: "162", debt_usd: "54", ltv_pct: "33.33", is_healthy: true } })) };
    const steps = [step("s0", "deposit_collateral", "100"), step("s1", "supply_blend", "100"), step("s2", "borrow", "50"), step("s3", "supply_blend", "50")];
    const result = await simulateSteps(steps, SCOPE, mcp, signal());
    expect(mcp.call).toHaveBeenCalledTimes(1);
    expect(result.verdict).toBe("partial");
    expect(result.steps.map((s) => s.verdict)).toEqual(["allowed", "dependent", "dependent", "dependent"]);
    expect(result.summary).toBe("Simulated against the protocol: deposit_collateral 100 XLM allowed (LTV 33.33% after); the other 3 steps follow from it and stand on the projection.");
  });

  it("a lone Blend supply asks the RiskEngine preview, not a missing-tool skip", async () => {
    const mcp = { call: vi.fn(async (tool: string, args: Record<string, unknown>) => {
      expect(tool).toBe("vanna_preview_margin");
      expect(args).toEqual({ smart_account: SCOPE.smartAccount, symbol: "XLM", amount: "100", operation: "supply_blend" });
      return { allowed: true, reason: "Supplying to Blend swaps posted tokens for a b-token receipt the RiskEngine values.",
        projected_position: { collateral_usd: "150", debt_usd: "50", ltv_pct: "33.33", is_healthy: true } };
    }) };
    const result = await simulateSteps([step("s0", "supply_blend", "100")], SCOPE, mcp, signal());
    expect(result.verdict).toBe("runnable");
    expect(result.steps[0].verdict).toBe("allowed");
  });

  it("add_liquidity sends the write's token_a/amount_a, not a guessed symbol/amount pair", async () => {
    const mcp = { call: vi.fn(async (tool: string, args: Record<string, unknown>) => {
      expect(tool).toBe("vanna_preview_margin");
      expect(args).toEqual({ smart_account: SCOPE.smartAccount, symbol: "XLM", amount: "10", operation: "add_liquidity" });
      return { allowed: true, reason: "Adding liquidity swaps posted tokens for an LP receipt the RiskEngine values.",
        projected_position: { collateral_usd: "1000", debt_usd: "200", ltv_pct: "20", is_healthy: true } };
    }) };
    const lp: ProposalStep = {
      id: "s0", op: "add_liquidity", asset: "XLM", amount: "10",
      label: "add 10 XLM + 0.75 SOUSDC", tool: "vanna_add_liquidity",
      args: { token_a: "XLM", token_b: "SOUSDC", amount_a: "10", amount_b: "0.75", min_liquidity_out: "1", trader: SCOPE.trader, smart_account: SCOPE.smartAccount, venue: "soroswap" },
    };
    const result = await simulateSteps([lp], SCOPE, mcp, signal());
    expect(result.verdict).toBe("runnable");
    expect(result.steps[0].verdict).toBe("allowed");
  });

  it("remove_liquidity sends the write's liquidity amount", async () => {
    const mcp = { call: vi.fn(async (_tool: string, args: Record<string, unknown>) => {
      expect(args).toEqual({ smart_account: SCOPE.smartAccount, symbol: "SOUSDC", amount: "1.5", operation: "remove_liquidity" });
      return { allowed: true, reason: "ok", projected_position: { collateral_usd: "1000", debt_usd: "200", ltv_pct: "20", is_healthy: true } };
    }) };
    const rm: ProposalStep = {
      id: "s0", op: "remove_liquidity", asset: "SOUSDC", amount: "1.5",
      label: "remove LP", tool: "vanna_remove_liquidity",
      args: { token_a: "XLM", token_b: "SOUSDC", liquidity: "1.5", trader: SCOPE.trader, smart_account: SCOPE.smartAccount, venue: "soroswap" },
    };
    expect((await simulateSteps([rm], SCOPE, mcp, signal())).verdict).toBe("runnable");
  });
});

describe("simulateCandidates", () => {
  const candidate = (id: string, steps: ProposalStep[]): Candidate => ({
    id, kind: "composed", label: id, borrows: false, asset: "XLM", venue: "margin", netAprPct: null, supplyAprPct: "5",
    legs: [], finalHealthFactor: null, amountUsd: "18", evidenceIds: [], amountBasis: "stated", steps,
  });

  it("moves a refused option to the rejected list with the protocol's sentence and labels the rest", async () => {
    const mcp = { call: vi.fn(async (_tool: string, args: Record<string, unknown>) =>
      args.operation === "withdraw"
        ? { allowed: false, reason: "Withdrawing 900 XLM ($162 USD) is NOT permitted: it would leave the account below the 1.1x health threshold against outstanding debt.", limiting_factor: "collateral_health" }
        : { allowed: true, reason: "ok" }) };
    const set = await simulateCandidates({
      feasible: [candidate("a", [step("s0", "withdraw_collateral", "900")]), candidate("b", [step("s0", "repay", "10")]), candidate("c", [])],
      rejected: [{ label: "x", reason: "earlier", asset: "XLM" }],
    }, SCOPE, mcp, signal());
    expect(set.feasible.map((c) => [c.id, c.simulation?.verdict])).toEqual([["b", "runnable"], ["c", undefined]]);
    expect(set.rejected).toEqual([
      { label: "x", reason: "earlier", asset: "XLM" },
      { label: "a", asset: "XLM", reason: 'The protocol refuses "withdraw_collateral 900 XLM": Withdrawing 900 XLM ($162 USD) is NOT permitted: it would leave the account below the 1.1x health threshold against outstanding debt.' },
    ]);
  });
});
