/**
 * Borrowing headroom at the user's own stated health floor.
 *
 * Two decisions are baked in, both deliberate:
 *
 * 1. **The base is the app's snapshot, not MCP's.** `computeMarginSnapshot` produces the
 *    `grossCollateralValue` that `lib/margin-health.ts` divides by debt — the figure the
 *    owner confirmed as correct and which is byte-identical to `origin/dev`. MCP's
 *    `account_health` reports a materially different collateral number (measured
 *    4,219.36 vs 3,164.34 for the same account at one ledger), so sizing against the MCP
 *    read would quote headroom against a base nothing else in the product agrees with.
 *
 * 2. **The floor must come from the user.** `parseMinHealthFactor` reads it out of their
 *    own words. If they never stated one, this returns null rather than assuming a
 *    default — quoting headroom "at 1.3" to someone who never asked for 1.3 invents the
 *    single most important input of the calculation.
 *
 * No model output reaches this file, and it performs no writes.
 */

import { computeMarginSnapshot } from "@/lib/account-snapshot";
import { LIQUIDATION_THRESHOLD } from "@/lib/margin-health";
import { parseMinHealthFactor } from "../router";
import { formatWad, decimalWad, WAD } from "./fixed";
import { LIQUIDATION_THRESHOLD_WAD, maxBorrowForFloorWad } from "./sizing";
import type { ResearchCapacity } from "./view";

/** Two decimals is the precision the rest of the surface shows USD at. */
function usd(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error("invalid_usd");
  return value.toFixed(2);
}

export type MarginSnapshot = Awaited<ReturnType<typeof computeMarginSnapshot>>;

/**
 * Is this snapshot self-consistent enough to compute against?
 *
 * Observed live within one minute on the same account, while the Soroban RPC was returning
 * repeated `ECONNRESET`: collateral read $4,211.63, then $2,425.78, then **$10.43**, with
 * debt steady at $1,732.61 throughout. The third one rendered as "AT RISK · health factor
 * 0.01". Nothing had executed — `computeMarginSnapshot` runs the borrow and collateral scans
 * as two independent calls (`account-snapshot.ts:164`), and when the collateral side
 * partially fails its total collapses while the debt total survives.
 *
 * The protocol does not let an account sit with debt and no collateral — it would already
 * have been liquidated — so that combination is a failed read, not a position. The copilot
 * must not seed it as evidence or size a plan against it: headroom computed on $10.43 of
 * collateral is not conservative, it is wrong, and "your health factor is 0.01" is a false
 * alarm that would push someone into an unnecessary repay.
 *
 * This guard lives on the copilot side ONLY. The shared snapshot and the account panel are
 * outside this work's scope; the panel showing 0.01 on a partial read is reported separately
 * for the owner of that code.
 */
function snapshotIsUsable(snapshot: MarginSnapshot): boolean {
  const debt = snapshot.totalBorrowedValue;
  const gross = snapshot.grossCollateralValue;
  if (!Number.isFinite(debt) || !Number.isFinite(gross) || debt < 0 || gross < 0) return false;
  // No debt: nothing to be inconsistent with.
  if (debt <= 0) return true;
  /**
   * Below the liquidation threshold the account should already be gone, so a live account
   * reporting it is far more likely to be a partial read than a real position. Refusing to
   * compute is the safe direction: the turn says the position could not be read, instead of
   * quoting a health factor of 0.01 or sizing against a collateral figure that is missing
   * most of its legs.
   */
  return gross / debt > LIQUIDATION_THRESHOLD;
}

