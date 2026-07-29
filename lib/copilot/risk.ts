/**
 * Deterministic risk gate + before→after health simulation for margin writes.
 * Cannot be bypassed by prompt injection — pure code.
 */

import { copilotConfig } from "./config";
import type { MCPClient } from "./mcp-client";
import type { CopilotAction, RiskResult, Simulation } from "./types";

const LIQ_THRESHOLD = 1.0; // HF < 1.0 = liquidatable
const DEFAULT_LT = 0.9; // collateral factor used when projecting (conservative)

function n(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const x = Number(v);
    if (Number.isFinite(x)) return x;
  }
  return null;
}

async function fetchPriceUsd(mcp: MCPClient, asset: string): Promise<number> {
  try {
    const r = await mcp.call("vanna_get_price", { symbol: asset });
    return n(r.price_usd) ?? n(r.price) ?? 1;
  } catch {
    return asset.toUpperCase() === "XLM" ? 0.11 : 1;
  }
}

async function fetchHealth(
  mcp: MCPClient,
  smartAccount: string | null | undefined,
  trader: string | null | undefined,
): Promise<{ hf: number | null; collateral: number; debt: number }> {
  if (!smartAccount && !trader) {
    return { hf: null, collateral: 0, debt: 0 };
  }
  try {
    const args: Record<string, unknown> = {};
    if (smartAccount) args.smart_account = smartAccount;
    if (trader) args.trader = trader;
    // Some MCP builds take only smart_account; others also accept account.
    const r = await mcp.call("vanna_get_account_health", args);
    const collateral =
      n(r.collateral_usd) ??
      n(r.total_collateral_usd) ??
      n(r.gross_collateral_usd) ??
      n(r.collateral) ??
      0;
    const debt = n(r.debt_usd) ?? n(r.total_debt_usd) ?? n(r.debt) ?? 0;
    const lt = n(r.liquidation_threshold) ?? DEFAULT_LT;
    let hf = n(r.health_factor) ?? n(r.hf) ?? n(r.avg_health_factor);
    // Live MCP often omits health_factor and only returns collateral/debt/ltv.
    if (hf == null && debt > 0 && collateral > 0) hf = (collateral * lt) / debt;
    return { hf, collateral, debt };
  } catch {
    return { hf: null, collateral: 0, debt: 0 };
  }
}

function hfFrom(collateral: number, debt: number, lt = DEFAULT_LT): number | null {
  if (debt <= 0) return null; // ∞
  return (collateral * lt) / debt;
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
            liquidation_threshold: LIQ_THRESHOLD,
            amount_usd: 0,
            asset,
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

  switch (action.op) {
    case "deposit_collateral":
      colAfter = before.collateral + amountUsd;
      break;
    case "withdraw_collateral":
      colAfter = Math.max(0, before.collateral - amountUsd);
      break;
    case "borrow":
      debtAfter = before.debt + amountUsd;
      break;
    case "repay":
      debtAfter = Math.max(0, before.debt - amountUsd);
      break;
    case "deposit_and_borrow": {
      // Deposit full amount; borrow min(D*(L-1), 0.8*D) so projected LTV stays sane.
      const lev = (action as CopilotAction & { leverage?: number }).leverage;
      const safeBorrowUsd =
        lev != null && lev > 1 ? Math.min(amountUsd * (lev - 1), amountUsd * 0.8) : amountUsd * 0.8;
      colAfter = before.collateral + amountUsd;
      debtAfter = before.debt + safeBorrowUsd;
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
    liquidation_threshold: LIQ_THRESHOLD,
    amount_usd: amountUsd,
    asset,
  };

  if (hfAfter != null && hfAfter < 1.0) {
    decision = "block";
    reasons.unshift(
      `projected health factor ${hfAfter.toFixed(2)} < 1.00 — would be instantly liquidatable`,
    );
  } else if (hfAfter != null && hfAfter < copilotConfig.minHealthFactor) {
    if (decision !== "block") decision = "needs_confirmation";
    reasons.unshift(
      `projected health factor ${hfAfter.toFixed(2)} below safety floor ${copilotConfig.minHealthFactor}`,
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
