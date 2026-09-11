/**
 * Candidate strategies, generated and ranked deterministically.
 *
 * The model contributes nothing here. Given the rate comparisons the investigation already
 * gathered and the authoritative position, the feasible shapes are enumerable in code:
 * supply what is already idle, or borrow against headroom and supply that. Every amount
 * comes from `sizing.ts`, so each candidate is re-derivable from its inputs.
 *
 * Two rules the plan calls for explicitly, both enforced here rather than left to prose:
 *
 *  - **A non-borrowing alternative is always offered when one exists.** Permission to
 *    borrow is not an instruction to borrow, so a strategy that leans on new debt must be
 *    presented next to the one that does not.
 *  - **A negative carry is rejected, not ranked.** If the borrow cost meets or exceeds the
 *    supply rate the position loses money by construction, and no health factor makes that
 *    acceptable. It is reported with its reason rather than silently dropped.
 *
 * Supplying is treated as health-factor NEUTRAL. Borrowed proceeds deployed into Blend
 * become a tracking receipt the contract still counts as collateral (measured: recorded
 * BLEND_USDC of 0 alongside a non-zero tracking balance that `get_current_total_balance`
 * includes), so the projection comes from the borrow leg alone. Aquarius LP receipts are
 * NOT counted by the borrow guards, so LP shapes are deliberately absent until that
 * valuation is validated.
 */

import { decimalWad, formatWad, mulDown, WAD, ZERO } from "./fixed";
import { isRecord } from "./decision";
import type { Observation } from "./types";
import { sizeLegs, type SizedLeg } from "./sizing";
import type { RateAsset, RateComparison } from "./rate-comparison";
import { USDC_VARIANTS } from "../registry/assets";
import { findAsset, findBorrowAmount, findBorrowAsset } from "../router";

const IDLE_ASSETS: readonly RateAsset[] = ["XLM", ...USDC_VARIANTS];
const USDC_SET = new Set<string>(USDC_VARIANTS);
/** APR gap (percentage points) below which we will not claim a yield winner. */
const APR_NOISE = decimalWad("0.2");

export interface CandidateInput {
  grossCollateralUsd: string;
  debtUsd: string;
  floor: string;
  /** Idle wallet value the user could commit without borrowing. Null when unknown. */
  idleWalletUsd: string | null;
  /** Per-token funds. A combined USD total cannot fund every token's alternative. */
  idleWalletByAssetUsd?: Partial<Record<RateComparison["asset"], string>>;
  /** Token balances matching `idleWalletByAssetUsd`, for the computed decision copy. */
  idleWalletByAssetTokens?: Partial<Record<RateComparison["asset"], string>>;
  borrowingAllowed?: boolean;
  /**
   * A borrow size the user named outright ("borrow 500 USDC"), in USD. When present it
   * REPLACES sizing to the floor: someone who states an amount has not asked for the
   * largest amount that fits.
   */
  requestedBorrowUsd?: string | null;
  comparisons: readonly RateComparison[];
}

export interface Candidate {
  id: string;
  label: string;
  borrows: boolean;
  asset: RateComparison["asset"];
  venue: "blend" | "earn";
  /** Supply APR minus borrow APR, both simple APR. Null when nothing is borrowed. */
  netAprPct: string | null;
  supplyAprPct: string;
  legs: SizedLeg[];
  finalHealthFactor: string | null;
  amountUsd: string;
  evidenceIds: string[];
  /**
   * How `amountUsd` was chosen. `claimNext` may re-derive a floor-derived amount within
   * a bound; a stated amount is the instruction and must not be quietly shrunk.
   */
  amountBasis: "stated" | "derived_max_at_floor";
  /** Token amount already held, when this candidate spends idle wallet funds. */
  heldAmount?: string | null;
  /**
   * Why this candidate ranked first. Computed from the runner-up comparison, never
   * composed by the model. Present only on the winner.
   */
  decision?: CandidateDecision;
}

export type DecisionFactor = "already_held" | "net_return" | "thin_margin" | "consolidation";

export interface CandidateDecision {
  factor: DecisionFactor;
  reason: string;
  runnerUpId: string | null;
}

export interface CandidateSet {
  feasible: Candidate[];
  rejected: Array<{ label: string; reason: string; asset: RateComparison["asset"] }>;
}

function aprOf(candidate: Candidate): bigint {
  return decimalWad(candidate.netAprPct ?? candidate.supplyAprPct);
}

