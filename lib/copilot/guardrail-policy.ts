/**
 * Graded guardrail policy in one module.
 *
 * Reads are open. Manual writes need a wallet, not a Sign Service binding.
 * Auto-sign needs a binding and live caps. Irreversible ops (close, settle,
 * liquidate) are human-signed only — they have no priced amount.
 *
 * New action types pick a grade here instead of re-arguing the gate.
 */

export type GuardrailGrade = "read" | "manual_write" | "auto_sign" | "irreversible";

export type GuardrailControl = "none" | "wallet" | "binding_and_caps" | "human_signature";

const WRITE_GRADES: Record<string, GuardrailGrade> = {
  lend: "manual_write",
  redeem: "manual_write",
  deposit_collateral: "manual_write",
  withdraw_collateral: "manual_write",
  borrow: "manual_write",
  repay: "manual_write",
  supply_blend: "manual_write",
  add_liquidity: "manual_write",
  remove_liquidity: "manual_write",
  swap: "manual_write",
  open_account: "manual_write",
  close_account: "irreversible",
  settle: "irreversible",
  liquidate: "irreversible",
};

export function gradeForOp(op: string): GuardrailGrade {
  return WRITE_GRADES[op] ?? "manual_write";
}

export function controlFor(grade: GuardrailGrade, autoSign: boolean): GuardrailControl {
  if (grade === "read") return "none";
  if (grade === "irreversible") return "human_signature";
  if (autoSign) return "binding_and_caps";
  return "wallet";
}

/** Whether this op may be session-signed. Irreversible ops never are. */
export function autoSignAllowed(op: string): boolean {
  return gradeForOp(op) !== "irreversible";
}
