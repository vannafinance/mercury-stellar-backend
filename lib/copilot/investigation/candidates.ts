/**
 * Candidate strategies, generated and ranked deterministically.
 *
 * The model contributes nothing here. Given the rate comparisons the investigation already
 * gathered and the authoritative position, the one shape enumerable in code is: borrow
 * against headroom and supply that. Every amount comes from `sizing.ts`, so each candidate
 * is re-derivable from its inputs.
 *
 * Nothing that moves the user's own wallet is generated here. Lending or supplying what the
 * wallet holds is a plan the model composes for what the user asked (and `plan.ts` sizes), or
 * an instruction they gave; a generator that volunteered it offered to move their money when
 * they had only asked a question (7 Oct: "how much more USDC can I borrow before my health
 * factor drops to 1.5" came back as "lend your BLUSDC to Earn").
 *
 * Two rules the plan calls for explicitly, both enforced here rather than left to prose:
 *
 *  - **Permission to borrow is not an instruction to borrow.** The borrow shape is ranked
 *    after any no-debt plan the model composed; when borrowing is required (typed on the
 *    goal or present as a borrow leg) the borrow shape is the only kind left.
 *  - **A negative carry is rejected, not ranked, unless the borrow was required.** If
 *    the borrow cost meets or exceeds the supply rate the position loses money by
 *    construction. An unspecified/allowed ask reports that reason. A required borrow is
 *    still sized: the user already named the instruction, the same way a stated losing
 *    plan is kept. No headroom is reported as a deposit or transfer they can accept.
 *
 * Supplying is treated as health-factor NEUTRAL. Borrowed proceeds deployed into Blend
 * become a tracking receipt the contract still counts as collateral (measured: recorded
 * BLEND_USDC of 0 alongside a non-zero tracking balance that `get_current_total_balance`
 * includes), so the projection comes from the borrow leg alone. Aquarius LP receipts are
 * NOT counted by the borrow guards, so LP shapes are deliberately absent until that
 * valuation is validated.
 */

import { decimalWad, formatWad, mulDown, WAD, ZERO } from "./fixed";
import { pct, planApy, shownApyPct } from "./apy";
import { isRecord } from "./decision";
import type { Observation } from "./types";
import { displayHealthFactors, sizeLegs, type SizedLeg } from "./sizing";
import type { RateAsset, RateComparison } from "./rate-comparison";
import { candidateId, candidateKindTraits, type CandidateKind } from "./candidate-id";
import type { ProposalStep } from "../workflow/types";
import { ASSET_IDS, mentionsBareUsdc, namesAsset, resolveAssetDef, USDC_VARIANTS } from "../registry/assets";
import { resolveName } from "../intent/resolve-name";

const USDC_SET = new Set<string>(USDC_VARIANTS);
/** APR gap (percentage points) below which we will not claim a yield winner. */
const APR_NOISE = decimalWad("0.2");

export interface CandidateInput {
  grossCollateralUsd: string;
  debtUsd: string;
  /** The user's stated floor. Null when none was stated: borrow shapes are then not offered. */
  floor: string | null;
  /** Spendable wallet value, kept for the callers that still pass it; the generator no longer reads it. */
  spendableWalletUsd: string | null;
  /** Per-token funds. A combined USD total cannot fund every token's alternative. */
  spendableWalletByAssetUsd?: Partial<Record<RateComparison["asset"], string>>;
  /** Token balances matching `spendableWalletByAssetUsd`, for the computed decision copy. */
  spendableWalletByAssetTokens?: Partial<Record<RateComparison["asset"], string>>;
  borrowingAllowed?: boolean;
  /** The user's borrowing intent, used only to order feasible candidates. */
  borrowing?: "unspecified" | "allowed" | "required" | "forbidden";
  /**
   * A borrow size the user named outright ("borrow 500 USDC"), in USD. When present it
   * REPLACES sizing to the floor: someone who states an amount has not asked for the
   * largest amount that fits.
   */
  requestedBorrowUsd?: string | null;
  comparisons: readonly RateComparison[];
  /** Contract-basis health factor before this plan is executed, when known. */
  initialHealthFactor?: string | null;
  /** The Margin page's figures; the card's health factor is shown on them. Sizing never uses them. */
  site?: { grossCollateralUsd: string; debtUsd: string } | null;
}