/** Expected USD return at this size: amount × APR. Ranking uses this, not APR alone. */
function expectedReturn(candidate: Candidate): bigint {
  try {
    return mulDown(decimalWad(candidate.amountUsd), aprOf(candidate), WAD);
  } catch {
    return ZERO;
  }
}

function byExpectedReturn(a: Candidate, b: Candidate): number {
  const retA = expectedReturn(a);
  const retB = expectedReturn(b);
  if (retA !== retB) return retA > retB ? -1 : 1;
  const heldA = decimalWad(a.heldAmount ?? a.amountUsd);
  const heldB = decimalWad(b.heldAmount ?? b.amountUsd);
  if (heldA !== heldB) return heldA > heldB ? -1 : 1;
  return a.id.localeCompare(b.id);
}

/** Rank borrow shapes by net carry, then by the larger position when carries tie. */
function byNetThenSize(a: Candidate, b: Candidate): number {
  const netA = aprOf(a);
  const netB = aprOf(b);
  if (netA !== netB) return netA > netB ? -1 : 1;
  const sizeA = decimalWad(a.amountUsd);
  const sizeB = decimalWad(b.amountUsd);
  if (sizeA !== sizeB) return sizeA > sizeB ? -1 : 1;
  return a.id.localeCompare(b.id);
}

function formatHeld(value: string): string {
  const n = Number(value);
  return Number.isFinite(n)
    ? n.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : value;
}

function formatApr(value: bigint): string {
  return `${Number(formatWad(value)).toFixed(1)}%`;
}

function variantDecision(winner: Candidate, runnerUp: Candidate | undefined): CandidateDecision {
  if (!runnerUp) {
    const held = winner.heldAmount ?? winner.amountUsd;
    return {
      factor: "already_held",
      runnerUpId: null,
      reason: `Using ${winner.asset} — you hold ${formatHeld(held)} of it, so no swap is needed.`,
    };
  }
  let aprDelta = aprOf(runnerUp) - aprOf(winner);
  if (aprDelta < ZERO) aprDelta = -aprDelta;
  const winnerHeld = decimalWad(winner.heldAmount ?? winner.amountUsd);
  const runnerHeld = decimalWad(runnerUp.heldAmount ?? runnerUp.amountUsd);
  if (aprDelta <= APR_NOISE && winnerHeld >= runnerHeld) {
    return {
      factor: "thin_margin",
      runnerUpId: runnerUp.id,
      reason: `within 0.2%; picked ${winner.asset} because you already hold it`,
    };
  }
  const runnerApr = aprOf(runnerUp);
  const winnerApr = aprOf(winner);
  if (runnerApr > winnerApr && winnerHeld > runnerHeld) {
    const extra = runnerApr - winnerApr;
    const net = winner.borrows
      ? `Net ${formatApr(winnerApr)} after borrow cost.`
      : `Net ${formatApr(winnerApr)}.`;
    return {
      factor: "already_held",
      runnerUpId: runnerUp.id,
      reason: `Using ${winner.asset} — you hold ${formatHeld(winner.heldAmount ?? winner.amountUsd)} of it, so no swap is needed. ${net} ${runnerUp.asset} pays ${formatApr(extra)} more but you'd swap ${formatHeld(runnerUp.heldAmount ?? runnerUp.amountUsd)} first, which costs more than it gains.`,
    };
  }
  return {
    factor: "net_return",
    runnerUpId: runnerUp.id,
    reason: `Using ${winner.asset} — net return at your size is higher than ${runnerUp.asset}.`,
  };
}

function rankFeasible(feasible: Candidate[]): Candidate[] {
  const idle = feasible.filter((candidate) => !candidate.borrows).sort(byExpectedReturn);
  const borrow = feasible.filter((candidate) => candidate.borrows).sort(byNetThenSize);
  const ranked = [...idle, ...borrow];
  const usdcIdle = idle.filter((candidate) => USDC_SET.has(candidate.asset));
  const winner = usdcIdle[0];
  if (!winner) return ranked;
  const runnerUp = usdcIdle.find((candidate) => candidate.asset !== winner.asset);
  const decision = variantDecision(winner, runnerUp);
  return ranked.map((candidate) => candidate.id === winner.id ? { ...candidate, decision } : candidate);
}

