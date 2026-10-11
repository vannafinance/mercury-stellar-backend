/** Size delegated wallet allocations around measured fees before user approval. */
import type { MCPClient } from "../mcp-client";
import { OP_FLOW, type ProposalStep } from "../workflow/types";
import { assetForVenueSpelling } from "../registry/assets";
import { decimalWad, formatWad, WAD, ZERO } from "./fixed";
import { isRecord } from "./decision";
import { interruptible } from "./runtime";
import { planCandidateId, resolvePlans, type PlanContext, type ResolvedPlans } from "./plan";
import type { Observation, ProposedPlan } from "./types";
import { ResearchError } from "./scope";
import { holdingsAfterReserves, spendableWalletHoldingsFrom } from "./candidates";

/** Keep the wallet's ongoing fee allowance after the approved plan has paid its fees. */
export function walletFeeReserveFor(reserves: PlanContext["walletReserves"], observations: readonly Observation[]): string | undefined {
  if (!reserves?.some(row => row.asset === "XLM")) return undefined;
  const wallet = [...observations].reverse().find(row => row.capability === "wallet_balances" && row.status === "ok");
  try {
    const amount = decimalWad(String(wallet?.data?.fee_reserve_xlm));
    if (amount < ZERO) throw new Error();
    return formatWad(amount);
  } catch {
    throw new ResearchError("wallet_fee_reserve_unavailable", "The wallet's ongoing fee reserve could not be verified. Refresh the wallet balance before preparing this reserve plan.");
  }
}

function delegated(plan: ProposedPlan): boolean {
  return plan.legs.some(leg => leg.sizing.kind === "all_wallet" ||
    (leg.sizing.kind === "all_position" && OP_FLOW[leg.op].from === "wallet") ||
    (leg.sizing.kind === "fraction" && leg.sizing.of === "wallet" && leg.sizing.allocation));
}

async function quote(steps: readonly ProposalStep[], ctx: PlanContext, mcp: Pick<MCPClient, "call">, signal: AbortSignal): Promise<bigint | null> {
  const measured = await Promise.all(steps.map(async step => {
    const venue = OP_FLOW[step.op].venue;
    if (venue !== "earn" && venue !== "margin" && venue !== "blend") return null;
    const operation = venue === "blend" ? step.op : step.op.split("_")[0];
    const symbol = String(step.args.symbol ?? "");
    const spellingVenue = venue === "earn" ? "earn" : "margin";
    const asset = assetForVenueSpelling(spellingVenue, symbol)?.id;
    const args = { symbol, amount: step.amount, operation, include_fee_quote: true, fee_quote_only: true,
      ...(venue === "earn" ? { holder: ctx.scope.trader } : { smart_account: ctx.scope.smartAccount, trader: ctx.scope.trader }) };
    try {
      const response = await interruptible(() => mcp.call(venue === "earn" ? "vanna_preview_earn" : "vanna_preview_margin", args, ctx.scope.trader ?? undefined), signal);
      const fee = isRecord(response.fee_quote) ? response.fee_quote : null;
      if (!fee || fee.status !== "quoted" || fee.source !== ctx.scope.trader || fee.operation !== operation || fee.amount !== step.amount ||
        (venue !== "earn" && fee.smart_account !== ctx.scope.smartAccount) ||
        typeof fee.contract !== "string" || !fee.contract || typeof fee.symbol !== "string" ||
        !asset || assetForVenueSpelling(spellingVenue, fee.symbol)?.id !== asset ||
        typeof fee.maximum_fee_stroops !== "string" || !/^[1-9]\d*$/.test(fee.maximum_fee_stroops)) return null;
      // Stellar fees use native stroops; the planner uses WAD units.
      return BigInt(fee.maximum_fee_stroops) * (WAD / BigInt(10 ** 7));
    } catch { return null; }
  }));
  return measured.some(fee => fee === null) ? null : measured.reduce<bigint>((sum, fee) => sum + fee!, ZERO);
}

export async function sizePlansWithFees(plans: readonly ProposedPlan[], ctx: PlanContext, mcp: Pick<MCPClient, "call">, signal: AbortSignal): Promise<ResolvedPlans & { walletFeeBudgets: Record<string, string> }> {
  const output: ResolvedPlans & { walletFeeBudgets: Record<string, string> } = { candidates: [], rejected: [], plans: [], walletFeeBudgets: {} };
  for (const plan of plans) {
    const initial = resolvePlans([plan], ctx);
    if (!delegated(plan) || !ctx.walletReserves?.some(row => row.asset === "XLM")) {
      output.candidates.push(...initial.candidates); output.rejected.push(...initial.rejected); output.plans!.push(...(initial.plans ?? [])); continue;
    }
    for (const candidate of initial.candidates) {
      const shape = initial.plans?.find(shape => planCandidateId(shape) === candidate.id);
      const refuse = () => output.rejected.push({ title: candidate.label, leg: null, reason: "The complete plan's transaction fees could not be measured while preserving your wallet reserve. No allocation was prepared." });
      if (!shape || !candidate.steps?.length) { refuse(); continue; }
      const total = await quote(candidate.steps, ctx, mcp, signal);
      if (total === null) { refuse(); continue; }
      const wallet = [...ctx.observations].reverse().find(row => row.capability === "wallet_balances" && row.status === "ok" && ctx.now - row.observedAt <= 60_000);
      try { walletFeeReserveFor(ctx.walletReserves, wallet ? [wallet] : []); } catch { refuse(); continue; }
      // Spendable holdings already exclude the ongoing allowance. Transaction fees
      // must be additional so the same spendable floor survives settlement.
      const extra = total;
      const nativeHoldings = spendableWalletHoldingsFrom(ctx.observations, ctx.now);
      const nativeReserve = ctx.walletReserves!.filter(row => row.asset === "XLM").reduce((sum, row) => sum + decimalWad(row.amount), ZERO);
      if (!nativeHoldings.XLM || decimalWad(nativeHoldings.XLM.tokens) < nativeReserve) { refuse(); continue; }
      const freeNative = holdingsAfterReserves(nativeHoldings, ctx.walletReserves).XLM;
      if (!freeNative || decimalWad(freeNative.tokens) < extra) { refuse(); continue; }
      const budgets = { ...ctx.walletFeeBudgets, [candidate.id]: formatWad(extra) };
      const resized = resolvePlans([shape], { ...ctx, walletFeeBudgets: budgets });
      const next = resized.candidates.find(row => row.id === candidate.id);
      if (!next?.steps?.length) { output.rejected.push(...resized.rejected); continue; }
      // A recompile that left every argument unchanged needs no duplicate measurement.
      const checked = JSON.stringify(next.steps.map(row => [row.op, row.args])) === JSON.stringify(candidate.steps.map(row => [row.op, row.args]))
        ? total : await quote(next.steps, ctx, mcp, signal);
      if (checked === null || checked > extra) { refuse(); continue; }
      output.candidates.push(next); output.plans!.push(shape); output.walletFeeBudgets[candidate.id] = formatWad(extra);
    }
    output.rejected.push(...initial.rejected);
  }
  return output;
}
