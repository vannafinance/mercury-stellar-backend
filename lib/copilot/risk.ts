/**
 * Deterministic risk gate + before→after health simulation for margin writes.
 * Cannot be bypassed by prompt injection — pure code.
 */

import { copilotConfig } from "./config";
import type { MCPClient } from "./mcp-client";
import type { CopilotAction, RiskResult, Simulation } from "./types";
import {
  healthFactorFromUsd,
  isOnChainLiquidatable,
  LIQUIDATION_THRESHOLD,
} from "@/lib/margin-health";
import { n, parseHealthPayload } from "./protocol-health";

async function fetchPriceUsd(mcp: MCPClient, asset: string): Promise<number> {
  try {
    const r = await mcp.call("vanna_get_price", { symbol: asset });
    return n(r.price_usd) ?? n(r.price) ?? 1;
  } catch {
    return asset.toUpperCase() === "XLM" ? 0.11 : 1;
  }
}

/**
 * The margin page's own read, used whenever the health tool cannot answer.
 *
 * Same source `runRead` falls back to, deliberately: the copilot and the margin page must
 * not disagree about the number that decides liquidation.
 */
async function healthFromSnapshot(
  smartAccount: string,
): Promise<{ hf: number | null; collateral: number; debt: number } | null> {
  try {
    const { computeMarginSnapshot } = await import("@/lib/account-snapshot");
    const snap = await computeMarginSnapshot(smartAccount);
    if (!(snap.grossCollateralValue > 0) && !(snap.totalBorrowedValue > 0)) return null;
    return {
      hf: snap.totalBorrowedValue > 0 ? snap.avgHealthFactor : null,
      // Health factor on Vanna is derived from grossCollateralValue = pure collateral + debt assets held
      collateral:
        snap.grossCollateralValue > 0
          ? snap.grossCollateralValue
          : snap.totalCollateralValue + snap.totalBorrowedValue,
      debt: snap.totalBorrowedValue,
    };
  } catch {
    return null;
  }
}

async function fetchHealth(
  mcp: MCPClient,
  smartAccount: string | null | undefined,
  trader: string | null | undefined,
): Promise<{ hf: number | null; collateral: number; debt: number }> {
  if (smartAccount) {
    const viaSnapshot = await healthFromSnapshot(smartAccount);
    if (viaSnapshot) return viaSnapshot;
  }
  if (!smartAccount && !trader) {
    return { hf: null, collateral: 0, debt: 0 };
  }
  try {
    const args: Record<string, unknown> = {};
    if (smartAccount) args.smart_account = smartAccount;
    if (trader) args.trader = trader;
    // Some MCP builds take only smart_account; others also accept account.
    const r = await mcp.call("vanna_get_account_health", args);
    const { collateral, debt, hf } = parseHealthPayload(r as Record<string, unknown>);

    /**
     * A Soroban budget overrun arrives as a SUCCESSFUL response carrying an error field —
     * it never rejects. `runRead` documents exactly this and re-raises so its fallback can
     * run; here the catch below was simply unreachable, so the payload
     *
     *     { error: "contract_error",
     *       message: "…get_current_total_balance: HostError: Error(Budget, ExceededLimit)" }
     *
     * parsed to collateral 0 / debt 0 / hf null and became a zeroed baseline. The card then
     * said "reading your current position failed" — true, but only because nothing here
     * noticed. It fires on accounts holding several collateral tokens, which is why it
     * looked like intermittent RPC flakiness rather than a shape the code never handled.
     *
     * Falling back on ANY unparseable payload, not just the budget string, so a future
     * error shape cannot reintroduce a silent zero.
     */
    const nothingParsed = collateral === 0 && debt === 0 && hf == null;
    if (nothingParsed && smartAccount) {
      const viaSnapshot = await healthFromSnapshot(smartAccount);
      if (viaSnapshot) return viaSnapshot;
    }
    return { hf, collateral, debt };
  } catch (e) {
    /**
     * `vanna_get_account_health` blows the Soroban CPU budget on accounts holding several
     * collateral tokens — `runRead` documents this and already falls back to
     * `computeMarginSnapshot`, the same read the margin page renders from.
     *
     * This function had no such fallback and swallowed the error SILENTLY, returning a
     * zeroed baseline. Downstream that is indistinguishable from an empty account, so the
     * card reported "reading your current position failed" on a funded, healthy one — and
     * because nothing was logged, it looked like intermittent RPC flakiness for hours.
     * It is neither intermittent nor RPC: it tracks how many collateral tokens the account
     * holds, which is why it appeared only as this test account accumulated them.
     */
    if (smartAccount) {
      const viaSnapshot = await healthFromSnapshot(smartAccount);
      if (viaSnapshot) return viaSnapshot;
    }
    console.warn(
      `[copilot] risk baseline read failed, no snapshot fallback: ${
        e instanceof Error ? e.message.slice(0, 160) : String(e)
      }`,
    );
    return { hf: null, collateral: 0, debt: 0 };
  }
}