/** Headroom at the floor, for telling the user what WOULD fit. Never used to re-size. */
function safeMaxBorrow(input: CandidateInput): string | null {
  const sized = sizeLegs(
    { grossCollateralUsd: input.grossCollateralUsd, debtUsd: input.debtUsd },
    [{ op: "borrow", amountUsd: "max", label: "headroom" }],
    input.floor,
  );
  return sized.ok ? sized.legs[0]?.amountUsd ?? null : null;
}

export function generateCandidates(input: CandidateInput): CandidateSet {
  const feasible: Candidate[] = [];
  const rejected: CandidateSet["rejected"] = [];

  for (const comparison of input.comparisons) {
    let supply: bigint | null = null;
    try {
      if (comparison.blendSupplyApr) supply = decimalWad(comparison.blendSupplyApr);
    } catch { supply = null; }
    let borrow: bigint | null = null;
    try {
      if (comparison.marginBorrowApr) borrow = decimalWad(comparison.marginBorrowApr);
    } catch { borrow = null; }

    // 1. No new debt: commit what is already idle. Offered whenever anything is idle.
    const assetIdle = input.idleWalletByAssetUsd?.[comparison.asset];
    const heldAmount = input.idleWalletByAssetTokens?.[comparison.asset] ?? null;
    if (assetIdle !== undefined) {
      let idle = ZERO;
      try {
        idle = decimalWad(assetIdle);
      } catch {
        idle = ZERO;
      }
      if (idle > ZERO) {
        if (supply !== null) {
          feasible.push({
            id: `supply_idle_${comparison.asset}`,
            label: `Supply idle ${comparison.asset} to Blend — no new borrowing`,
            borrows: false,
            asset: comparison.asset,
            venue: "blend",
            netAprPct: null,
            supplyAprPct: formatWad(supply),
            // Supplying idle wallet value does not touch margin collateral or debt.
            legs: [],
            finalHealthFactor: null,
            amountUsd: formatWad(idle),
            evidenceIds: [...comparison.evidenceIds],
            amountBasis: "stated",
            heldAmount,
          });
        }
        /**
         * Earn is a real idle venue when its supply APR beats Blend, or when there is
         * no Blend reserve at all (AQUSDC / SOUSDC). Borrowed proceeds live in the
         * C-address while vanna_lend spends the G-wallet, so there is no borrow-to-Earn
         * shape — that would need a withdraw we have not audited.
         */
        if (comparison.earnSupplyApr) {
          try {
            const earn = decimalWad(comparison.earnSupplyApr);
            if (supply === null || earn > supply) {
              feasible.push({
                id: `lend_idle_${comparison.asset}`,
                label: `Lend idle ${comparison.asset} to Earn — no new borrowing`,
                borrows: false,
                asset: comparison.asset,
                venue: "earn",
                netAprPct: null,
                supplyAprPct: formatWad(earn),
                legs: [],
                finalHealthFactor: null,
                amountUsd: formatWad(idle),
                evidenceIds: [...comparison.evidenceIds],
                amountBasis: "stated",
                heldAmount,
              });
            }
          } catch { /* an unparseable Earn rate is not a candidate */ }
        }
      }
    }

    if (input.borrowingAllowed === false) continue;
    if (supply === null || borrow === null) continue;
    // 2. Borrow against headroom and supply the proceeds. Only worth doing on a real
    //    positive carry; the comparison already computed that verdict from the same rates.
    if (comparison.verdict !== "positive_before_costs" || supply <= borrow) {
      rejected.push({
        label: `Borrow ${comparison.asset} to supply to Blend`,
        asset: comparison.asset,
        reason: supply <= borrow
          ? `Borrowing costs ${formatWad(borrow)}% against a ${formatWad(supply)}% supply rate, so the position loses money before any fees.`
          : `Rate evidence for ${comparison.asset} did not support a positive carry.`,
      });
      continue;
    }

    /**
     * An amount the user named is used as given. Sizing it to the floor instead would
     * answer a different question — and if it does not fit, the honest reply is that it
     * does not fit, with the figure that does. Quietly shrinking a stated amount to make
     * the transaction go through is the specific behaviour the plan forbids.
     */
    const requested = input.requestedBorrowUsd ?? null;
    const sized = sizeLegs(
      { grossCollateralUsd: input.grossCollateralUsd, debtUsd: input.debtUsd },
      [{
        op: "borrow",
        amountUsd: requested ?? "max",
        label: requested
          ? `Borrow ${requested} USD of ${comparison.asset}`
          : `Borrow ${comparison.asset} to the ${input.floor} floor`,
      }],
      input.floor,
    );
    if (!sized.ok) {
      const headroom = requested ? safeMaxBorrow(input) : null;
      rejected.push({
        label: `Borrow ${comparison.asset} to supply to Blend`,
        asset: comparison.asset,
        reason: requested && sized.reason === "health_floor_breached"
          ? headroom && headroom !== "0"
            ? `Borrowing ${requested} USD would take the health factor below your ${input.floor} floor. At most ${headroom} USD fits.`
            : `Borrowing ${requested} USD would take the health factor below your ${input.floor} floor, and there is no headroom at that floor.`
          : sized.reason === "no_capacity_at_floor"
            ? `No borrowing headroom left at a ${input.floor} health-factor floor.`
            : `Could not size a borrow at a ${input.floor} floor (${sized.reason.replaceAll("_", " ")}).`,
      });
      continue;
    }

    feasible.push({
      id: `borrow_supply_${comparison.asset}`,
      label: requested
        ? `Borrow ${requested} USD of ${comparison.asset} and supply it to Blend`
        : `Borrow ${comparison.asset} to the ${input.floor} floor and supply it to Blend`,
      borrows: true,
      asset: comparison.asset,
      venue: "blend",
      netAprPct: formatWad(supply - borrow),
      supplyAprPct: formatWad(supply),
      legs: sized.legs,
      finalHealthFactor: sized.finalHealthFactor,
      amountUsd: sized.legs[0]?.amountUsd ?? "0",
      evidenceIds: [...comparison.evidenceIds],
      amountBasis: requested ? "stated" : "derived_max_at_floor",
    });
  }

  return { feasible: rankFeasible(feasible), rejected };
}