export async function computeBorrowCapacity(
  smartAccount: string | null,
  messages: readonly string[],
  signal?: AbortSignal,
  /**
   * A snapshot already read this turn. `computeMarginSnapshot` costs 5-7s against the live
   * RPC (measured), and the position reader and this one both need the same figures — paying
   * for it twice per turn was enough on its own to push the route past its 75s deadline,
   * which the user saw as "the connection closed before the investigation finished".
   */
  shared?: MarginSnapshot | null,
): Promise<ResearchCapacity | null> {
  if (!smartAccount) return null;

  // The latest explicit floor wins, the same precedence the research prompt states for
  // any later user instruction superseding an earlier one.
  let floor: number | null = null;
  for (const message of messages) {
    const parsed = parseMinHealthFactor(message);
    if (parsed !== null) floor = parsed;
  }
  if (floor === null) return null;

  /**
   * Six decimals, NOT eighteen. `parseMinHealthFactor` returns a JS float, and
   * `(1.3).toFixed(18)` is "1.300000000000000044" — binary representation noise. At 18
   * places that noise reaches the WAD value, and a stated floor of exactly 1.1 became
   * 1.100000000000000089, which is GREATER than the liquidation threshold and so slipped
   * past the guard below. Truncating first discards the tail: a health-factor floor is
   * never meaningfully specified beyond six places, and six is comfortably inside float
   * precision for values in this range.
   */
  const floorWad = decimalWad(floor.toFixed(6).replace(/0+$/, "").replace(/\.$/, ""));
  // A floor at or below the liquidation threshold is not headroom, it is a breach.
  if (floorWad <= LIQUIDATION_THRESHOLD_WAD) return null;

  const snapshot = shared ?? await computeMarginSnapshot(smartAccount);
  signal?.throwIfAborted();
  // A partially-read position produces a confidently wrong headroom figure.
  if (!snapshotIsUsable(snapshot)) throw new Error("position_read_inconsistent");

  const grossWad = decimalWad(usd(snapshot.grossCollateralValue));
  const debtWad = decimalWad(usd(snapshot.totalBorrowedValue));
  const maxBorrow = maxBorrowForFloorWad(grossWad, debtWad, floorWad);

  return {
    floor: formatWad(floorWad),
    grossCollateralUsd: formatWad(grossWad),
    debtUsd: formatWad(debtWad),
    // Reported only when there is debt; a ratio with no denominator is not a health factor.
    healthFactor: debtWad === BigInt(0) ? null : formatWad(grossWad * WAD / debtWad),
    maxBorrowUsd: formatWad(maxBorrow),
  };
}

/**
 * The account's authoritative position, independent of any stated floor.
 *
 * Split out because a health question is not a sizing question. `computeBorrowCapacity`
 * returns null without a user-stated floor — correctly, since headroom needs one — but that
 * left "what's my health factor?" dependent on the MCP `account_health` read, and when that
 * read came back without a scalar ratio the copilot reported the value as unavailable while
 * the Margin page rendered 2.43 from this very snapshot. Refusing to invent a number was
 * right; not reaching for the number the product already computes was not.
 *
 * Same source as the Margin page (owner decision: dev is authoritative), so the two cannot
 * disagree. Returns null only when there is genuinely no account to read.
 */
export async function computeAccountPosition(
  smartAccount: string | null,
  signal?: AbortSignal,
): Promise<
  { grossCollateralUsd: string; debtUsd: string; healthFactor: string | null; snapshot: MarginSnapshot } | null
> {
  if (!smartAccount) return null;
  const snapshot = await computeMarginSnapshot(smartAccount);
  signal?.throwIfAborted();
  // Seeding a collapsed collateral read would hand the model a false position as fact.
  if (!snapshotIsUsable(snapshot)) return null;
  const grossWad = decimalWad(usd(snapshot.grossCollateralValue));
  const debtWad = decimalWad(usd(snapshot.totalBorrowedValue));
  return {
    grossCollateralUsd: formatWad(grossWad),
    debtUsd: formatWad(debtWad),
    // No debt means no ratio. A health factor with no denominator is not a number.
    healthFactor: debtWad === BigInt(0) ? null : formatWad(grossWad * WAD / debtWad),
    // Returned so the headroom calculation can reuse it instead of re-reading the chain.
    snapshot,
  };
}
