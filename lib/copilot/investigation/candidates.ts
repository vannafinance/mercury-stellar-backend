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
import { candidateId, candidateKindTraits, type CandidateKind } from "./candidate-id";
import type { ProposalStep } from "../workflow/types";
import { resolveAssetDef, USDC_VARIANTS } from "../registry/assets";
import { findAsset, findBorrowAmount, findBorrowAsset } from "../router";

const USDC_SET = new Set<string>(USDC_VARIANTS);
/** APR gap (percentage points) below which we will not claim a yield winner. */
const APR_NOISE = decimalWad("0.2");

export interface CandidateInput {
  grossCollateralUsd: string;
  debtUsd: string;
  /** The user's stated floor. Null when none was stated: idle shapes need none, borrow shapes are then not offered. */
  floor: string | null;
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
  /** Minted by `candidate-id.ts` from `kind` and `asset`. Opaque everywhere else. */
  id: string;
  /** The strategy family. Consumers branch on this, never on the id string. */
  kind: CandidateKind;
  label: string;
  borrows: boolean;
  /** The asset the shape is about — the first leg's, for a composed plan. */
  asset: string;
  venue: "blend" | "earn" | "margin";
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
  /**
   * Present on a composed plan: the steps `plan.ts` already sized and allowlisted, in
   * order. The compiler passes them through; the fixed shapes derive theirs from `legs`.
   */
  steps?: ProposalStep[];
  /** The model's reasoning for a composed plan. Copy only — every number beside it is code's. */
  rationale?: string;
}

export type DecisionFactor = "already_held" | "net_return" | "thin_margin" | "consolidation";

export interface CandidateDecision {
  factor: DecisionFactor;
  reason: string;
  runnerUpId: string | null;
}