/**
 * A borrow size the user named outright, valued in USD.
 *
 * Sizing to the floor when someone asked for a specific amount answers a different
 * question, so the amount has to survive the trip into USD. It is valued ONLY from an
 * oracle price read during this same investigation — the same rule as `idleWalletUsdFrom`,
 * and for the same reason: treating a stable's ticker as exactly $1 is an assumption, and
 * here it would flow straight into a health-factor check the user is relying on.
 *
 * `usd: null` means "they named an amount and it could not be valued". That is NOT the
 * same as no amount being named, and the caller must not fall back to sizing to the floor
 * on the strength of it.
 */
export function requestedBorrowFrom(
  messages: readonly string[],
  observations: readonly Observation[],
  now: number,
): { asset: string; tokens: number; usd: string | null } | null {
  // The latest explicit request wins, matching how the floor is resolved.
  let found: { asset: string; tokens: number } | null = null;
  for (const message of messages) {
    const tokens = findBorrowAmount(message);
    const asset = tokens === null ? null : findBorrowAsset(message) ?? findAsset(message);
    if (tokens !== null && asset) found = { asset, tokens };
  }
  if (!found) return null;

  const price = freshPrices(observations, now).get(found.asset);
  if (!price) return { ...found, usd: null };
  try {
    return { ...found, usd: formatWad(mulDown(decimalWad(String(found.tokens)), price, WAD)) };
  } catch {
    return { ...found, usd: null };
  }
}

/**
 * Idle wallet value in USD, or null when it cannot be known honestly.
 *
 * The wallet read returns `symbol` and `balance` and NO usd figure, so a dollar value only
 * exists for a symbol whose oracle price was also read during this same investigation.
 * Anything unpriced is left out rather than valued at a guess — a plausible-looking total
 * built on an assumed $1 peg is exactly the kind of number that makes a strategy look
 * fundable when it is not. Returns null when nothing could be priced at all, which the
 * caller renders as "no non-borrowing option shown" rather than "you have nothing idle".
 */
export function idleWalletByAssetUsdFrom(observations: readonly Observation[], now: number): Partial<Record<RateComparison["asset"], string>> {
  const holdings = idleWalletHoldingsFrom(observations, now);
  const result: Partial<Record<RateComparison["asset"], string>> = {};
  for (const [asset, holding] of Object.entries(holdings) as Array<[RateAsset, { usd: string; tokens: string }]>) {
    result[asset] = holding.usd;
  }
  return result;
}

export function idleWalletByAssetTokensFrom(observations: readonly Observation[], now: number): Partial<Record<RateComparison["asset"], string>> {
  const holdings = idleWalletHoldingsFrom(observations, now);
  const result: Partial<Record<RateComparison["asset"], string>> = {};
  for (const [asset, holding] of Object.entries(holdings) as Array<[RateAsset, { usd: string; tokens: string }]>) {
    result[asset] = holding.tokens;
  }
  return result;
}

