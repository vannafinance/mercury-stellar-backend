/**
 * Compact investigation evidence sealed into the continuation so propose can
 * compile without a second 30–60s world-read.
 *
 * The browser never sees this payload in the clear. Propose may reuse it only
 * while the bundle itself is still inside the same 60s freshness window the
 * sizer uses for prices. Stale or missing evidence falls back to live reads.
 */

import { assetForVenueSpelling } from "../registry/assets";
import { OP_FLOW, WORKFLOW_OPS } from "../workflow/types";
import { isRecord } from "./decision";
import { PRICE_MAX_AGE_MS } from "./candidates";
import type { Observation } from "./types";
import type { ResearchCapacity } from "./view";

/**
 * What the sealed continuation carries forward, so Prepare can re-size the plan the user
 * clicked. The position reads are DERIVED from the op-flow table rather than listed here:
 * a hand-kept list is one a new op falls off silently, and on 14 Sep exactly that happened
 * — `blend_withdraw` sized correctly on the card, the seal dropped `blend_position`, and
 * Prepare answered "no XLM Blend supply was read this investigation".
 */
const KEEP = new Set<string>([
  "wallet_balances", "asset_price", "earn_market", "blend_markets", "aquarius_pool_reserves", "soroswap_pool_reserves",
  "account_position", "account_health",
  ...WORKFLOW_OPS.flatMap((op) => OP_FLOW[op].positionRead ? [OP_FLOW[op].positionRead as string] : []),
]);
const PRIORITY: Record<string, number> = {
  blend_position: 9,
  account_position: 0,
  account_health: 1,
  account_debt: 2,
  account_collateral: 3,
  wallet_balances: 4,
  asset_price: 5,
  earn_market: 6,
  blend_markets: 7,
  earn_position: 8,
};
const MAX_OBSERVATIONS = 16;

export interface ResearchEvidence {
  allowedCandidateIds?: string[];
  requestedSteps?: import("../workflow/types").ProposalStep[];
  /**
   * The model's composed shapes, sealed so propose can re-size the one the user picked
   * from the same evidence without a second model turn — a model turn is not
   * deterministic, and the option the user clicked must be the option that compiles.
   */
  plans?: import("./types").ProposedPlan[];
  /**
   * The user accepted a fill far below fair value, in their own words, verified against
   * their messages when the research was sealed. Carried here so the decision survives to
   * approval: the pool is re-quoted before the write, and a user who accepted the loss
   * gets the trade at the fresh price instead of a refusal they cannot lift.
   */
  slippageAccepted?: boolean;
  /** Amounts the user said to keep in the wallet, anchored when sealed, so a re-propose sizes around them too. */
  walletReserves?: { asset: string; amount: string }[];
  /** The margin position the plans were sized against (contract basis), the sources' disagreement if any, and the user's stated floor (null = none). */
  position?: import("./plan").PlanContext["capacity"];
  floor?: string | null;
  capturedAt: number;
  observations: Observation[];
  capacity: ResearchCapacity | null;
}

/**
 * `required` is what the sealed plans need to be re-sized at propose (strategy-reads
 * `readsForPlans`, derived from the plans' own legs). Those reads are kept first and are
 * never cut by the size cap; the cap only trims the rest. 23 Sep, X12 "earn and farm": the
 * joined plan was sized from the Aquarius LP position, but that read had no priority, fell
 * past the 16-read cap, and propose then refused the plan it had just offered
 * ("no AQUSDC LP position was read"), so the card never appeared.
 */
