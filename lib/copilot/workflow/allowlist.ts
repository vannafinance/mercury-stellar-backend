import { resolveAssetDef } from "../registry/assets";
import { decimalWad } from "../investigation/fixed";
import type { InvestigationScope } from "../investigation/types";
import { OP_FLOW, WALLET_OPS, type ProposalStep, type WorkflowOp } from "./types";

/** Op → MCP write tool. The one map; `plan.ts` and `requested-actions.ts` import it rather than repeating it. */
export const TOOLS: Readonly<Record<WorkflowOp, string>> = Object.freeze({
  lend: "vanna_lend", redeem: "vanna_redeem",
  deposit_collateral: "vanna_deposit_collateral", withdraw_collateral: "vanna_withdraw_collateral",
  borrow: "vanna_borrow", repay: "vanna_repay", supply_blend: "vanna_blend_supply",
  blend_withdraw: "vanna_blend_withdraw", swap: "vanna_swap",
});

/**
 * The exact argument set a step must carry for its op — wallet ops name the lender, margin
 * ops the account. The key names are the MCP tool's own: `allowedInvocation` compares them
 * one for one, so a rename here is a refused write rather than a silent mismatch.
 */
export function writeArgsFor(
  op: WorkflowOp,
  symbol: string,
  amount: string,
  scope: Pick<InvestigationScope, "trader" | "smartAccount">,
  extra?: { tokenOut?: string; venue?: string },
): Record<string, unknown> {
  if (op === "swap") {
    // vanna_swap(smart_account, token_in, token_out, amount_in, trader, venue)
    return {
      smart_account: scope.smartAccount, token_in: symbol, token_out: extra?.tokenOut ?? "",
      amount_in: amount, trader: scope.trader, venue: extra?.venue ?? "soroswap",
    };
  }
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
  if (!symbol || (OP_FLOW[step.op].venue === "blend" && !asset.blendReserve)) throw new Error("write_not_allowed");
  // A swap names a second asset; it must be one the registry knows and the account accepts.
  let extra: { tokenOut?: string; venue?: string } | undefined;
  if (step.op === "swap") {
    const out = typeof step.args.token_out === "string" ? resolveAssetDef(step.args.token_out) : null;
    const venue = typeof step.args.venue === "string" ? step.args.venue : "";
    if (!out?.marginSymbol || out.id === asset.id || !["soroswap", "aquarius"].includes(venue)) throw new Error("write_not_allowed");
    extra = { tokenOut: out.marginSymbol, venue };
  }
  const args = writeArgsFor(step.op, symbol, step.amount, scope, extra);
  if (!WALLET_OPS.includes(step.op) && !scope.smartAccount) throw new Error("write_not_allowed");
  if (Object.keys(step.args).length !== Object.keys(args).length || Object.entries(args).some(([key, value]) => step.args[key] !== value))
    throw new Error("proposal_arguments_mismatch");
  return { tool: TOOLS[step.op], args };
}
