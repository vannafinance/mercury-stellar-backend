import { resolveAssetDef } from "../registry/assets";
import { decimalWad } from "../investigation/fixed";
import type { InvestigationScope } from "../investigation/types";
import { WALLET_OPS, type ProposalStep, type WorkflowOp } from "./types";

/** Op → MCP write tool. The one map; `plan.ts` and `requested-actions.ts` import it rather than repeating it. */
export const TOOLS: Readonly<Record<WorkflowOp, string>> = Object.freeze({
  lend: "vanna_lend", redeem: "vanna_redeem",
  deposit_collateral: "vanna_deposit_collateral", withdraw_collateral: "vanna_withdraw_collateral",
  borrow: "vanna_borrow", repay: "vanna_repay", supply_blend: "vanna_blend_supply",
  withdraw_blend: "vanna_blend_withdraw",
});

/** The exact argument set a step must carry for its op — wallet ops name the lender, margin ops the account. */
export function writeArgsFor(op: WorkflowOp, symbol: string, amount: string, scope: Pick<InvestigationScope, "trader" | "smartAccount">): Record<string, unknown> {
  return WALLET_OPS.includes(op)
    ? { symbol, amount, lender: scope.trader }
    : { symbol, amount, trader: scope.trader, smart_account: scope.smartAccount };
}

/** Protocol operations only. Never spread model, browser, or stored arbitrary arguments. */
export function allowedInvocation(step: ProposalStep, scope: Pick<InvestigationScope, "trader" | "smartAccount">) {
  if (!Object.hasOwn(TOOLS, step.op) || TOOLS[step.op] !== step.tool || !scope.trader) throw new Error("write_not_allowed");
  if (decimalWad(step.amount) <= BigInt(0)) throw new Error("invalid_write_amount");
  const asset = resolveAssetDef(step.asset);
  if (!asset || asset.id !== step.asset) throw new Error("invalid_write_asset");
  const symbol = WALLET_OPS.includes(step.op) ? asset.earnSymbol : asset.marginSymbol;
  if (!symbol || ((step.op === "supply_blend" || step.op === "withdraw_blend") && !asset.blendReserve)) throw new Error("write_not_allowed");
  const args = writeArgsFor(step.op, symbol, step.amount, scope);
  if (!WALLET_OPS.includes(step.op) && !scope.smartAccount) throw new Error("write_not_allowed");
  if (Object.keys(step.args).length !== Object.keys(args).length || Object.entries(args).some(([key, value]) => step.args[key] !== value))
    throw new Error("proposal_arguments_mismatch");
  return { tool: TOOLS[step.op], args };
}
