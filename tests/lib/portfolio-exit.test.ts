import { describe, expect, it } from "vitest";
import { MAX_WORKFLOW_STEPS, type WorkflowOp } from "@/lib/copilot/workflow/types";
import { decisionFromFunctionCalls } from "@/lib/copilot/investigation/decls";
import { parseDecision } from "@/lib/copilot/investigation/decision";
import { planCandidateId, type ResolvedPlans } from "@/lib/copilot/investigation/plan";
import { missingPositionReads } from "@/lib/copilot/investigation/position-coverage";
import { enforcePortfolioExit, portfolioExitCoverage, portfolioExitProblem, requestsPortfolioExit } from "@/lib/copilot/investigation/portfolio-exit";
import type { Candidate } from "@/lib/copilot/investigation/candidates";
import type { GoalUnderstanding, Observation, ProposedPlan } from "@/lib/copilot/investigation/types";

const now = 1000;
const request = "close out all my positions and withdraw everything";
const goal: GoalUnderstanding = { intent: "strategy", objective: request, constraints: [], borrowing: "forbidden", portfolioExit: { destination: "wallet", sourceQuote: request } };
function inventory(): Observation[] {
  return missingPositionReads([], undefined, [], true).map((read, index) => ({
    ...read, id: String(index), observedAt: now, status: "ok",
    data: read.capability === "earn_position" ? { human: "0", redeemable_human: "0" }
      : read.capability === "farm_lp_position" ? { lp_shares_human: "0" }
        : read.capability === "account_debt" ? { debt: [] }
          : read.capability === "account_collateral" ? { collateral: [] } : { positions: [] },
  }));
}
const leg = (op: WorkflowOp, asset: string) => ({ op, asset, sizing: { kind: "all_position" as const } });
const plan = (legs: ProposedPlan["legs"]): ProposedPlan => ({ title: "Exit", rationale: "Close positions", evidenceIds: [], legs });
const resolved = (plans: ProposedPlan[], finalHealthFactor: string | null = null): ResolvedPlans => ({
  candidates: plans.map(plan => ({ id: planCandidateId(plan), label: plan.title, finalHealthFactor } as Candidate)), rejected: [],
});

