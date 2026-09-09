/**
 * Deterministic strategy sizing. No model input reaches this file.
 *
 * The model may propose a strategy SHAPE (which ops, which assets, in what order); every
 * amount and every projected health factor is computed here, in exact integer WAD
 * arithmetic. That split is the point: a model that cannot choose a number cannot invent
 * one, and a number that came from code can be re-derived from its inputs.
 *
 * Authority (owner decision, 2026-09-08 — see FLASH_AGENT_UPGRADE_PLAN.md):
 *   health factor = grossCollateralUsd / debtUsd
 *   liquidatable  = HF <= 1.1
 * matching `lib/margin-health.ts`, which is byte-identical to `origin/dev`. Independently
 * confirmed against the deployed RiskEngine: `is_account_healthy` returns false at exactly
 * 1.100000 and true at 1.100001, so the threshold really is exclusive.
 *
 * Borrowing raises BOTH sides. The smart account contract credits borrowed proceeds into
 * its own collateral ledger (`record_borrow_and_credit`), so a borrow of x adds x to gross
 * assets and x to debt. Modelling it as debt-only understates the resulting health factor
 * and was the bug behind the dual-borrow HF crater.
 */

import { checked, decimalWad, formatWad, WAD, ZERO } from "./fixed";

/** The contract's own liquidation threshold, 1.1 WAD. Exclusive: HF <= this is unsafe. */
export const LIQUIDATION_THRESHOLD_WAD = BigInt(11) * WAD / BigInt(10);

export type SizedOp = "deposit_collateral" | "borrow" | "repay" | "withdraw_collateral";

export interface SizingBase {
  /** Authoritative gross collateral in USD, as a decimal string. */
  grossCollateralUsd: string;
  debtUsd: string;
}

export interface LegRequest {
  op: SizedOp;
  label: string;
  /** A fixed USD size, or "max" to take the largest amount the floor permits. */
  amountUsd: string | "max";
}

export interface SizedLeg {
  op: SizedOp;
  label: string;
  amountUsd: string;
  grossAfterUsd: string;
  debtAfterUsd: string;
  /** Null when the leg leaves no debt — a health factor without debt is not a number. */
  healthFactorAfter: string | null;
}

export type SizingResult =
  | { ok: true; legs: SizedLeg[]; finalHealthFactor: string | null }
  | { ok: false; reason: string; failingLeg: string | null; legs: SizedLeg[] };

/** Health factor as a WAD ratio, or null when there is no debt to divide by. */
function healthFactorWad(grossWad: bigint, debtWad: bigint): bigint | null {
  return debtWad === ZERO ? null : checked(grossWad * WAD) / debtWad;
}

/**
 * Largest borrow that still leaves `HF >= floor`, given that a borrow adds to both sides.
 *
 *   (G + x) / (D + x) >= F   with F > 1
 *   =>  x <= (G - F*D) / (F - 1)
 *
 * Returns zero when the account is already at or below the floor — never a negative size.
 * Solved in closed form rather than searched, so the answer is exact rather than the last
 * value some loop happened to accept.
 */
export function maxBorrowForFloorWad(grossWad: bigint, debtWad: bigint, floorWad: bigint): bigint {
  if (floorWad <= WAD) throw new Error("floor_must_exceed_one");
  const numerator = checked(grossWad * WAD) - checked(floorWad * debtWad);
  if (numerator <= ZERO) return ZERO;
  return numerator / (floorWad - WAD);
}

/**
 * Apply a sequence of legs to a starting state, sizing any "max" leg against the floor.
 *
 * Every intermediate state is checked, not just the final one: a plan whose last leg is
 * healthy can still pass through a liquidatable state in the middle, and the chain does
 * not wait for the sequence to finish before liquidating.
 */
export function sizeLegs(base: SizingBase, legs: readonly LegRequest[], floor: string): SizingResult {
  const sized: SizedLeg[] = [];
  const fail = (reason: string, failingLeg: string | null = null): SizingResult =>
    ({ ok: false, reason, failingLeg, legs: sized });

  let floorWad: bigint;
  let gross: bigint;
  let debt: bigint;
  try {
    floorWad = decimalWad(floor);
    gross = decimalWad(base.grossCollateralUsd);
    debt = decimalWad(base.debtUsd);
  } catch {
    return fail("invalid_base_or_floor");
  }
  // A floor at or below the liquidation threshold is not a safety margin.
  if (floorWad <= LIQUIDATION_THRESHOLD_WAD) return fail("floor_below_liquidation_threshold");
  if (!legs.length) return fail("no_legs");
  if (legs.length > 8) return fail("too_many_legs");

  for (const leg of legs) {
    let amount: bigint;
    if (leg.amountUsd === "max") {
      if (leg.op !== "borrow") return fail("max_only_supported_for_borrow", leg.label);
      amount = maxBorrowForFloorWad(gross, debt, floorWad);
      if (amount === ZERO) return fail("no_capacity_at_floor", leg.label);
    } else {
      try {
        amount = decimalWad(leg.amountUsd);
      } catch {
        return fail("invalid_leg_amount", leg.label);
      }
      if (amount === ZERO) return fail("zero_leg_amount", leg.label);
    }

    switch (leg.op) {
      case "deposit_collateral":
        gross = checked(gross + amount);
        break;
      case "borrow":
        // Both sides: the contract credits the proceeds as collateral.
        gross = checked(gross + amount);
        debt = checked(debt + amount);
        break;
      case "repay":
        if (amount > debt) return fail("repay_exceeds_debt", leg.label);
        if (amount > gross) return fail("repay_exceeds_collateral", leg.label);
        gross = gross - amount;
        debt = debt - amount;
        break;
      case "withdraw_collateral":
        if (amount > gross) return fail("withdraw_exceeds_collateral", leg.label);
        gross = gross - amount;
        break;
      default:
        return fail("unsupported_op", leg.label);
    }

    const hf = healthFactorWad(gross, debt);
    sized.push({
      op: leg.op, label: leg.label, amountUsd: formatWad(amount),
      grossAfterUsd: formatWad(gross), debtAfterUsd: formatWad(debt),
      healthFactorAfter: hf === null ? null : formatWad(hf),
    });
    // No debt means nothing can liquidate this state, so the floor does not apply.
    if (hf !== null && hf < floorWad) return fail("health_floor_breached", leg.label);
  }

  const finalHf = healthFactorWad(gross, debt);
  return { ok: true, legs: sized, finalHealthFactor: finalHf === null ? null : formatWad(finalHf) };
}
