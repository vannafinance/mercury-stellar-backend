/**
 * Compact investigation evidence sealed into the continuation so propose can
 * compile without a second 30–60s world-read.
 *
 * The browser never sees this payload in the clear. Propose may reuse it only
 * while the bundle itself is still inside the same 60s freshness window the
 * sizer uses for prices. Stale or missing evidence falls back to live reads.
 */

import { isRecord } from "./decision";
import { PRICE_MAX_AGE_MS } from "./candidates";
import type { Observation } from "./types";
import type { ResearchCapacity } from "./view";

const KEEP = new Set(["wallet_balances", "asset_price", "earn_market", "blend_markets"]);
const MAX_OBSERVATIONS = 16;

export interface ResearchEvidence {
  allowedCandidateIds?: string[];
  requestedSteps?: import("../workflow/types").ProposalStep[];
  capturedAt: number;
  observations: Observation[];
  capacity: ResearchCapacity | null;
}

export function compactResearchEvidence(
  observations: readonly Observation[],
  capacity: ResearchCapacity | null,
  capturedAt: number,
): ResearchEvidence {
  const kept: Observation[] = [];
  for (const observation of observations) {
    if (!KEEP.has(observation.capability) || kept.length >= MAX_OBSERVATIONS) continue;
    kept.push(compactObservation(observation));
  }
  return {
    capturedAt,
    observations: kept,
    capacity: capacity ? { ...capacity } : null,
  };
}

/**
 * The bundle is valid for 60s after capture. Compile against `capturedAt` so
 * observations that were fresh at the end of investigation stay fresh even when
 * the investigation itself took most of that minute.
 */
export function researchEvidenceReusable(
  evidence: ResearchEvidence | undefined,
  now: number,
): evidence is ResearchEvidence {
  if (!evidence) return false;
  if (!Number.isFinite(evidence.capturedAt) || evidence.capturedAt > now) return false;
  if (now - evidence.capturedAt > PRICE_MAX_AGE_MS) return false;
  if (evidence.observations.some(o => o.status === "ok" &&
    (!Number.isFinite(o.observedAt) || o.observedAt > now || now - o.observedAt > PRICE_MAX_AGE_MS))) return false;
  return evidence.observations.some((observation) => observation.status === "ok");
}

export function isResearchEvidence(value: unknown): value is ResearchEvidence {
  if (!isRecord(value) || typeof value.capturedAt !== "number" || !Number.isFinite(value.capturedAt)) return false;
  if (!Array.isArray(value.observations) || value.observations.length > MAX_OBSERVATIONS) return false;
  if (!(value.capacity === null || isCapacity(value.capacity))) return false;
  return value.observations.every(isCompactObservation);
}

function isCapacity(value: unknown): value is ResearchCapacity {
  if (!isRecord(value)) return false;
  const health = value.healthFactor;
  return typeof value.floor === "string" && typeof value.grossCollateralUsd === "string"
    && typeof value.debtUsd === "string" && typeof value.maxBorrowUsd === "string"
    && (health === null || typeof health === "string");
}

function isCompactObservation(value: unknown): value is Observation {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.capability !== "string") return false;
  if (!isRecord(value.args) || typeof value.observedAt !== "number" || !Number.isFinite(value.observedAt)) return false;
  if (value.status !== "ok" && value.status !== "error") return false;
  if (value.data !== undefined && !isRecord(value.data)) return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  return true;
}

function compactObservation(observation: Observation): Observation {
  const compacted: Observation = {
    id: observation.id,
    capability: observation.capability,
    args: compactArgs(observation.args),
    observedAt: observation.observedAt,
    status: observation.status,
  };
  if (observation.error) compacted.error = observation.error;
  if (observation.status === "ok" && observation.data) {
    compacted.data = compactData(observation.capability, observation.data);
  }
  return compacted;
}

function compactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return typeof args.asset === "string" ? { asset: args.asset } : {};
}

function compactData(capability: string, data: Record<string, unknown>): Record<string, unknown> {
  if (capability === "asset_price") {
    return { price_usd: data.price_usd };
  }
  if (capability === "earn_market") {
    return {
      supply_apr_pct: data.supply_apr_pct,
      supply_apy_pct: data.supply_apy_pct,
      borrow_apr_pct: data.borrow_apr_pct,
    };
  }
  if (capability === "wallet_balances") {
    const assets = Array.isArray(data.assets) ? data.assets.flatMap((row) => {
      if (!isRecord(row) || typeof row.symbol !== "string") return [];
      return [{
        symbol: row.symbol,
        balance: row.balance,
        ...(row.status !== undefined ? { status: row.status } : {}),
        ...(row.error !== undefined ? { error: row.error } : {}),
      }];
    }) : [];
    return { assets };
  }
  if (capability === "blend_markets") {
    const reserves = Array.isArray(data.reserves) ? data.reserves.flatMap((row) => {
      if (!isRecord(row)) return [];
      return [{
        venue: row.venue,
        symbol: row.symbol,
        supply_apr_pct: row.supply_apr_pct,
        ...(row.error !== undefined ? { error: row.error } : {}),
        ...(row.available !== undefined ? { available: row.available } : {}),
        ...(row.status !== undefined ? { status: row.status } : {}),
      }];
    }) : [];
    return { reserves };
  }
  return {};
}
