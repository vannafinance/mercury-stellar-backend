import { describe, expect, it, vi } from "vitest";
import { sizePlansWithFees } from "@/lib/copilot/investigation/fee-sizing";
import { planCandidateId, resolvePlans, type PlanContext } from "@/lib/copilot/investigation/plan";
import { compareObservedRates } from "@/lib/copilot/investigation/rate-comparison";
import type { Observation, ProposedPlan } from "@/lib/copilot/investigation/types";

const now = 1700000000000;
const scope = { subject: "user", network: "testnet", trader: "GBH5G2WPAAFZ5MS76GDJ4HKHYXSRGF2MBLYDIRQOHGVS4HPU6NNOFIHA", smartAccount: "CCKITLMKA2VKSWGOTFABSUFA3RMOZHRP5YNP6HLG73JSWMMUUNCTHDMC" };
const observation = (capability: string, data: Record<string, unknown>, args = {}): Observation => ({ id: capability, capability, args, data, observedAt: now, status: "ok" });
const observations = [
  observation("wallet_balances", { assets: [{ symbol: "XLM", balance: "1000", min_balance: "3", decimals: 7, status: "ok" }], fee_reserve_xlm: "0.5" }),
  observation("asset_price", { price_usd: "0.18" }, { asset: "XLM" }),
  observation("earn_market", { supply_apr_pct: "5", borrow_apr_pct: "8" }, { asset: "XLM" }),
  observation("blend_markets", { reserves: [{ venue: "blend", symbol: "XLM", supply_apr_pct: "12", borrow_apr_pct: "15" }] }),
];
const ctx: PlanContext = { scope, now, observations, messages: ["optimize yield and keep 100 XLM liquid"], walletReserves: [{ asset: "XLM", amount: "100" }], capacity: { grossCollateralUsd: "10000", debtUsd: "0", floor: "1.2" }, borrowing: "forbidden", comparisons: compareObservedRates(observations, now), strategyGoal: true };
const earn: ProposedPlan = { title: "Earn", rationale: "Yield", evidenceIds: ["wallet_balances", "earn_market"], legs: [{ op: "lend", asset: "XLM", sizing: { kind: "all_wallet" } }] };
function client(fee = "15000000", alter: Record<string, unknown> = {}) {
  return { call: vi.fn(async (_tool: string, args: Record<string, unknown>) => ({ fee_quote: { status: "quoted", maximum_fee_stroops: fee, source: scope.trader, smart_account: scope.smartAccount, operation: args.operation, amount: args.amount, symbol: args.symbol, contract: "registered-contract", ...alter } })) };
}
describe("measured whole-plan fee sizing", () => {
  it("reduces a delegated native allocation and preserves the same size when rebuilt from sealed budget", async () => {
    const mcp = client();
    const result = await sizePlansWithFees([earn], ctx, mcp, new AbortController().signal);
    expect(result.rejected).toEqual([]);
    expect(result.candidates[0].steps![0].amount).toBe("895.5");
    expect(result.walletFeeBudgets[planCandidateId(earn)]).toBe("1");
    const rebuilt = resolvePlans(result.plans!, { ...ctx, walletFeeBudgets: result.walletFeeBudgets });
    expect(rebuilt.candidates[0].steps).toEqual(result.candidates[0].steps);
    expect(mcp.call).toHaveBeenCalledTimes(2);
    expect(mcp.call.mock.calls.map(row => row[1].amount)).toEqual(["896.5", "895.5"]);
  });
  it("reserves fees for later account operations as well as the native wallet deposit", async () => {
    const plan: ProposedPlan = { ...earn, legs: [{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_wallet" } }, { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" } }] };
    const result = await sizePlansWithFees([plan], ctx, client(), new AbortController().signal);
    expect(result.rejected).toEqual([]);
    expect(result.candidates[0].steps!.map(row => row.amount)).toEqual(["894", "894"]);
    expect(result.walletFeeBudgets[planCandidateId(plan)]).toBe("2.5");
  });
  it.each([{ status: "unavailable" }, { maximum_fee_stroops: "0" }, { source: "different-wallet" }, { amount: "99" }, { symbol: "SOUSDC" }])("does not allocate from an unbound or absent fee quote %j", async alter => {
    const result = await sizePlansWithFees([earn], ctx, client("15000000", alter), new AbortController().signal);
    expect(result.candidates).toEqual([]);
    expect(result.rejected[0].reason).toContain("transaction fees could not be measured");
  });
  it("does not resize a literal amount or make extra calls for it", async () => {
    const plan: ProposedPlan = { ...earn, legs: [{ op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "5", sourceQuote: "lend 5 XLM" } }] };
    const mcp = client();
    const result = await sizePlansWithFees([plan], { ...ctx, messages: ["lend 5 XLM but keep 100 XLM liquid"] }, mcp, new AbortController().signal);
    expect(result.candidates[0].steps![0].amount).toBe("5");
    expect(mcp.call).not.toHaveBeenCalled();
  });
  it("keeps the existing wallet hint when it already covers the measured whole fee", async () => {
    const mcp = client("2000000");
    const result = await sizePlansWithFees([earn], ctx, mcp, new AbortController().signal);
    expect(result.candidates[0].steps![0].amount).toBe("896.5");
    expect(result.walletFeeBudgets[planCandidateId(earn)]).toBe("0");
    expect(mcp.call).toHaveBeenCalledTimes(1);
    expect(mcp.call.mock.calls[0][1].fee_quote_only).toBe(true);
  });
  it("withholds a plan when the final sized transaction requires a higher fee", async () => {
    const mcp = client();
    mcp.call.mockImplementationOnce(async (_tool, args) => ({ fee_quote: { status: "quoted", maximum_fee_stroops: "10000000", source: scope.trader, smart_account: scope.smartAccount, operation: args.operation, amount: args.amount, symbol: args.symbol, contract: "registered-contract" } }));
    const result = await sizePlansWithFees([earn], ctx, mcp, new AbortController().signal);
    expect(result.candidates).toEqual([]);
  });
});