export interface Candidate {
  /** Minted by `candidate-id.ts` from `kind` and `asset`. Opaque everywhere else. */
  id: string;
  /** The strategy family. Consumers branch on this, never on the id string. */
  kind: CandidateKind;
  label: string;
  borrows: boolean;
  /** The asset the shape is about - the first leg's, for a composed plan. */
  asset: string;
  venue: "blend" | "earn" | "margin";
  /** Supply APR minus borrow APR, both simple APR. Null when nothing is borrowed. */
  netAprPct: string | null;
  /** Null when a supply leg's rate was not read - the option is still sized; the label says so. */
  supplyAprPct: string | null;
  /**
   * The same two figures as each venue's page shows them (`apy.ts`): what the card and the
   * reply quote. The APR fields above stay what the sizer and the carry guard judge by.
   * Optional so a candidate built before this field existed still renders.
   */
  supplyApyPct?: string | null;
  netApyPct?: string | null;
  legs: SizedLeg[];
  finalHealthFactor: string | null;
  /** The contract-basis health factor before this plan, when known. */
  initialHealthFactor?: string | null;
  healthFactorBefore?: string | null;
  amountUsd: string;
  evidenceIds: string[];
  /**
   * How `amountUsd` was chosen. `claimNext` may re-derive a floor-derived amount within
   * a bound; a stated amount is the instruction and must not be quietly shrunk.
   */
  amountBasis: "stated" | "derived_max_at_floor";
  /** Token amount already held, when this candidate spends wallet funds. */
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
  /** The model's reasoning for a composed plan. Copy only - every number beside it is code's. */
  rationale?: string;
  /** A composed repay plan: true when every debt row read is covered, false when some remains. */
  repaysAllDebt?: boolean;
  /** What the protocol's own preview said about the steps, when they were put to it (simulate.ts). */
  simulation?: import("./simulate").PlanSimulation;
}

export type DecisionFactor = "already_held" | "net_return" | "thin_margin" | "consolidation";

export interface CandidateDecision {
  factor: DecisionFactor;
  reason: string;
  runnerUpId: string | null;
}

export interface CandidateSet {
  feasible: Candidate[];
  /**
   * `acceptable` marks a refusal the user's own acceptance would lift, so the caller can
   * put it to them as a question instead of a verdict they cannot answer.
   */
  rejected: Array<{ label: string; reason: string; /** The reason without the leg it is prefixed with, so refusals with one cause can be said once. */ cause?: string; asset: string; acceptable?: true; accountRequired?: { code: "accountRequired"; actions: string[] };
    /** The protocol refused a borrow of this asset on a pool limit (its structured `limiting_factor`, not the sentence), so a smaller amount may pass. */
    poolLimited?: { asset: string }; borrowLimit?: import("./view").BorrowLimitRefusal }>;
}

function signedWad(value: string): bigint {
  if (value.startsWith("-")) return -decimalWad(value.slice(1) || "0");
  return decimalWad(value);
}