export function idleWalletHoldingsFrom(
  observations: readonly Observation[],
  now: number,
): Partial<Record<RateAsset, { usd: string; tokens: string }>> {
  const result: Partial<Record<RateAsset, { usd: string; tokens: string }>> = {};
  for (const asset of IDLE_ASSETS) {
    const scoped = observations.map(observation => observation.capability !== "wallet_balances" ? observation : {
      ...observation, data: { ...observation.data, assets: Array.isArray(observation.data?.assets)
        ? observation.data.assets.filter(row => isRecord(row) && row.symbol === asset) : undefined },
    }).filter(observation => observation.capability !== "asset_price" || observation.args.asset === asset
      || (USDC_SET.has(asset) && USDC_SET.has(String(observation.args.asset ?? ""))));
    const value = idleWalletUsdFrom(scoped, now);
    const tokens = idleTokensFrom(scoped, now, asset);
    if (value !== null && tokens !== null) result[asset] = { usd: value, tokens };
  }
  return result;
}

/** Reads no older than a minute. A price outside that window prices nothing. */
export const PRICE_MAX_AGE_MS = 60_000;

function freshObservations(observations: readonly Observation[], now: number): Observation[] {
  return observations.filter((observation) =>
    observation.status === "ok" && observation.data &&
    Number.isFinite(observation.observedAt) && observation.observedAt <= now &&
    now - observation.observedAt <= PRICE_MAX_AGE_MS);
}

/** Oracle prices actually read this investigation, keyed by the symbol they were read for. */
export function freshPrices(observations: readonly Observation[], now: number): Map<string, bigint> {
  const prices = new Map<string, bigint>();
  for (const observation of freshObservations(observations, now)) {
    if (observation.capability !== "asset_price") continue;
    const asset = String(observation.args.asset ?? "");
    const raw = observation.data?.price_usd;
    if (!asset) continue;
    try {
      const price = decimalWad(typeof raw === "number" ? String(raw) : String(raw ?? ""));
      if (price > ZERO) prices.set(asset, price);
    } catch { /* an unparseable price is no price */ }
  }
  // Three USDC variants share one oracle feed. A price read for any of them prices the rest.
  const stable = prices.get("BLUSDC") ?? prices.get("AQUSDC") ?? prices.get("SOUSDC") ?? prices.get("USDC");
  if (stable) {
    for (const variant of USDC_VARIANTS) {
      if (!prices.has(variant)) prices.set(variant, stable);
    }
  }
  return prices;
}

function idleTokensFrom(observations: readonly Observation[], now: number, asset: string): string | null {
  const fresh = freshObservations(observations, now);
  const wallet = fresh.find((observation) => observation.capability === "wallet_balances");
  const assets = wallet?.data?.assets;
  if (!Array.isArray(assets)) return null;
  for (const row of assets) {
    if (!isRecord(row)) continue;
    if (row.symbol !== asset || row.error || (row.status !== undefined && row.status !== "ok")) continue;
    const balance = String(row.balance ?? "");
    try {
      if (decimalWad(balance) > ZERO) return balance;
    } catch { return null; }
  }
  return null;
}

export function idleWalletUsdFrom(observations: readonly Observation[], now: number): string | null {
  const fresh = freshObservations(observations, now);
  const prices = freshPrices(observations, now);
  if (prices.size === 0) return null;

  const wallet = fresh.find((observation) => observation.capability === "wallet_balances");
  const assets = wallet?.data?.assets;
  if (!Array.isArray(assets)) return null;

  let total = ZERO;
  let priced = 0;
  const seen = new Set<string>();
  for (const row of assets) {
    if (!isRecord(row)) continue;
    const symbol = typeof row.symbol === "string" ? row.symbol : "";
    const price = prices.get(symbol);
    // `<SYMBOL>_SAC` is the same holding reported twice; counting both doubles the capital.
    if (!price || !symbol || symbol.endsWith("_SAC")) continue;
    if (seen.has(symbol) || row.error || (row.status !== undefined && row.status !== "ok")) return null;
    seen.add(symbol);
    try {
      total = total + mulDown(decimalWad(String(row.balance ?? "")), price, WAD);
      priced += 1;
    } catch { /* an unparseable balance contributes nothing */ }
  }
  return priced > 0 ? formatWad(total) : null;
}
