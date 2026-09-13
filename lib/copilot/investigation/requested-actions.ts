import { resolveAssetDef } from "../registry/assets";
import { allowedInvocation, TOOLS } from "../workflow/allowlist";
import type { ProposalStep } from "../workflow/types";
import { isTokenAmountIn } from "./quantities";
import type { GoalUnderstanding, InvestigationScope } from "./types";

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
      /**
       * The quote must be the user's own text AND the number must be a token quantity
       * in it — not the coefficient of `Nx` or `N%`. Digit membership alone is not
       * enough: "borrow 2x aqusdc" contains "2", so a model that read the leverage
       * multiple as an amount compiled a borrow of 2 AQUSDC against a 2x request.
       * `isTokenAmountIn` rejects a number whose span sits inside a leverage or
       * percent span, so a coefficient can never become a quantity.
       */
      if (!messages.some((message) => message.includes(action.sourceQuote)) ||
        !isTokenAmountIn(action.sourceQuote, action.amount)) {
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