export interface CandidateSet {
  feasible: Candidate[];
  rejected: Array<{ label: string; reason: string; asset: string }>;
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

export function rankFeasible(feasible: Candidate[]): Candidate[] {
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

/** Id, kind and the kind's fixed traits for one strategy on one asset. */
function shape(kind: CandidateKind, asset: RateComparison["asset"]): Pick<Candidate, "id" | "kind" | "asset" | "borrows" | "venue"> {
  const traits = candidateKindTraits(kind);
  return { id: candidateId(kind, asset), kind, asset, borrows: traits.borrows, venue: traits.venue };
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
            ...shape("supply_idle", comparison.asset),
            label: `Supply idle ${comparison.asset} to Blend — no new borrowing`,
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
                ...shape("lend_idle", comparison.asset),
                label: `Lend idle ${comparison.asset} to Earn — no new borrowing`,
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

    // A borrow needs the user's own floor; none was stated, so no borrow shape is offered.
    if (input.borrowingAllowed === false || input.floor === null) continue;
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
      ...shape("borrow_supply", comparison.asset),
      label: requested
        ? `Borrow ${requested} USD of ${comparison.asset} and supply it to Blend`
        : `Borrow ${comparison.asset} to the ${input.floor} floor and supply it to Blend`,
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
 * Merge the fixed shapes with model-composed plans into one ranked set. The same steps
 * reached two ways are one option: the composed copy wins because it carries the
 * rationale the card shows. Rejections from both sides are listed with their reasons.
 */
export function mergeCandidateSets(
  fixed: CandidateSet | null,
  composed: { candidates: Candidate[]; rejected: Array<{ title: string; leg: string | null; reason: string }> },
): CandidateSet {
  // The op sequence a fixed shape compiles to, so it can be matched against a composed plan's steps.
  const FIXED_OPS: Record<Exclude<CandidateKind, "composed">, (asset: string) => string[]> = {
    supply_idle: (asset) => [`deposit_collateral:${asset}`, `supply_blend:${asset}`],
    lend_idle: (asset) => [`lend:${asset}`],
    borrow_supply: (asset) => [`borrow:${asset}`, `supply_blend:${asset}`],
  };
  const signature = (candidate: Candidate) => (candidate.steps
    ? candidate.steps.map((s) => `${s.op}:${s.asset}`)
    : candidate.kind === "composed" ? [] : FIXED_OPS[candidate.kind](candidate.asset)).join("|");
  const taken = new Set(composed.candidates.map(signature));
  const feasible = [
    ...composed.candidates,
    ...(fixed?.feasible ?? []).filter((candidate) => !taken.has(signature(candidate))),
  ];
  return {
    feasible: rankFeasible(feasible.map((candidate) => ({ ...candidate, decision: undefined }))),
    rejected: [
      ...(fixed?.rejected ?? []),
      ...composed.rejected.map((entry) => ({ label: entry.title, reason: entry.leg ? `${entry.leg}: ${entry.reason}.` : `${entry.reason}.`, asset: entry.leg?.split(" ").pop() ?? "" })),
    ],
  };
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
  return walletHoldingsFrom(observations, now).idle;
}

/**
 * Wallet lines worth less than one transaction: held, but not worth moving. 13 Sep, live:
 * "lend 0.0003729 AQUSDC to Earn — about 20.18 % APR on $0.00" was offered, approved and
 * paid 0.096 XLM in fees to deposit $0.00007. A plan leg names these with the reason
 * instead of sizing them.
 */
export function dustWalletHoldingsFrom(
  observations: readonly Observation[],
  now: number,
): Partial<Record<RateAsset, { usd: string; tokens: string }>> {
  return walletHoldingsFrom(observations, now).dust;
}

/**
 * What one transaction needs, in USD: the wallet read's own fee reserve (`fee_reserve_xlm`)
 * at the XLM price read this investigation. Null when either was not read — then nothing
 * is called dust, because the floor would be a guess.
 */
export function transactionFloorUsdWad(observations: readonly Observation[], now: number): bigint | null {
  const wallet = freshObservations(observations, now).find((observation) => observation.capability === "wallet_balances");
  const price = freshPrices(observations, now).get("XLM");
  if (!wallet || !price) return null;
  try {
    const reserve = decimalWad(String(wallet.data?.fee_reserve_xlm ?? ""));
    return reserve > ZERO ? mulDown(reserve, price, WAD) : null;
  } catch {
    return null;
  }
}

function walletHoldingsFrom(
  observations: readonly Observation[],
  now: number,
): { idle: Partial<Record<RateAsset, { usd: string; tokens: string }>>; dust: Partial<Record<RateAsset, { usd: string; tokens: string }>> } {
  const result: Partial<Record<RateAsset, { usd: string; tokens: string }>> = {};
  const dust: Partial<Record<RateAsset, { usd: string; tokens: string }>> = {};
  const floor = transactionFloorUsdWad(observations, now);
  // The wallet read names what is held; the registry says which of those the protocol knows.
  const held = new Set<RateAsset>();
  for (const observation of observations) {
    if (observation.capability !== "wallet_balances" || !Array.isArray(observation.data?.assets)) continue;
    for (const row of observation.data.assets) {
      if (!isRecord(row) || typeof row.symbol !== "string" || row.symbol.endsWith("_SAC")) continue;
      const def = resolveAssetDef(row.symbol);
      if (def && def.id === row.symbol) held.add(def.id);
    }
  }
  for (const asset of held) {
    const scoped = observations.map(observation => observation.capability !== "wallet_balances" ? observation : {
      ...observation, data: { ...observation.data, assets: Array.isArray(observation.data?.assets)
        ? observation.data.assets.filter(row => isRecord(row) && row.symbol === asset) : undefined },
    }).filter(observation => observation.capability !== "asset_price" || observation.args.asset === asset
      || (USDC_SET.has(asset) && USDC_SET.has(String(observation.args.asset ?? ""))));
    const value = idleWalletUsdFrom(scoped, now);
    const tokens = idleTokensFrom(scoped, now, asset);
    if (value === null || tokens === null) continue;
    if (floor !== null && decimalWad(value) < floor) dust[asset] = { usd: value, tokens };
    else result[asset] = { usd: value, tokens };
  }
  return { idle: result, dust };
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

/**
 * What a wallet line can actually spend. The wallet read names the XLM it wants kept
 * back for transaction fees (`fee_reserve_xlm`); an "idle" amount that includes it would
 * leave the wallet unable to pay for the very deposit that moves it. The reserve is the
 * read's own number, applied to the native line only.
 */
function spendableWad(row: Record<string, unknown>, wallet: Record<string, unknown> | undefined): bigint {
  // The MCP derives `spendable` from Horizon's reserve fields (13 Sep: a deposit sized as
  // balance minus the fee hint failed with HostError #10 — the chain minimum balance).
  // An older server without it falls back to balance minus the fee hint on the native line.
  if (typeof row.spendable === "string") {
    try { return decimalWad(row.spendable); } catch { /* fall through to the derivation */ }
  }
  const balance = decimalWad(String(row.balance ?? ""));
  if (row.symbol !== "XLM") return balance;
  try {
    const reserve = decimalWad(String(wallet?.fee_reserve_xlm ?? ""));
    return balance > reserve ? balance - reserve : ZERO;
  } catch {
    return balance;
  }
}

function idleTokensFrom(observations: readonly Observation[], now: number, asset: string): string | null {
  const fresh = freshObservations(observations, now);
  const wallet = fresh.find((observation) => observation.capability === "wallet_balances");
  const assets = wallet?.data?.assets;
  if (!Array.isArray(assets)) return null;
  for (const row of assets) {
    if (!isRecord(row)) continue;
    if (row.symbol !== asset || row.error || (row.status !== undefined && row.status !== "ok")) continue;
    try {
      const spendable = spendableWad(row, wallet?.data);
      if (spendable > ZERO) return formatWad(spendable);
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
      total = total + mulDown(spendableWad(row, wallet?.data), price, WAD);
      priced += 1;
    } catch { /* an unparseable balance contributes nothing */ }
  }
  return priced > 0 ? formatWad(total) : null;
}
