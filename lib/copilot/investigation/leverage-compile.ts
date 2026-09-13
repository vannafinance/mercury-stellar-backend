/**
 * Size deposit + Nx + borrow-asset(s) the way the Margin page does.
 *
 * Dual Borrow (components/margin/dual-borrow.tsx):
 *   maxUsd = depositUsd × (leverage − 1)
 *   one borrow asset  → that asset gets all of maxUsd
 *   N borrow assets   → maxUsd split evenly (same as 1 + (L−1)/N per asset)
 *
 * Arithmetic lives in planLeverage / sizeLegs. This file only assembles slots
 * from planner-nominated ops + unit-classified leverage, never from a verb list.
 */

import { planLeverage, fetchLeveragePrices, leveragePriceSymbols } from "../leverage-plan";
import { allAssets, resolveAssetDef } from "../registry/assets";
import { allowedInvocation } from "../workflow/allowlist";
import type { ProposalStep } from "../workflow/types";
import { sizeLegs } from "./sizing";
import { leverageFrom, isTokenAmountIn } from "./quantities";
import type { GoalUnderstanding, InvestigationScope } from "./types";
import type { MCPClient } from "../mcp-client";

const TOOLS = {
  deposit_collateral: "vanna_deposit_collateral",
  borrow: "vanna_borrow",
} as const;

export type LeverageCompileResult = {
  steps: ProposalStep[];
  healthFactorBefore: string | null;
  healthFactorAfter: string | null;
  leverage: number;
};

function step(
  index: number,
  op: "deposit_collateral" | "borrow",
  assetId: string,
  amount: string,
  scope: InvestigationScope,
  basis: ProposalStep["sizing"],
): ProposalStep {
  const asset = resolveAssetDef(assetId);
  if (!asset?.marginSymbol) throw new Error("unsupported_asset");
  const out: ProposalStep = {
    id: `requested-${index}`,
    op,
    asset: asset.id,
    amount,
    label: `${op.replaceAll("_", " ")} ${amount} ${asset.id}`,
    tool: TOOLS[op],
    sizing: basis,
    args: { symbol: asset.marginSymbol, amount, trader: scope.trader, smart_account: scope.smartAccount },
  };
  allowedInvocation(out, scope);
  return out;
}

function namedBorrowAssets(text: string, depositId: string): string[] {
  const upper = text.toUpperCase();
  const found: string[] = [];
  for (const def of allAssets()) {
    if (def.id === depositId || !def.marginSymbol) continue;
    const names = [def.id, ...def.aliases].map((name) => name.toUpperCase());
    if (names.some((name) => name.length >= 3 && upper.includes(name))) found.push(def.id);
  }
  return found.length ? found : [depositId];
}

export async function compileLeverageWrites(input: {
  goal: GoalUnderstanding;
  messages: readonly string[];
  scope: InvestigationScope;
  mcp: Pick<MCPClient, "call">;
  grossCollateralUsd?: string;
  debtUsd?: string;
  prices?: Record<string, number>;
}): Promise<LeverageCompileResult | null> {
  const text = input.messages.join("\n");
  const leverage = leverageFrom(text);
  if (leverage == null || !input.goal.actions?.length) return null;
  const deposits = input.goal.actions.filter((action) => action.op === "deposit_collateral");
  const nominated = input.goal.actions.filter((action) => action.op === "borrow").map((action) => action.asset);
  if (deposits.length !== 1) return null;
  const deposit = deposits[0];
  if (!isTokenAmountIn(deposit.sourceQuote, deposit.amount) && !isTokenAmountIn(text, deposit.amount)) {
    return null;
  }
  const depositAmount = Number(deposit.amount);
  if (!(depositAmount > 0)) return null;

  const borrowAssets = nominated.length ? nominated : namedBorrowAssets(text, deposit.asset);
  const n = borrowAssets.length;
  const perAssetLeverage = n > 1 ? 1 + (leverage - 1) / n : leverage;
  const slots = borrowAssets.map((asset) => ({
    collateralAsset: deposit.asset,
    collateralAmount: depositAmount,
    leverage: perAssetLeverage,
    borrowAsset: asset,
  }));
  const needed = [...new Set(slots.flatMap((slot) => leveragePriceSymbols(slot)))];
  const prices = input.prices ?? (needed.length
    ? await fetchLeveragePrices(input.mcp, needed, input.scope.trader ?? undefined)
    : {});
  const plans = slots.map((slot) => planLeverage(slot, prices));
  if (plans.some((entry) => "gap" in entry)) return null;
  if (!input.scope.trader || !input.scope.smartAccount) return null;

  let steps: ProposalStep[];
  try {
    steps = [
      step(0, "deposit_collateral", deposit.asset, deposit.amount, input.scope, { basis: "stated" }),
      ...plans.map((entry, index) => {
        if ("gap" in entry) throw new Error("sized_gap");
        return step(
          index + 1,
          "borrow",
          entry.plan.borrowAsset,
          String(entry.plan.borrowAmount),
          input.scope,
          { basis: "stated" },
        );
      }),
    ];
  } catch {
    return null;
  }

  let healthFactorBefore: string | null = null;
  let healthFactorAfter: string | null = null;
  if (input.grossCollateralUsd != null && input.debtUsd != null) {
    const depositUsd = plans[0] && !("gap" in plans[0]) ? plans[0].plan.collateralUsd : null;
    const borrowUsd = plans.reduce((sum, entry) => sum + ("gap" in entry ? 0 : (entry.plan.borrowUsd ?? 0)), 0);
    if (depositUsd != null) {
      healthFactorBefore = input.debtUsd === "0" ? null : (
        Number(input.grossCollateralUsd) / Number(input.debtUsd)
      ).toFixed(2);
      const sized = sizeLegs(
        { grossCollateralUsd: input.grossCollateralUsd, debtUsd: input.debtUsd },
        [
          { op: "deposit_collateral", label: "deposit", amountUsd: String(depositUsd) },
          ...plans.map((entry, index) => ({
            op: "borrow" as const,
            label: `borrow-${index}`,
            amountUsd: "gap" in entry ? "0" : String(entry.plan.borrowUsd ?? 0),
          })),
        ],
        "1.1",
      );
      if (sized.ok) healthFactorAfter = sized.finalHealthFactor;
    }
  }

  return { steps, healthFactorBefore, healthFactorAfter, leverage };
}