export function compactResearchEvidence(
  observations: readonly Observation[],
  capacity: ResearchCapacity | null,
  capturedAt: number,
  required: readonly { capability: string; args: Record<string, unknown> }[] = [],
): ResearchEvidence {
  const needed = (o: Observation) => required.some((r) => r.capability === o.capability &&
    (r.args.asset === undefined || r.args.asset === o.args.asset));
  const ranked = observations
    .filter((observation) => KEEP.has(observation.capability))
    .slice()
    .sort((a, b) => Number(needed(b)) - Number(needed(a)) || (PRIORITY[a.capability] ?? 99) - (PRIORITY[b.capability] ?? 99));
  const kept: Observation[] = [];
  for (const observation of ranked) {
    if (kept.length >= MAX_OBSERVATIONS && !needed(observation)) break;
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
export function reusableObservations(
  evidence: ResearchEvidence | undefined,
  now: number,
): Observation[] {
  return researchEvidenceReusable(evidence, now) ? evidence.observations : [];
}

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
  const floorSource = value.floorSource;
  return typeof value.floor === "string" && typeof value.grossCollateralUsd === "string"
    && typeof value.debtUsd === "string" && typeof value.maxBorrowUsd === "string"
    && (health === null || typeof health === "string")
    && (floorSource === undefined || floorSource === "user" || floorSource === "configured_safety_buffer");
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
  /**
   * Rate rows keep the borrow rate and utilization alongside the supply rate: the rate
   * comparison vouches for a supply rate only by checking it against those two, so a
   * bundle without them would make every sealed option "no longer available" on propose.
   */
  if (capability === "earn_market") {
    return {
      supply_apr_pct: data.supply_apr_pct,
      supply_apy_pct: data.supply_apy_pct,
      borrow_apr_pct: data.borrow_apr_pct,
      utilization_pct: data.utilization_pct,
    };
  }
  // The share count is what an LP exit is sized from (plan.ts farmLpPositionOf); without this
  // branch the read was sealed as {} and propose could not re-size the exit.
  if (capability === "farm_lp_position") {
    return {
      ...(data.lp_shares_human !== undefined ? { lp_shares_human: data.lp_shares_human } : {}),
      ...(data.venue !== undefined ? { venue: data.venue } : {}),
      ...(data.token_a !== undefined ? { token_a: data.token_a } : {}),
      ...(data.token_b !== undefined ? { token_b: data.token_b } : {}),
      ...(data.resolved !== undefined ? { resolved: data.resolved } : {}),
    };
  }
  if (capability === "earn_position") {
    return {
      ...(data.symbol !== undefined ? { symbol: data.symbol } : {}),
      ...(data.vtoken_symbol !== undefined ? { vtoken_symbol: data.vtoken_symbol } : {}),
      ...(data.decimals !== undefined ? { decimals: data.decimals } : {}),
      ...(data.human !== undefined ? { human: data.human } : {}),
      ...(data.redeemable_human !== undefined ? { redeemable_human: data.redeemable_human } : {}),
    };
  }
  if (capability === "blend_position") {
    const positions = Array.isArray(data.positions) ? data.positions.flatMap((value) => {
      if (!isRecord(value) || typeof value.symbol !== "string") return [];
      return [{
        symbol: value.symbol,
        ...(value.balance !== undefined ? { balance: value.balance } : {}),
        ...(value.underlying_value !== undefined ? { underlying_value: value.underlying_value } : {}),
        ...(value.amount_human !== undefined ? { amount_human: value.amount_human } : {}),
      }];
    }) : [];
    return { positions };
  }
  if (capability === "wallet_balances") {
    const assets = Array.isArray(data.assets) ? data.assets.flatMap((row) => {
      if (!isRecord(row) || typeof row.symbol !== "string") return [];
      return [{
        symbol: row.symbol,
        balance: row.balance,
        ...(row.decimals !== undefined ? { decimals: row.decimals } : {}),
        ...(row.spendable !== undefined ? { spendable: row.spendable } : {}),
        ...(row.status !== undefined ? { status: row.status } : {}),
        ...(row.error !== undefined ? { error: row.error } : {}),
      }];
    }) : [];
    // The fee reserve travels with the balances: an idle XLM amount sized on propose
    // must equal the one sized on the card, and both leave the reserve in the wallet.
    return { assets, ...(data.fee_reserve_xlm !== undefined ? { fee_reserve_xlm: data.fee_reserve_xlm } : {}) };
  }
  if (capability === "account_position" || capability === "account_health") {
    return {
      ...(data.collateral_usd !== undefined ? { collateral_usd: data.collateral_usd } : {}),
      ...(data.debt_usd !== undefined ? { debt_usd: data.debt_usd } : {}),
      ...(data.health_factor !== undefined ? { health_factor: data.health_factor } : {}),
      ...(data.posted_health_factor !== undefined ? { posted_health_factor: data.posted_health_factor } : {}),
      ...(data.source !== undefined ? { source: data.source } : {}),
    };
  }
  if (capability === "account_debt") {
    // `asset` is the registry id the wire symbol means here (BLUSDC for "USDC"); the model
    // names legs by it, and must never have to guess it from the venue's spelling.
    const debt = Array.isArray(data.debt) ? data.debt.flatMap((row) => {
      if (!isRecord(row) || typeof row.symbol !== "string") return [];
      const asset = assetForVenueSpelling("margin", row.symbol)?.id;
      return [{ symbol: row.symbol, ...(asset ? { asset } : {}), balance: row.balance }];
    }) : undefined;
    return {
      ...(data.total_debt_usd !== undefined ? { total_debt_usd: data.total_debt_usd } : {}),
      ...(data.debt_usd !== undefined ? { debt_usd: data.debt_usd } : {}),
      ...(data.source !== undefined ? { source: data.source } : {}),
      ...(debt ? { debt } : {}),
    };
  }
  if (capability === "account_collateral") {
    // Posted rows travel too: a withdraw sized as `all_position` re-sizes from them on propose.
    const collateral = Array.isArray(data.collateral) ? data.collateral.flatMap((row) => {
      if (!isRecord(row) || typeof row.symbol !== "string") return [];
      const asset = assetForVenueSpelling("margin", row.symbol)?.id;
      return [{ symbol: row.symbol, ...(asset ? { asset } : {}), balance: row.balance, ...(row.balance_untrusted !== undefined ? { balance_untrusted: row.balance_untrusted } : {}) }];
    }) : undefined;
    return {
      ...(data.total_value_usd !== undefined ? { total_value_usd: data.total_value_usd } : {}),
      ...(data.collateral_usd !== undefined ? { collateral_usd: data.collateral_usd } : {}),
      ...(data.source !== undefined ? { source: data.source } : {}),
      ...(collateral ? { collateral } : {}),
    };
  }
  /**
   * A pool read carries the numbers a swap is quoted from, not a display summary.
   *
   * `compactData` is an allowlist whose fallback is `{}`, and neither pool capability had
   * a branch — so a pool read sealed on one turn came back as an empty object on the next,
   * and `poolReservesFrom` saw nothing. Live, 16 Sep: "the soroswap pool's live on-chain
   * reserves were unavailable" on a pair whose reserves had just been read successfully,
   * and the same hole made Aquarius reads warn "no supported display fields were
   * available". Exactly the fields `poolReservesFrom` reads are kept, and no more:
   * reserves and total_share size the quote, fee is required by the constant-product
   * formula, and reserves_source is what proves the numbers came from the ledger rather
   * than an indexer.
   */
  if (capability === "aquarius_pool_reserves" || capability === "soroswap_pool_reserves") {
    const pool = isRecord(data.pool) ? data.pool : null;
    if (!pool) return {};
    return {
      ...(data.found !== undefined ? { found: data.found } : {}),
      pool: {
        ...(pool.pool_address !== undefined ? { pool_address: pool.pool_address } : {}),
        ...(pool.pool_type !== undefined ? { pool_type: pool.pool_type } : {}),
        ...(pool.fee !== undefined ? { fee: pool.fee } : {}),
        ...(pool.reserves !== undefined ? { reserves: pool.reserves } : {}),
        ...(pool.total_share !== undefined ? { total_share: pool.total_share } : {}),
        ...(pool.available !== undefined ? { available: pool.available } : {}),
        ...(pool.reserves_source !== undefined ? { reserves_source: pool.reserves_source } : {}),
        ...(pool.swap_killed !== undefined ? { swap_killed: pool.swap_killed } : {}),
      },
    };
  }
  if (capability === "blend_markets") {
    const reserves = Array.isArray(data.reserves) ? data.reserves.flatMap((row) => {
      if (!isRecord(row)) return [];
      return [{
        venue: row.venue,
        symbol: row.symbol,
        supply_apr_pct: row.supply_apr_pct,
        borrow_apr_pct: row.borrow_apr_pct,
        utilization_pct: row.utilization_pct,
        ...(row.error !== undefined ? { error: row.error } : {}),
        ...(row.available !== undefined ? { available: row.available } : {}),
        ...(row.status !== undefined ? { status: row.status } : {}),
      }];
    }) : [];
    return { reserves };
  }
  return {};
}
