import { resolveAssetDef } from "../registry/assets";
import { allowedInvocation } from "../workflow/allowlist";
import type { ProposalStep, WorkflowOp } from "../workflow/types";
import type { GoalUnderstanding, InvestigationScope } from "./types";

/** Model selects protocol operations; literal amounts must be anchored to user text. */
export function compileRequestedActions(goal: GoalUnderstanding, messages: readonly string[], scope: InvestigationScope): ProposalStep[] {
  if (goal.intent !== "strategy" || !goal.actions?.length) return [];
  const tools: Record<WorkflowOp, string> = { lend: "vanna_lend", deposit_collateral: "vanna_deposit_collateral", borrow: "vanna_borrow", repay: "vanna_repay", supply_blend: "vanna_blend_supply" };
  try {
    return goal.actions.map((action, index) => {
      if (!messages.some(message => message.includes(action.sourceQuote)) ||
        !action.sourceQuote.match(/\d+(?:\.\d+)?/g)?.includes(action.amount)) throw new Error("unanchored_amount");
      if (action.op === "borrow" && !["allowed", "required"].includes(goal.borrowing)) throw new Error("borrowing_not_requested");
      const asset = resolveAssetDef(action.asset);
      const symbol = action.op === "lend" ? asset?.earnSymbol : asset?.marginSymbol;
      const step: ProposalStep = { id: `requested-${index}`, op: action.op, asset: action.asset, amount: action.amount,
        label: `${action.op.replaceAll("_", " ")} ${action.amount} ${action.asset}`, tool: tools[action.op], sizing: { basis: "stated" },
        args: action.op === "lend" ? { symbol, amount: action.amount, lender: scope.trader }
          : { symbol, amount: action.amount, trader: scope.trader, smart_account: scope.smartAccount } };
      allowedInvocation(step, scope);
      return step;
    });
  } catch { return []; }
}