function aprOf(candidate: Candidate): bigint {
  try {
    return signedWad(candidate.netAprPct ?? candidate.supplyAprPct ?? "0");
  } catch {
    return ZERO;
  }
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
      reason: `Using ${winner.asset} - you hold ${formatHeld(held)} of it, so no swap is needed.`,
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
    // Whether the runner-up needs a swap is read off its own holding, never assumed: an
    // idle candidate exists only for a held balance (live: "you'd swap 675 first" about
    // 675 BLUSDC already in the wallet), while a model plan can name one not held.
    const runnerOwned = runnerUp.heldAmount != null && decimalWad(runnerUp.heldAmount) > ZERO;
    const tradeOff = runnerOwned
      ? `but you hold only ${formatHeld(runnerUp.heldAmount!)} of it, so it returns less at your size.`
      : `but you'd swap ${formatHeld(runnerUp.amountUsd)} into it first, which costs more than it gains.`;
    return {
      factor: "already_held",
      runnerUpId: runnerUp.id,
      reason: `Using ${winner.asset} - you hold ${formatHeld(winner.heldAmount ?? winner.amountUsd)} of it, so no swap is needed. ${net} ${runnerUp.asset} pays ${formatApr(extra)} more ${tradeOff}`,
    };
  }
  return {
    factor: "net_return",
    runnerUpId: runnerUp.id,
    reason: `Using ${winner.asset} - net return at your size is higher than ${runnerUp.asset}.`,
  };
}

/**
 * Coerce ranking intent from the typed goal, not from re-reading prose.
 *
 * A borrow the USER stated (a leg on `actions`, their own words) is an instruction even
 * when the model tagged borrowing as allowed or unspecified. A borrow the MODEL proposed
 * (a leg on one of its `plans`) is a suggestion, not an instruction: owner, 24 Sep, "yes",
 * permission to borrow is not an instruction to borrow. Counting model plans here made one
 * levered suggestion hide every no-debt option (the two long-standing
 * investigation-plans-e2e failures). Forbidden stays forbidden.
 *
 * Whether a live borrow capacity must be READ is a different question, answered by
 * `plansBorrow` below: a model plan that borrows still needs it to be sized.
 */
export function rankingBorrowing(
  borrowing: CandidateInput["borrowing"] = "unspecified",
  actions?: ReadonlyArray<{ op: string }> | null,
): NonNullable<CandidateInput["borrowing"]> {
  if (borrowing === "forbidden") return "forbidden";
  const statedBorrow = Boolean(actions?.some((action) => action.op === "borrow"));
  if (borrowing === "required" || statedBorrow) return "required";
  return borrowing ?? "unspecified";
}

/** Any model plan with a borrow leg: its sizing needs the live borrow capacity. */
export function plansBorrow(plans?: ReadonlyArray<{ legs: ReadonlyArray<{ op: string }> }> | null): boolean {
  return Boolean(plans?.some((plan) => plan.legs.some((leg) => leg.op === "borrow")));
}

