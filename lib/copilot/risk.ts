/**
 * Deterministic risk gate + before→after health simulation for margin writes.
 * Cannot be bypassed by prompt injection — pure code.
 */

import { copilotConfig } from "./config";
import type { MCPClient } from "./mcp-client";
import type { CopilotAction, RiskResult, Simulation } from "./types";

const LIQ_THRESHOLD = 1.0; // HF < 1.0 = liquidatable
/**
 * The product's own health factor is a plain ratio — `avgHealthFactor =
 * grossCollateralValue / effectiveDebtValue` in lib/margin-health.ts, confirmed by the
 * Margin page's own displayed number ("Collateral / Debt", no discount). This constant
 * used to be 0.9, silently multiplying collateral by 90% in every before→after
 * projection — since `hf_before` almost always comes straight from a real MCP/snapshot
 * read (bypassing this), only `hf_after` ever hit the discount, so EVERY write's
 * projected health factor after a deposit/withdraw/borrow/repay was ~10% off from what
 * the exact same formula would show once the write actually landed — e.g. a deposit
 * projected to WORSEN health factor (1.50 → 1.35) when adding collateral can only ever
 * help or leave it unchanged. No test caught it because this module had zero coverage.
 */
const DEFAULT_LT = 1.0;

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
      // Margin page "Margin Collateral" is totalCollateralValue, not gross.
      collateral:
        snap.totalCollateralValue > 0 ? snap.totalCollateralValue : snap.grossCollateralValue,
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

  // User-stated floor (“keep HF above 1.5”) beats default config floor.
  const userFloor =
    action.min_hf != null && Number.isFinite(action.min_hf) && action.min_hf > 0
      ? action.min_hf
      : null;
  const policyFloor = copilotConfig.minHealthFactor;
  const hardFloor = 1.0;

  // Already close to liquidation — warn before any debt-increasing write.
  if (
    hfBefore != null &&
    hfBefore < 1.2 &&
    (action.op === "borrow" ||
      action.op === "deposit_and_borrow" ||
      action.op === "withdraw_collateral" ||
      action.op === "deploy_to_blend")
  ) {
    reasons.unshift(
      `Account HF is already ${hfBefore.toFixed(2)} (near liquidation). Prefer repay or add collateral before increasing risk.`,
    );
    if (hfBefore < hardFloor) {
      decision = "block";
      reasons.unshift(`HF ${hfBefore.toFixed(2)} < 1.00 — liquidatable now. Repay debt or deposit collateral first.`);
    } else {
      // No `decision !== "block"` guard: nothing above this point can have set "block",
      // so TS narrows it away and the comparison fails `next build`. The escalation is
      // one-directional anyway — a later block below still wins.
      decision = "needs_confirmation";
    }
  }

  if (hfAfter != null && hfAfter < hardFloor) {
    decision = "block";
    reasons.unshift(
      `projected health factor ${hfAfter.toFixed(2)} < 1.00 — would be instantly liquidatable`,
    );
  } else if (userFloor != null && hfAfter != null && hfAfter < userFloor) {
    decision = "block";
    reasons.unshift(
      `projected HF ${hfAfter.toFixed(2)} would breach your floor of ${userFloor.toFixed(2)} ` +
        `(“keep health factor above ${userFloor}”). Lower size, add collateral, or raise your floor.`,
    );
  } else if (hfAfter != null && hfAfter < policyFloor) {
    if (decision !== "block") decision = "needs_confirmation";
    reasons.unshift(
      `projected health factor ${hfAfter.toFixed(2)} below safety floor ${policyFloor}`,
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
