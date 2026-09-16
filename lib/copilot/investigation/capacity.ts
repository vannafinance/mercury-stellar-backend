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

import { computeMarginSnapshot, SnapshotTimeoutError } from "@/lib/account-snapshot";
import { statedFloorFrom } from "./floor";
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
  /** The user's floor when the caller already knows it (model-anchored); otherwise parsed from the messages. */
  floor?: string | null;
  /**
   * The app snapshot when the caller already attempted it: a snapshot, or `null` meaning
   * "tried and unavailable — do not read again". Undefined means read it here. Mirrors
   * `contract`. Propose reads it once, bounded; reading it twice unbounded took a
   * propose past the browser's 90s (13 Sep).
   */
  app?: MarginSnapshot | null;
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
export { statedFloorFrom };

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
    if (options.contract) {
      console.info("[copilot] liquidation_snapshot path", { path: "preloaded", smartAccount });
      return options.contract;
    }
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
      if (parsed) {
        console.info("[copilot] liquidation_snapshot path", { path: "mcp", smartAccount });
        return parsed;
      }
    } catch {
      // Live MCP may not have the action yet; fall through to a direct simulate.
    }
  }
  try {
    const snap = await readLiquidationSnapshot(smartAccount, { signal });
    console.info("[copilot] liquidation_snapshot path", { path: "simulate_fallback", smartAccount });
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

  const stated = options?.floor ?? statedFloorFrom(messages);
  if (stated === null) return null;
  const floorWad = decimalWad(stated);
  // A floor at or below the liquidation threshold is not headroom, it is a breach.
  if (floorWad <= LIQUIDATION_THRESHOLD_WAD) return null;

  const basis = await computeSizingBasis(smartAccount, shared ?? null, options, signal);
  if (!basis) throw new Error("position_read_inconsistent");
  if (basis.issue) throw new Error(basis.issue);
  return capacityFromBasis(basis, formatWad(floorWad));
}

/** Headroom at a floor from an agreed basis. Null when the basis is disputed or the floor is not above the line. */
export function capacityFromBasis(basis: SizingBasis, floor: string): ResearchCapacity | null {
  if (basis.issue) return null;
  const floorWad = decimalWad(floor);
  if (floorWad <= LIQUIDATION_THRESHOLD_WAD) return null;
  const grossWad = decimalWad(basis.grossCollateralUsd);
  const debtWad = decimalWad(basis.debtUsd);
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
 * The position a plan may be sized against, independent of any floor.
 *
 * The contract's liquidation snapshot is the number that decides liquidation, so sizing
 * uses it — but only once the app snapshot agrees with it within the drift band. When
 * the two disagree (tokens sitting in the account unposted count for the Margin page and
 * not for the risk engine — see OWNER-collateral-definition.md) the contract figures are
 * still returned, with the disagreement carried as data, so a caller can refuse to size
 * anything that lowers health while still projecting a deposit honestly. Null when the
 * position could not be read at all.
 */
export interface SizingBasis {
  /** The figures to size against: the contract's, or the app's only when no contract read exists. */
  grossCollateralUsd: string;
  debtUsd: string;
  source: "contract" | "app";
  /** Why a borrow must not be sized on this basis; null when the sources agree. */
  issue: "sizing_sources_disagree" | "sizing_contract_unavailable" | "sizing_app_unavailable" | null;
  app: { grossCollateralUsd: string; debtUsd: string };
  contract: { grossCollateralUsd: string; debtUsd: string } | null;
}

export async function computeSizingBasis(
  smartAccount: string,
  shared: MarginSnapshot | null,
  options?: SizingOptions,
  signal?: AbortSignal,
): Promise<SizingBasis | null> {
  let snapshot = shared ?? null;
  if (!snapshot && !(options && Object.prototype.hasOwnProperty.call(options, "app"))) {
    try {
      snapshot = await computeMarginSnapshot(smartAccount);
    } catch (error) {
      console.warn("[copilot] sizing app snapshot failed", {
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      });
    }
  } else if (!snapshot) {
    snapshot = options?.app ?? null;
  }
  signal?.throwIfAborted();
  // A partially-read position produces a confidently wrong figure.
  const appUsable = snapshot !== null && snapshotIsUsable(snapshot);
  const app = snapshot && appUsable ? { grossCollateralUsd: usd(snapshot.grossCollateralValue), debtUsd: usd(snapshot.totalBorrowedValue) } : null;
  let contract: ContractLiquidationBasis;
  try {
    contract = await resolveContractBasis(smartAccount, options, signal);
  } catch {
    if (!app) return null;
    return { ...app, source: "app", issue: "sizing_contract_unavailable", app, contract: null };
  }
  signal?.throwIfAborted();
  const contractFigures = { grossCollateralUsd: usd(contract.collateralUsd), debtUsd: usd(contract.debtUsd) };
  // The engine's figures stand on their own for a deposit; without the app to agree, no borrow.
  if (!app) return { ...contractFigures, source: "contract", issue: "sizing_app_unavailable", app: contractFigures, contract: contractFigures };
  const agreed = reconcileSizingBasis(snapshot!, contract);
  return {
    ...contractFigures,
    source: "contract",
    issue: isUsable(agreed) ? null : agreed.reason === "sizing_sources_disagree" ? "sizing_sources_disagree" : "sizing_contract_unavailable",
    app,
    contract: contractFigures,
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
  let snapshot: MarginSnapshot;
  try {
    snapshot = await computeMarginSnapshot(smartAccount);
  } catch (error) {
    if (error instanceof SnapshotTimeoutError) {
      console.warn("[copilot] account snapshot timed out", { smartAccount, message: error.message });
      return null;
    }
    throw error;
  }
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