export function rankFeasible(
  feasible: Candidate[],
  borrowing: CandidateInput["borrowing"] = "unspecified",
): Candidate[] {
  const noDebt = feasible.filter((candidate) => !candidate.borrows).sort(byExpectedReturn);
  const borrow = feasible.filter((candidate) => candidate.borrows).sort(byNetThenSize);
  // A required borrow is an instruction. Do not keep idle on the card: ranking it
  // second still let it win whenever the borrow failed to size.
  if (borrowing === "required") return borrow;
  const ranked = [...noDebt, ...borrow];
  const usdcNoDebt = noDebt.filter((candidate) => USDC_SET.has(candidate.asset));
  const winner = usdcNoDebt[0];
  if (!winner) return ranked;
  const runnerUp = usdcNoDebt.find((candidate) => candidate.asset !== winner.asset);
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

    // The wallet is never offered back as a ready-made option here: moving a user's tokens is a plan the
    // model composes for what they asked, or an instruction they gave, never a shape this generator volunteers.

    // A borrow needs a validated capacity floor. For a typed required-borrow goal the
    // service supplies the configured safety floor; without either source, do not size.
    if (input.borrowingAllowed === false || input.floor === null) continue;
    if (supply === null || borrow === null) continue;
    // 2. Borrow against headroom and supply the proceeds. Unspecified/allowed asks
    //    need a real positive carry. A required borrow is still sized: the user named
    //    the instruction, same as a stated losing plan.
    if (input.borrowing !== "required" && (comparison.verdict !== "positive_before_costs" || supply <= borrow)) {
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
     * answer a different question - and if it does not fit, the honest reply is that it
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
      const noHeadroom = sized.reason === "no_capacity_at_floor";
      rejected.push({
        label: `Borrow ${comparison.asset} to supply to Blend`,
        asset: comparison.asset,
        reason: requested && sized.reason === "health_floor_breached"
          ? headroom && headroom !== "0"
            ? `Borrowing ${requested} USD would take the health factor below your ${input.floor} floor. At most ${headroom} USD fits.`
            : `Borrowing ${requested} USD would take the health factor below your ${input.floor} floor, and there is no headroom at that floor.`
          : noHeadroom
            ? input.borrowing === "required"
              ? `No borrowing headroom left at a ${input.floor} health-factor floor. Deposit or transfer collateral into the margin account, then this borrow can be sized.`
              : `No borrowing headroom left at a ${input.floor} health-factor floor.`
            : `Could not size a borrow at a ${input.floor} floor (${sized.reason.replaceAll("_", " ")}).`,
        ...(input.borrowing === "required" && noHeadroom ? { acceptable: true as const } : {}),
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
      // The borrowed amount is what is supplied, so both legs carry the same USD.
      ...(() => {
        const usd = Number(sized.legs[0]?.amountUsd ?? "0");
        const apy = planApy([
          { kind: "blend_supply", usd, aprPct: formatWad(supply) },
          { kind: "earn_borrow", usd, aprPct: formatWad(borrow) },
        ], usd);
        return { supplyApyPct: apy.supplyApyPct === null ? null : pct(apy.supplyApyPct), netApyPct: apy.netApyPct === null ? null : pct(apy.netApyPct) };
      })(),
      legs: sized.legs,
      ...(() => {
        const shown = displayHealthFactors(input, input.site, sized.legs);
        const before = shown ? shown.before : input.initialHealthFactor ?? null;
        return {
          finalHealthFactor: shown && sized.finalHealthFactor !== null ? shown.after : sized.finalHealthFactor,
          ...(before ? { initialHealthFactor: before, healthFactorBefore: before } : {}),
        };
      })(),
      amountUsd: sized.legs[0]?.amountUsd ?? "0",
      evidenceIds: [...comparison.evidenceIds],
      amountBasis: requested ? "stated" : "derived_max_at_floor",
    });
  }

  return { feasible: rankFeasible(feasible, input.borrowing), rejected };
}

/**
 * Merge the fixed shapes with model-composed plans into one ranked set. The same steps
 * reached two ways are one option: the composed copy wins because it carries the
 * rationale the card shows. Rejections from both sides are listed with their reasons.
 */
/**
 * The fixed "supply idle X" options, narrowed to the assets the user actually named. Asked
 * about one asset, the user was being offered every other asset they hold: 23 Sep, "lend my
 * AQUA" (no Earn pool) was answered "Best path: Supply idle XLM to Blend" with five unrelated
 * options. Names come from the registry's own aliases; a bare "USDC" names all three
 * variants. A request that names no asset keeps every option ("use my whole wallet").
 */
export function onlyNamedAssets(set: CandidateSet | null, messages: readonly string[]): CandidateSet | null {
  if (!set) return set;
  const named = new Set<string>(ASSET_IDS.filter((id) => messages.some((message) => namesAsset(message, id))));
  if (messages.some((message) => mentionsBareUsdc(message))) for (const id of USDC_VARIANTS) named.add(id);

  // Near-matched assets (typos within distance threshold) also count as named
  for (const message of messages) {
    const tokens = message.split(/\s+/);
    for (const token of tokens) {
      const cleaned = token.replace(/^[^\w]+|[^\w]+$/g, "");
      if (!cleaned) continue;
      const res = resolveName(cleaned, ["asset"]);
      if (res.kind === "near") {
        for (const candidate of res.candidates) {
          named.add(candidate.id);
        }
      }
    }
  }

  if (!named.size) return set;
  return {
    feasible: set.feasible.filter((candidate) => named.has(candidate.asset)),
    rejected: set.rejected.filter((row) => named.has(row.asset)),
  };
}

