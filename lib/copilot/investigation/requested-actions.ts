import { resolveAssetDef } from "../registry/assets";
import { allowedInvocation } from "../workflow/allowlist";
import type { ProposalStep, WorkflowOp } from "../workflow/types";
import type { GoalUnderstanding, InvestigationScope } from "./types";

const TOOLS: Record<WorkflowOp, string> = {
  lend: "vanna_lend",
  deposit_collateral: "vanna_deposit_collateral",
  borrow: "vanna_borrow",
  repay: "vanna_repay",
  supply_blend: "vanna_blend_supply",
};

/**
 * Compile planner-nominated writes whose amounts already appear in the user text.
 * Not a planner: `goal.actions` comes from the investigation loop. Unanchored or
 * unsupported rows fall through as an empty list so the loop can keep researching.
 */
export function compileRequestedActions(
  goal: GoalUnderstanding,
  messages: readonly string[],
  scope: InvestigationScope,
): ProposalStep[] {
  if (goal.intent !== "strategy" || !goal.actions?.length) return [];
  try {
    return goal.actions.map((action, index) => {
      if (!messages.some((message) => message.includes(action.sourceQuote)) ||
        !action.sourceQuote.match(/\d+(?:\.\d+)?/g)?.includes(action.amount)) {
        throw new Error("unanchored_amount");
      }
      if (action.op === "borrow" && !["allowed", "required"].includes(goal.borrowing)) {
        throw new Error("borrowing_not_requested");
      }
      const asset = resolveAssetDef(action.asset);
      if (!asset) throw new Error("unknown_asset");
      const symbol = action.op === "lend" ? asset.earnSymbol : asset.marginSymbol;
      if (!symbol) throw new Error("unsupported_asset");
      const step: ProposalStep = {
        id: `requested-${index}`,
        op: action.op,
        asset: asset.id,
        amount: action.amount,
        label: `${action.op.replaceAll("_", " ")} ${action.amount} ${asset.id}`,
        tool: TOOLS[action.op],
        sizing: { basis: "stated" },
        args: action.op === "lend"
          ? { symbol, amount: action.amount, lender: scope.trader }
          : { symbol, amount: action.amount, trader: scope.trader, smart_account: scope.smartAccount },
      };
      allowedInvocation(step, scope);
      return step;
    });
  } catch {
    return [];
  }
}
