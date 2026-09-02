/**
 * When a multi-leg run should pause for a Continue / Stop decision.
 *
 * Continue/Stop used to appear between every hop — including swap → LP — because
 * the run card treated "leg 1 settled, not busy" as a user choice. The only case
 * that needs a decision is a stated health-factor floor being breached on a
 * strategy that actually moves margin collateral or debt.
 */

/** Ops that change margin collateral or debt. Farm/swap/LP are not this. */
export const MARGIN_HEALTH_OPS: ReadonlySet<string> = new Set([
  "deposit_collateral",
  "withdraw_collateral",
  "borrow",
  "repay",
  "deposit_and_borrow",
]);

export function isMarginHealthOp(op: string | null | undefined): boolean {
  return MARGIN_HEALTH_OPS.has(String(op || ""));
}

export function shouldPauseForHealthFloor(opts: {
  floor: number | null | undefined;
  hf: number | null | undefined;
  remainingOps: ReadonlyArray<string | null | undefined>;
  /** Already-settled ops — a borrow that dropped HF, with only farm left, still pauses. */
  settledOps?: ReadonlyArray<string | null | undefined>;
}): boolean {
  if (opts.floor == null || opts.hf == null) return false;
  const floor = Number(opts.floor);
  const hf = Number(opts.hf);
  if (!Number.isFinite(floor) || !Number.isFinite(hf) || hf <= 0) return false;
  if (!(hf < floor)) return false;
  if (!opts.remainingOps.length) return false;
  const remainingTouches = opts.remainingOps.some(isMarginHealthOp);
  const settledTouches = (opts.settledOps ?? []).some(isMarginHealthOp);
  return remainingTouches || settledTouches;
}