export function mergeCandidateSets(
  fixed: CandidateSet | null,
  composed: { candidates: Candidate[]; rejected: Array<{ title: string; leg: string | null; reason: string; acceptable?: true; accountRequired?: { code: "accountRequired"; actions: string[] }; pocket?: { code: "wrong_pocket" | "insufficient_wallet"; expected: string; actual: string; remedy: string }; borrowLimit?: import("./view").BorrowLimitRefusal }> },
  borrowing: CandidateInput["borrowing"] = "unspecified",
): CandidateSet {
  // The op sequence a fixed shape compiles to, so it can be matched against a composed plan's steps.
  const FIXED_OPS: Record<Exclude<CandidateKind, "composed">, (asset: string) => string[]> = {
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
    feasible: rankFeasible(feasible.map((candidate) => ({ ...candidate, decision: undefined })), borrowing),
    rejected: [
      ...(fixed?.rejected ?? []),
      ...composed.rejected.map((entry) => ({
        label: entry.title,
        reason: entry.leg ? `${entry.leg}: ${entry.reason}.` : `${entry.reason}.`,
        cause: `${entry.reason}.`,
        asset: entry.leg?.split(" ").pop() ?? "",
        ...(entry.acceptable ? { acceptable: true as const } : {}),
        ...(entry.accountRequired ? { accountRequired: entry.accountRequired } : {}),
        ...(entry.pocket ? { pocket: entry.pocket } : {}),
        ...(entry.borrowLimit ? { borrowLimit: entry.borrowLimit } : {}),
      })),
    ],
  };
}

/**
 * A borrow size the user named outright, valued in USD.
 *
 * Sizing to the floor when someone asked for a specific amount answers a different
 * question, so the amount has to survive the trip into USD. It is valued ONLY from an
 * oracle price read during this same investigation - the same rule as `spendableWalletUsdFrom`,
 * and for the same reason: treating a stable's ticker as exactly $1 is an assumption, and
 * here it would flow straight into a health-factor check the user is relying on.
 *
 * `usd: null` means "they named an amount and it could not be valued". That is NOT the
 * same as no amount being named, and the caller must not fall back to sizing to the floor
 * on the strength of it.
 */
/**
 * The borrow size the user stated, read from what the model reported - never from the wording.
 *
 * The model returns each stated write as a structured leg whose literal sizing carries the exact
 * amount and the substring of the user's message that states it; code has verified that substring
 * is theirs. This takes the latest such borrow leg. A message is never scanned for a number near
 * the word "borrow": that is how "how much more USDC can I borrow before my health factor drops to
 * 1.5" became a borrow of 1.5 USDC.
 *
 * A number the user gave as a health-factor floor is never also a size. The model reports the floor
 * with its own quote, so when a literal's quote is only that floor, the leg is not an amount.
 */
export function statedBorrowFrom(
  legs: ReadonlyArray<{ op: string; asset: string; sizing: { kind: string; amount?: string; sourceQuote?: string } }>,
  floorQuote?: string | null,
): { asset: string; tokens: number } | null {
  let found: { asset: string; tokens: number } | null = null;
  for (const leg of legs) {
    if (leg.op !== "borrow" || leg.sizing.kind !== "literal" || !leg.sizing.amount) continue;
    const quote = leg.sizing.sourceQuote ?? "";
    // Skip a literal that only restates the floor: its quote sits inside the floor's span, or the amount is
    // gone from the quote once the floor's span is taken out of it.
    if (floorQuote && quote && (floorQuote.includes(quote) || !quote.split(floorQuote).join(" ").includes(leg.sizing.amount))) continue;
    const tokens = Number(leg.sizing.amount);
    if (Number.isFinite(tokens) && tokens > 0) found = { asset: leg.asset, tokens };
  }
  return found;
}