function hfFrom(collateral: number, debt: number): number | null {
  return healthFactorFromUsd(collateral, debt);
}

export interface RiskSimInput {
  action: CopilotAction;
  amount: number | null;
  smartAccount?: string | null;
  trader?: string | null;
}

export async function evaluateWriteRisk(
  mcp: MCPClient,
  input: RiskSimInput,
): Promise<{ risk: RiskResult; simulation: Simulation | null }> {
  const { action } = input;
  const amount = input.amount != null && input.amount > 0 ? input.amount : null;
  const asset = (action.asset || "USDC").toUpperCase();
  const reasons: string[] = [];
  let decision: RiskResult["decision"] = "allow";

  // Leverage cap (if present on action via multi-leg leverage strategies)
  const lev = (action as CopilotAction & { leverage?: number }).leverage;
  if (lev != null && lev > copilotConfig.maxLeverage) {
    return {
      risk: {
        decision: "block",
        reasons: [`leverage ${lev} exceeds policy max ${copilotConfig.maxLeverage}`],
        projected_health_factor: null,
      },
      simulation: null,
    };
  }

  if (action.multi_leg) {
    reasons.push(
      "multi-leg strategy: legs are not guaranteed atomic — confirm carefully before signing",
    );
    decision = "needs_confirmation";
  }

  // Non-margin ops: light policy only
  if (!action.requires_account || !amount) {
    if (!reasons.length) reasons.push("within policy limits");
    return {
      risk: { decision, reasons, projected_health_factor: null },
      simulation: amount
        ? {
            hf_before: null,
            hf_after: null,
            collateral_before: 0,
            collateral_after: 0,
            debt_before: 0,
            debt_after: 0,
            ltv_before: 0,
            ltv_after: 0,
            liquidation_threshold: LIQUIDATION_THRESHOLD,
            amount_usd: 0,
            asset,
            // Nothing failed here — this op simply does not move margin collateral or debt.
            margin_applicable: false,
          }
        : null,
    };
  }

  const price = await fetchPriceUsd(mcp, asset);
  const amountUsd = amount * price;
  if (amountUsd > copilotConfig.maxPositionUsd) {
    return {
      risk: {
        decision: "block",
        reasons: [
          `position ~$${amountUsd.toFixed(0)} exceeds max $${copilotConfig.maxPositionUsd}`,
        ],
        projected_health_factor: null,
      },
      simulation: null,
    };
  }

  const before = await fetchHealth(mcp, input.smartAccount, input.trader);
  let colAfter = before.collateral;
  let debtAfter = before.debt;

  const borrowAsset = ((action as any).borrow_asset as string | undefined) || asset;
  const borrowPrice =
    borrowAsset.toUpperCase() === asset.toUpperCase()
      ? price
      : await fetchPriceUsd(mcp, borrowAsset);
  const borrowAmount =
    typeof (action as any).borrow_amount === "number" && (action as any).borrow_amount > 0
      ? ((action as any).borrow_amount as number)
      : amount;
  const borrowAmountUsd = (borrowAmount ?? 0) * borrowPrice;

  const effectiveBorrowUsd = borrowAmountUsd > 0 ? borrowAmountUsd : amountUsd;

  switch (action.op) {
    case "deposit_collateral":
      colAfter = before.collateral + amountUsd;
      break;
    case "withdraw_collateral":
      colAfter = Math.max(0, before.collateral - amountUsd);
      break;
    case "borrow":
      // Borrowed assets held in smart margin account increase gross collateral alongside debt
      colAfter = before.collateral + effectiveBorrowUsd;
      debtAfter = before.debt + effectiveBorrowUsd;
      break;
    case "repay":
      colAfter = Math.max(0, before.collateral - effectiveBorrowUsd);
      debtAfter = Math.max(0, before.debt - effectiveBorrowUsd);
      break;
    case "deposit_and_borrow": {
      const lev = (action as CopilotAction & { leverage?: number }).leverage;
      const borrowUsd =
        borrowAmountUsd > 0
          ? borrowAmountUsd
          : lev != null && lev > 1
            ? amountUsd * (lev - 1)
            : amountUsd * 0.8;
      colAfter = before.collateral + amountUsd + borrowUsd;
      debtAfter = before.debt + borrowUsd;
      break;
    }
    default:
      break;
  }

  const hfBefore = before.hf ?? hfFrom(before.collateral, before.debt);
  const hfAfter = hfFrom(colAfter, debtAfter);
  const ltvBefore = before.collateral > 0 ? before.debt / before.collateral : 0;
  const ltvAfter = colAfter > 0 ? debtAfter / colAfter : 0;

  const simulation: Simulation = {
    hf_before: hfBefore,
    hf_after: hfAfter,
    collateral_before: before.collateral,
    collateral_after: colAfter,
    debt_before: before.debt,
    debt_after: debtAfter,
    ltv_before: ltvBefore,
    ltv_after: ltvAfter,
    liquidation_threshold: LIQUIDATION_THRESHOLD,
    amount_usd: amountUsd,
    asset,
  };

  // User-stated floor (“keep HF above 1.5”) beats default config floor.
  const userFloor =
    action.min_hf != null && Number.isFinite(action.min_hf) && action.min_hf > 0
      ? action.min_hf
      : null;
  const hardFloor = LIQUIDATION_THRESHOLD;

  if (
    isOnChainLiquidatable(hfBefore, before.debt) &&
    (action.op === "borrow" ||
      action.op === "deposit_and_borrow" ||
      action.op === "withdraw_collateral" ||
      action.op === "deploy_to_blend")
  ) {
    decision = "block";
    reasons.unshift(
      `HF ${hfBefore!.toFixed(2)} <= ${hardFloor.toFixed(2)} — liquidatable on-chain now. Repay debt or deposit collateral first.`,
    );
  }

  if (hfAfter != null && hfAfter <= hardFloor) {
    decision = "block";
    reasons.unshift(
      `projected health factor ${hfAfter.toFixed(2)} <= ${hardFloor.toFixed(2)} — would be instantly liquidatable on-chain`,
    );
  } else if (userFloor != null && hfAfter != null && hfAfter < userFloor) {
    decision = "block";
    reasons.unshift(
      `projected HF ${hfAfter.toFixed(2)} would breach your floor of ${userFloor.toFixed(2)} ` +
        `(“keep health factor above ${userFloor}”). Lower size, add collateral, or raise your floor.`,
    );
  }

  if (!reasons.length) reasons.push("within policy limits");

  return {
    risk: {
      decision,
      reasons,
      projected_health_factor: hfAfter,
    },
    simulation,
  };
}
