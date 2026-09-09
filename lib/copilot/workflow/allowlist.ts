import { resolveAssetDef } from "../registry/assets";
import { decimalWad } from "../investigation/fixed";
import type { InvestigationScope } from "../investigation/types";
import type { ProposalStep, WorkflowOp } from "./types";

const TOOLS: Record<WorkflowOp, string> = Object.freeze({ lend: "vanna_lend", deposit_collateral: "vanna_deposit_collateral",
  borrow: "vanna_borrow", repay: "vanna_repay", supply_blend: "vanna_blend_supply" });

/** Protocol operations only. Never spread model, browser, or stored arbitrary arguments. */
export function allowedInvocation(step: ProposalStep, scope: Pick<InvestigationScope, "trader" | "smartAccount">) {
  if (!Object.hasOwn(TOOLS, step.op) || TOOLS[step.op] !== step.tool || !scope.trader) throw new Error("write_not_allowed");
  if (decimalWad(step.amount) <= BigInt(0)) throw new Error("invalid_write_amount");
  const asset = resolveAssetDef(step.asset);
  if (!asset || asset.id !== step.asset) throw new Error("invalid_write_asset");
  const symbol = step.op === "lend" ? asset.earnSymbol : asset.marginSymbol;
  if (!symbol || (step.op === "supply_blend" && !asset.blendReserve)) throw new Error("write_not_allowed");
  const args = step.op === "lend" ? { symbol, amount: step.amount, lender: scope.trader }
    : { symbol, amount: step.amount, trader: scope.trader, smart_account: scope.smartAccount };
  if (step.op !== "lend" && !scope.smartAccount) throw new Error("write_not_allowed");
  if (Object.keys(step.args).length !== Object.keys(args).length || Object.entries(args).some(([key, value]) => step.args[key] !== value))
    throw new Error("proposal_arguments_mismatch");
  return { tool: TOOLS[step.op], args };
}