/** A stated borrow size valued in USD from this investigation's own price reads; null when none was stated. */
export function requestedBorrowFrom(
  stated: { asset: string; tokens: number } | null | undefined,
  observations: readonly Observation[],
  now: number,
): { asset: string; tokens: number; usd: string | null } | null {
  if (!stated) return null;
  const found = stated;

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
 * Anything unpriced is left out rather than valued at a guess - a plausible-looking total
 * built on an assumed $1 peg is exactly the kind of number that makes a strategy look
 * fundable when it is not. Returns null when nothing could be priced at all, which the
 * caller renders as "no non-borrowing option shown" rather than "you have nothing idle".
 */
/**
 * What the wallet can spend once the user's stated reserves are set aside. Applied where
 * the balance is read, not per sizing word, so "all idle", "half of it" and a stated
 * amount are all bounded by the same figure. A reserve at or above the balance leaves
 * nothing spendable in that token; the entry stays, at zero, so a refusal can name the
 * reserve instead of claiming the token is not held.
 */
export function holdingsAfterReserves(
  holdings: ReturnType<typeof spendableWalletHoldingsFrom>,
  reserves: readonly { asset: string; amount: string }[] | undefined,
): ReturnType<typeof spendableWalletHoldingsFrom> {
  if (!reserves?.length) return holdings;
  const out = { ...holdings };
  for (const { asset, amount } of reserves) {
    const held = out[asset as keyof typeof out];
    if (!held) continue;
    const tokens = decimalWad(held.tokens);
    const left = tokens > decimalWad(amount) ? tokens - decimalWad(amount) : ZERO;
    const usd = tokens > ZERO ? (decimalWad(held.usd) * left) / tokens : ZERO;
    out[asset as keyof typeof out] = { tokens: formatWad(left), usd: formatWad(usd) };
  }
  return out;
}

/**
 * The idle-wallet figures the fixed shapes size from, with the user's stated reserves set
 * aside: the same subtraction the plan sizer applies, so a "supply idle XLM" option cannot
 * offer the XLM the user said to keep.
 */
export function spendableWalletAfterReserves(
  observations: readonly Observation[],
  now: number,
  reserves: readonly { asset: string; amount: string }[] | undefined,
): { spendableWalletUsd: string | null; spendableWalletByAssetUsd: Partial<Record<RateComparison["asset"], string>>; spendableWalletByAssetTokens: Partial<Record<RateComparison["asset"], string>> } {
  const before = spendableWalletHoldingsFrom(observations, now);
  const after = holdingsAfterReserves(before, reserves);
  const spendableWalletByAssetUsd: Partial<Record<RateComparison["asset"], string>> = {};
  const spendableWalletByAssetTokens: Partial<Record<RateComparison["asset"], string>> = {};
  let setAside = ZERO;
  for (const [asset, held] of Object.entries(after) as Array<[RateAsset, { usd: string; tokens: string }]>) {
    spendableWalletByAssetUsd[asset] = held.usd;
    spendableWalletByAssetTokens[asset] = held.tokens;
    const was = before[asset];
    if (was) setAside += decimalWad(was.usd) - decimalWad(held.usd);
  }
  const total = spendableWalletUsdFrom(observations, now);
  const spendableWalletUsd = total === null ? null : formatWad(decimalWad(total) > setAside ? decimalWad(total) - setAside : ZERO);
  return { spendableWalletUsd, spendableWalletByAssetUsd, spendableWalletByAssetTokens };
}

export function spendableWalletByAssetUsdFrom(observations: readonly Observation[], now: number): Partial<Record<RateComparison["asset"], string>> {
  const holdings = spendableWalletHoldingsFrom(observations, now);
  const result: Partial<Record<RateComparison["asset"], string>> = {};
  for (const [asset, holding] of Object.entries(holdings) as Array<[RateAsset, { usd: string; tokens: string }]>) {
    result[asset] = holding.usd;
  }
  return result;
}

export function spendableWalletByAssetTokensFrom(observations: readonly Observation[], now: number): Partial<Record<RateComparison["asset"], string>> {
  const holdings = spendableWalletHoldingsFrom(observations, now);
  const result: Partial<Record<RateComparison["asset"], string>> = {};
  for (const [asset, holding] of Object.entries(holdings) as Array<[RateAsset, { usd: string; tokens: string }]>) {
    result[asset] = holding.tokens;
  }
  return result;
}

export function spendableWalletHoldingsFrom(
  observations: readonly Observation[],
  now: number,
): Partial<Record<RateAsset, { usd: string; tokens: string }>> {
  return walletHoldingsFrom(observations, now).spendable;
}

/**
 * Wallet lines worth less than one transaction: held, but not worth moving. 13 Sep, live:
 * "lend 0.0003729 AQUSDC to Earn - about 20.18 % APR on $0.00" was offered, approved and
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
 * at the XLM price read this investigation. Null when either was not read - then nothing
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
): { spendable: Partial<Record<RateAsset, { usd: string; tokens: string }>>; dust: Partial<Record<RateAsset, { usd: string; tokens: string }>> } {
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
    const value = spendableWalletUsdFrom(scoped, now);
    const tokens = spendableTokensFrom(scoped, now, asset);
    if (value === null || tokens === null) continue;
    if (floor !== null && decimalWad(value) < floor) dust[asset] = { usd: value, tokens };
    else result[asset] = { usd: value, tokens };
  }
  return { spendable: result, dust };
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
 * back for transaction fees (`fee_reserve_xlm`); a spendable amount that includes it would
 * leave the wallet unable to pay for the very deposit that moves it. The reserve is the
 * read's own number, applied to the native line only.
 */
function spendableWad(row: Record<string, unknown>, wallet: Record<string, unknown> | undefined): bigint {
  // The MCP derives `spendable` from Horizon's reserve fields (13 Sep: a deposit sized as
  // balance minus the fee hint failed with HostError #10 - the chain minimum balance).
  // An older server without it falls back to balance minus the fee hint on the native line.
  if (typeof row.spendable === "string") {
    try { return decimalWad(row.spendable); } catch { /* fall through to the derivation */ }
  }
  const balance = decimalWad(String(row.balance ?? ""));
  if (row.symbol !== "XLM") return balance;
  try {
    const minimum = decimalWad(String(row.min_balance ?? "0"));
    const fee = decimalWad(String(wallet?.fee_reserve_xlm ?? ""));
    const reserve = minimum + fee;
    return balance > reserve ? balance - reserve : ZERO;
  } catch {
    return balance;
  }
}

/**
 * A wallet line the read shows as held but not spendable - the chain minimum balance and
 * the fee reserve eat all of it. Null when the line is absent, empty, or spendable. 14 Sep:
 * "lend 1 xlm" was offered from 3.94 XLM of which 3.5 was the minimum balance and 0.5 the
 * fee reserve; the contract answered "resulting balance is not within the allowed range".
 */
export function unspendableWalletLine(observations: readonly Observation[], now: number, asset: string): { balance: string; minBalance: string | null; feeReserve: string | null } | null {
  const wallet = freshObservations(observations, now).find((observation) => observation.capability === "wallet_balances");
  const assets = wallet?.data?.assets;
  if (!Array.isArray(assets)) return null;
  for (const row of assets) {
    if (!isRecord(row) || row.symbol !== asset || row.error || (row.status !== undefined && row.status !== "ok")) continue;
    try {
      const balance = decimalWad(String(row.balance ?? ""));
      if (balance <= ZERO || spendableWad(row, wallet?.data) > ZERO) return null;
      const text = (value: unknown) => typeof value === "string" && value ? value : null;
      return { balance: formatWad(balance), minBalance: text(row.min_balance), feeReserve: row.symbol === "XLM" ? text(wallet?.data?.fee_reserve_xlm) : null };
    } catch { return null; }
  }
  return null;
}

function spendableTokensFrom(observations: readonly Observation[], now: number, asset: string): string | null {
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

export function spendableWalletUsdFrom(observations: readonly Observation[], now: number): string | null {
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
