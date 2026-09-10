/**
 * Borrowing headroom at the user's own stated health floor.
 *
 * Display and sizing are different jobs:
 *
 * 1. **Display** ("your health factor is 3.90") uses the app snapshot —
 *    `computeAccountPosition` / `computeMarginSnapshot` — so the copilot matches
 *    the Margin page.
 *
 * 2. **Sizing** ("you can borrow $X before breaching 1.30") uses the contract
 *    `liquidation_snapshot` (the function that decides liquidation). If that
 *    read cannot be compared to a usable app snapshot within a small tolerance,
 *    this refuses to quote a size rather than silently preferring either source.
 *
 * 3. **The floor must come from the user.** `parseMinHealthFactor` reads it out
 *    of their own words. If they never stated one, this returns null rather than
 *    assuming a default.
 *
 * No model output reaches this file, and it performs no writes.
 */

import { computeMarginSnapshot } from "@/lib/account-snapshot";
import { LIQUIDATION_THRESHOLD } from "@/lib/margin-health";
import { isUsable, unavailable, usable, type ReadResult } from "@/lib/usable-read";
import type { MCPClient } from "../mcp-client";
import { parseMinHealthFactor } from "../router";
import { readLiquidationSnapshot } from "./contract-health";
import { isRecord } from "./decision";
import { formatWad, decimalWad, WAD } from "./fixed";
import { LIQUIDATION_THRESHOLD_WAD, maxBorrowForFloorWad } from "./sizing";
import type { ResearchCapacity } from "./view";

/** Two decimals is the precision the rest of the surface shows USD at. */
function usd(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error("invalid_usd");
  return value.toFixed(2);
}

export type MarginSnapshot = Awaited<ReturnType<typeof computeMarginSnapshot>>;

export type ContractLiquidationBasis = {
  collateralUsd: number;
  debtUsd: number;
  liquidatable: boolean;
};

export type SizingOptions = {
  /** Pre-fetched contract snapshot. `null` means the fetch already failed. */
  contract?: ContractLiquidationBasis | null;
  mcp?: Pick<MCPClient, "call">;
  trader?: string | null;
};

/** Absolute USD band that still counts as WAD / rounding noise. */
export const SIZING_DRIFT_ABS_USD = 0.5;
/** Relative band on the larger of the two sides. */
export const SIZING_DRIFT_REL = 0.005;

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
export function snapshotUsability(snapshot: MarginSnapshot): ReadResult<MarginSnapshot> {
  const debt = snapshot.totalBorrowedValue;
  const gross = snapshot.grossCollateralValue;
  if (!Number.isFinite(debt) || !Number.isFinite(gross) || debt < 0 || gross < 0) {
    return unavailable("position_read_non_finite");
  }
  // No debt: nothing to be inconsistent with.
  if (debt <= 0) return usable(snapshot);
  /**
   * Below the liquidation threshold the account should already be gone, so a live account
   * reporting it is far more likely to be a partial read than a real position. Refusing to
   * compute is the safe direction: the turn says the position could not be read, instead of
   * quoting a health factor of 0.01 or sizing against a collateral figure that is missing
   * most of its legs.
   */
  if (gross / debt > LIQUIDATION_THRESHOLD) return usable(snapshot);
  return unavailable("position_read_inconsistent");
}

function snapshotIsUsable(snapshot: MarginSnapshot): boolean {
  return isUsable(snapshotUsability(snapshot));
}

function withinDrift(app: number, contract: number): boolean {
  const diff = Math.abs(app - contract);
  const scale = Math.max(Math.abs(app), Math.abs(contract), 1);
  return diff <= Math.max(SIZING_DRIFT_ABS_USD, SIZING_DRIFT_REL * scale);
}

/**
 * App snapshot vs contract liquidation_snapshot. Agreement means we may size from
 * the contract numbers. Disagreement is unavailable — never a silent preference.
 */
export function reconcileSizingBasis(
  app: { grossCollateralValue: number; totalBorrowedValue: number },
  contract: ContractLiquidationBasis,
): ReadResult<ContractLiquidationBasis> {
  if (
    !Number.isFinite(contract.collateralUsd) || !Number.isFinite(contract.debtUsd)
    || contract.collateralUsd < 0 || contract.debtUsd < 0
  ) {
    return unavailable("sizing_contract_unavailable");
  }
  if (
    !withinDrift(app.grossCollateralValue, contract.collateralUsd)
    || !withinDrift(app.totalBorrowedValue, contract.debtUsd)
  ) {
    return unavailable("sizing_sources_disagree");
  }
  return usable(contract);
}

export function parseLiquidationSnapshot(data: unknown): ContractLiquidationBasis | null {
  if (!isRecord(data) || data.error) return null;
  const collateral = Number(data.collateral_usd);
  const debt = Number(data.debt_usd);
  if (!Number.isFinite(collateral) || !Number.isFinite(debt) || collateral < 0 || debt < 0) {
    return null;
  }
  return {
    collateralUsd: collateral,
    debtUsd: debt,
    liquidatable: data.liquidatable === true,
  };
}

async function resolveContractBasis(
  smartAccount: string,
  options?: SizingOptions,
  signal?: AbortSignal,
): Promise<ContractLiquidationBasis> {
  if (options && Object.prototype.hasOwnProperty.call(options, "contract")) {
    if (options.contract) return options.contract;
    throw new Error("sizing_contract_unavailable");
  }
  if (options?.mcp) {
    try {
      const data = await options.mcp.call(
        "vanna_get_liquidation_snapshot",
        { smart_account: smartAccount },
        options.trader ?? undefined,
      );
      const parsed = parseLiquidationSnapshot(data);
      if (parsed) return parsed;
    } catch {
      // Live MCP may not have the action yet; fall through to a direct simulate.
    }
  }
  try {
    const snap = await readLiquidationSnapshot(smartAccount, { signal });
    return {
      collateralUsd: snap.collateralUsd,
      debtUsd: snap.debtUsd,
      liquidatable: snap.liquidatable,
    };
  } catch {
    throw new Error("sizing_contract_unavailable");
  }
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
  options?: SizingOptions,
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

  const contract = await resolveContractBasis(smartAccount, options, signal);
  signal?.throwIfAborted();
  const agreed = reconcileSizingBasis(snapshot, contract);
  if (!isUsable(agreed)) throw new Error(agreed.reason);

  const grossWad = decimalWad(usd(agreed.value.collateralUsd));
  const debtWad = decimalWad(usd(agreed.value.debtUsd));
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