describe("terminal portfolio exit scope", () => {
  it("preserves model-declared scope through tool conversion and the strict parser", () => {
    const parsed = parseDecision(decisionFromFunctionCalls([{ name: "research_complete", args: {
      ...goal, findings: [{ summary: "Exit requested", evidenceIds: [] }], openQuestions: [],
    } }]));
    expect(parsed?.kind).toBe("research_complete");
    if (parsed?.kind === "research_complete") expect(parsed.goal.portfolioExit).toEqual(goal.portfolioExit);
  });
  it("requires an anchored terminal request and leaves selected Earn exits outside it", () => {
    expect(requestsPortfolioExit(goal, [request])).toBe(true);
    expect(requestsPortfolioExit(goal, ["redeem everything from Earn"])).toBe(false);
    expect(requestsPortfolioExit({ ...goal, portfolioExit: undefined }, [request])).toBe(false);
    expect(requestsPortfolioExit({ ...goal, intent: "answer" }, [request])).toBe(false);
  });
  it("refuses a malformed terminal scope rather than silently discarding it", () => {
    expect(parseDecision({ kind: "research_complete", goal: { ...goal, portfolioExit: { destination: "wallet" } },
      findings: [{ summary: "Exit requested", evidenceIds: [] }], openQuestions: [] })).toBeNull();
  });
  it("discovers every registered position read even if the model read no positions", () => {
    expect(missingPositionReads([], goal, [request], true).map(read => read.capability)).toContain("account_debt");
    expect(portfolioExitCoverage(inventory(), now)).toEqual({ required: [], unread: [] });
  });
  it("refuses an Earn-only option when Blend and debt remain, including the wallet destination", () => {
    const reads = inventory();
    reads.find(read => read.capability === "earn_position" && read.args.asset === "XLM")!.data = { human: "4", redeemable_human: "5" };
    reads.find(read => read.capability === "blend_position")!.data = { positions: [{ symbol: "XLM", underlying_value: "8" }] };
    reads.find(read => read.capability === "account_debt")!.data = { debt: [{ symbol: "USDC", balance: "3" }] };
    const coverage = portfolioExitCoverage(reads, now);
    expect(coverage.required).toEqual(expect.arrayContaining([leg("redeem", "XLM"), leg("blend_withdraw", "XLM"), leg("repay", "BLUSDC"), leg("withdraw_collateral", "XLM")].map(({ op, asset }) => ({ op, asset }))));
    const partial = plan([leg("redeem", "XLM")]);
    const checked = enforcePortfolioExit(resolved([partial]), [partial], coverage);
    expect(checked.candidates).toEqual([]);
    expect(checked.rejected[0].repairable).toBe(true);
    expect(checked.rejected[0].reason).toContain("BLUSDC");
  });
  it("does not treat separate incomplete alternatives as one complete exit", () => {
    const plans = [plan([leg("redeem", "XLM")]), plan([leg("withdraw_collateral", "XLM")])];
    expect(enforcePortfolioExit(resolved(plans), plans, { required: [{ op: "redeem", asset: "XLM" }, { op: "withdraw_collateral", asset: "XLM" }], unread: [] }).candidates).toEqual([]);
  });
  it("accepts a complete shape but refuses a repayment that was sized down to available funds", () => {
    const complete = plan([leg("repay", "BLUSDC"), leg("withdraw_collateral", "XLM")]);
    const coverage = { required: [{ op: "repay" as const, asset: "BLUSDC" }, { op: "withdraw_collateral" as const, asset: "XLM" }], unread: [] };
    expect(enforcePortfolioExit(resolved([complete]), [complete], coverage).candidates).toHaveLength(1);
    expect(enforcePortfolioExit(resolved([complete], "1.5"), [complete], coverage).candidates).toEqual([]);
  });
  it("never assumes failed, stale, partial or untrusted position reads are empty", () => {
    for (const change of [{ status: "error" }, { observedAt: -100000 }, { data: { errors: ["failed"], debt: [] } }, { data: { debt: [{ symbol: "XLM", balance_untrusted: true }] } }, { data: {} }]) {
      const reads = inventory();
      Object.assign(reads.find(read => read.capability === "account_debt")!, change);
      expect(portfolioExitCoverage(reads, now).unread.length).toBeGreaterThan(0);
    }
  });
  it("refuses a zero-debt inventory that contradicts the contract basis", () => {
    expect(portfolioExitCoverage(inventory(), now, { debtUsd: "10" }).unread).toContain("account_debt:inconsistent_with_contract");
  });
  it("keeps receipt trust warnings separate from canonical token balances", () => {
    const reads = inventory();
    reads.find(read => read.capability === "account_collateral")!.data = { collateral: [
      { symbol: "SS_XLM_SOUSDC", balance: "0", balance_untrusted: true },
      { symbol: "XLM", balance: "100" },
      { symbol: "USDC", balance: "0", balance_untrusted: true },
      { symbol: "AQUSDC", balance: "invalid" },
    ] };
    const coverage = portfolioExitCoverage(reads, now);
    expect(coverage.required).toContainEqual({ op: "withdraw_collateral", asset: "XLM" });
    expect(coverage.unread).toEqual(["account_collateral:BLUSDC", "account_collateral:AQUSDC"]);
  });
  it("requires both LP return tokens to reach the wallet", () => {
    const reads = inventory();
    const lp = reads.find(read => read.capability === "farm_lp_position")!;
    lp.data = { lp_shares_human: "2" };
    const coverage = portfolioExitCoverage(reads, now);
    expect(coverage.required).toEqual(expect.arrayContaining([{ op: "remove_liquidity", asset: lp.args.asset }, { op: "withdraw_collateral", asset: "XLM" }, { op: "withdraw_collateral", asset: lp.args.asset }]));
  });
  it("reports the actual approval bound rather than offering an Earn-only substitute", () => {
    const coverage = { required: Array.from({ length: MAX_WORKFLOW_STEPS + 1 }, () => ({ op: "redeem" as const, asset: "XLM" })), unread: [] };
    expect(portfolioExitProblem(undefined, coverage)).toContain(`at least ${MAX_WORKFLOW_STEPS + 1} steps`);
  });
});
