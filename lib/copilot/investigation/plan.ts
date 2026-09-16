/**
 * Model proposes, code disposes.
 *
 * The model composes strategy SHAPES — ordered legs from a closed op vocabulary, each
 * sized by a word (`all_idle`, `to_floor`, `previous_leg`, `literal`). This module turns
 * a shape into a `Candidate` the rest of the pipeline already understands, or rejects it
 * with a reason the user can read. Nothing the model wrote reaches a transaction: every
 * amount comes from a wallet read, a price read, the user's own quoted number, or the
 * closed-form sizer against the user's floor; every step is re-checked by the write
 * allowlist; every intermediate health factor is projected in `sizeLegs`.
 *
 * Before this, the strategy space was three hand-written shapes on four hand-listed
 * assets, and any prompt outside them produced an empty card (13 Sep). The op vocabulary
 * is still closed — each op has an executor, an allowlist entry and a risk projection —
 * but the combinations are the model's to find.
 */

import { assetForVenueSpelling, ASSET_SYMBOL_PATTERN, poolVenueFor, resolveAssetDef, swappableWith } from "../registry/assets";
import { allowedInvocation, TOOLS, writeArgsFor } from "../workflow/allowlist";
import { ASSET_OUT_OPS, feeds, OP_FLOW, SIZED_OPS, WORKFLOW_OPS, type Pocket, type ProposalStep, type SizedOp, type WorkflowOp } from "../workflow/types";
import { isRecord } from "./decision";
import { candidateId } from "./candidate-id";
import { dustWalletHoldingsFrom, freshPrices, idleWalletHoldingsFrom, transactionFloorUsdWad, unspendableWalletLine, type Candidate } from "./candidates";
import { priceFor, tokensFromUsd, wireSymbol, writeArgs } from "./compile";
import { decimalWad, formatWad, mulDown, WAD, ZERO } from "./fixed";
import type { RateComparison } from "./rate-comparison";
import { LIQUIDATION_THRESHOLD_WAD, maxWithdrawForFloorWad, sizeLegs, type LegRequest, type SizedLeg } from "./sizing";
import { decimalsFrom, truncateToDecimals } from "./precision";
import { constantProductOut, exactOutputIn, MAX_PRICE_IMPACT_PCT, poolReservesFrom, priceImpactWad, reservesForDirection, slippageFloor, SWAP_SLIPPAGE_BPS, type PoolReserves } from "./pool-quote";
import type { GoalUnderstanding, InvestigationScope, Observation, PlanLeg, PlanSizing, ProposedPlan } from "./types";
import type { OpFlow } from "../workflow/types";

/**
 * The floor a swap write is sent with, in basis points below the oracle-implied amount —
 * the same 0.5% `vanna_swap` itself defaults to when no floor is given. Computing it here
 * from the prices this investigation already read, rather than leaving it to the tool's
 * own auto-quote, is what lets the propose-time preview (PR #6) simulate the EXACT trade
 * the write will carry: preview and write are both told the same `min_out`, so the card
 * never simulates a different swap from the one the user signs.
 */

export interface PlanContext {
  scope: InvestigationScope;
  observations: readonly Observation[];
  now: number;
  /** Conversation, for anchoring `literal` amounts to text the user actually typed. */
  messages: readonly string[];
  /**
   * The margin position and the user's stated floor (null when none was stated — then the
   * contract's liquidation line is the stop and no borrow can be sized). Null as a whole
   * when the position could not be read; every account-touching leg is then rejected.
   */
  capacity: {
    grossCollateralUsd: string;
    debtUsd: string;
    floor: string | null;
    /**
     * Set when the app snapshot and the contract liquidation snapshot disagree (or the
     * contract could not be read): the figures above are the contract's, a deposit may
     * still be sized from the wallet and projected on them, but nothing that lowers
     * health is sized until the sources agree — an owner rule, never a silent preference.
     */
    issue?: { reason: "sizing_sources_disagree" | "sizing_contract_unavailable" | "sizing_app_unavailable"; app: { grossCollateralUsd: string; debtUsd: string }; contract: { grossCollateralUsd: string; debtUsd: string } | null } | null;
  } | null;
  borrowing: "unspecified" | "allowed" | "required" | "forbidden";
  comparisons: readonly RateComparison[];
}

export interface RejectedPlan {
  title: string;
  /** Which leg failed, as "op asset", or null when the plan as a whole did. */
  leg: string | null;
  reason: string;
}

export interface ResolvedPlans {
  candidates: Candidate[];
  rejected: RejectedPlan[];
}

/**
 * A compact code per op keeps a six-leg id inside the 80-character candidate-id bound:
 * initials of a multi-word op (`deposit_collateral` → `dc`), first two letters otherwise
 * (`borrow` → `bo`). Derived, so a new op needs no entry here.
 */
function opCode(op: PlanLeg["op"]): string {
  const words = op.split("_");
  return words.length > 1 ? words.map((w) => w[0]).join("") : op.slice(0, 2);
}

/** A leg as the sizer walks it: the model's leg, plus a marker the expansion below sets. */
type SizerLeg = ProposedPlan["legs"][number] & { fundsRepay?: true; repayShare?: PlanSizing & { kind: "fraction" } };

/**
 * The account is what repays — `vanna_repay` draws on the smart account's balance, and
 * "to repay from the trader's wallet, deposit first" (MCP). So a repay the model sizes
 * from idle wallet funds (`all_idle`) is two protocol legs: deposit the asset, capped by
 * the debt, then repay what that deposit put in. The plan's id stays the model's; the
 * steps, the projection and the approval-time risk check all see the two real legs.
 * 13 Sep: sized as one leg, the approve-time check read the account (which held none of
 * the 9,999 XLM the wallet did), sent the plan back to "proposed", and nothing ran.
 */
/** Whether a sizing word takes its amount from the wallet's idle balance. */
function drawsOnWallet(sizing: PlanSizing): boolean {
  return sizing.kind === "all_idle" || sizing.kind === "all_position"
    || (sizing.kind === "fraction" && sizing.of === "idle") || sizing.kind === "literal";
}

function expandLegs(legs: ProposedPlan["legs"], ctx: PlanContext): SizerLeg[] {
  // `all_position` on a repay means the whole debt; it is still paid from the wallet through
  // the account, so it is the same two legs, capped by the debt — partial when the wallet
  // covers less, and the card says what remains. 13 Sep: "Repay 14113 XLM, then 2559 BLUSDC"
  // was offered against a wallet holding 9,999 XLM and no BLUSDC; it could never have run.
  return legs.flatMap((leg, index): SizerLeg[] => {
    if (leg.op !== "repay") return [leg];
    /**
     * The model may have written the funding deposit itself — "repay my debt, and if I
     * don't have the funds deposit into my margin account" is one instruction that reads
     * as two legs. Expanding the repay as well would spend the same idle balance twice:
     * 14 Sep, a plan deposited 3,315.63 XLM, deposited it again, then repaid it, and the
     * approve-time funds check blocked the run. When the leg before it already moves this
     * asset from the wallet, the repay takes what that deposit put in.
     */
    const before = legs[index - 1];
    if (before && before.op === "deposit_collateral" && before.asset === leg.asset && drawsOnWallet(before.sizing)) {
      return [{ op: "repay", asset: leg.asset, sizing: { kind: "previous_leg" } }];
    }
    /**
     * "Repay all my debt" names no source — the account is already one, and it repays from
     * itself when it can. Injecting a wallet deposit unconditionally refused the repay for
     * want of wallet funds it never needed: 14 Sep, an account holding 842.46 XLM against
     * 68.49 XLM of debt was told the wallet had nothing spendable. "Repay with my idle
     * XLM" (`all_idle`) does name the wallet, so that one still deposits first.
     */
    if (leg.sizing.kind === "all_position") {
      const def = resolveAssetDef(leg.asset);
      const owed = def?.marginSymbol ? positionRowBalance(ctx.observations, "account_debt", POSITION_ROWS.account_debt, def.marginSymbol, def.id, ctx.now) : null;
      const held = def?.marginSymbol ? positionRowBalance(ctx.observations, "account_collateral", POSITION_ROWS.account_collateral, def.marginSymbol, def.id, ctx.now) : null;
      if (owed !== null && held !== null && decimalWad(held) >= decimalWad(owed) && decimalWad(owed) > ZERO) return [leg];
    }
    if (leg.sizing.kind === "all_idle" || leg.sizing.kind === "all_position") {
      return [{ op: "deposit_collateral", asset: leg.asset, sizing: { kind: "all_idle" }, fundsRepay: true }, { op: "repay", asset: leg.asset, sizing: { kind: "previous_leg" } }];
    }
    // "repay 25% of my debt" (of: position) or "repay with a quarter of my idle XLM" (of: idle):
    // the deposit leg takes the share; the repay takes what the deposit put in.
    if (leg.sizing.kind === "fraction") {
      return leg.sizing.of === "position"
        ? [{ op: "deposit_collateral", asset: leg.asset, sizing: { kind: "all_idle" }, fundsRepay: true, repayShare: leg.sizing }, { op: "repay", asset: leg.asset, sizing: { kind: "previous_leg" } }]
        : [{ op: "deposit_collateral", asset: leg.asset, sizing: leg.sizing, fundsRepay: true }, { op: "repay", asset: leg.asset, sizing: { kind: "previous_leg" } }];
    }
    // "repay 100 XLM": from the account when it holds that much, else the wallet puts it in first.
    if (leg.sizing.kind === "literal") {
      const def = resolveAssetDef(leg.asset);
      const held = def?.marginSymbol ? positionRowBalance(ctx.observations, "account_collateral", POSITION_ROWS.account_collateral, def.marginSymbol, def.id, ctx.now) : null;
      if (held !== null && decimalWad(held) >= decimalWad(leg.sizing.amount)) return [leg];
      return [{ op: "deposit_collateral", asset: leg.asset, sizing: leg.sizing, fundsRepay: true }, { op: "repay", asset: leg.asset, sizing: { kind: "previous_leg" } }];
    }
    return [leg];
  });
}

/**
 * The share a fraction sizing means, as a WAD ratio, anchored to the user's words: the
 * percent must appear in the quote as a number, or the quote must contain a word that
 * means it. The words are language, not protocol — hand-authored like asset aliases.
 */
const FRACTION_WORDS: ReadonlyArray<{ pattern: RegExp; percent: number }> = [
  { pattern: /\bthree[\s-]quarters?\b/i, percent: 75 },
  { pattern: /\btwo[\s-]thirds?\b/i, percent: 200 / 3 },
  { pattern: /\bhalf\b/i, percent: 50 },
  { pattern: /\b(a\s+)?third\b/i, percent: 100 / 3 },
  { pattern: /\b(a\s+)?quarter\b/i, percent: 25 },
  { pattern: /\b(a\s+)?fifth\b/i, percent: 20 },
  { pattern: /\b(a\s+)?tenth\b/i, percent: 10 },
];
function anchoredShare(sizing: PlanSizing & { kind: "fraction" }, messages: readonly string[], name: string): bigint {
  if (!messages.some((m) => m.includes(sizing.sourceQuote))) throw new Reject(name, `the share "${sizing.sourceQuote}" does not appear in your request`);
  const percent = Number(sizing.percent);
  const numbers = (sizing.sourceQuote.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const byNumber = numbers.some((n) => Math.abs(n - percent) < 1e-9);
  const byWord = FRACTION_WORDS.some((w) => w.pattern.test(sizing.sourceQuote) && Math.abs(w.percent - percent) < 1e-6);
  if (!byNumber && !byWord) throw new Reject(name, `the share ${sizing.percent}% does not appear in your request`);
  return decimalWad(percent.toFixed(9)) / BigInt(100);
}
/** The leverage multiple itself, anchored to the user's own words — never a number the model only implied. */
function anchoredMultiple(sizing: PlanSizing & { kind: "leverage" }, messages: readonly string[], name: string): bigint {
  if (!messages.some((m) => m.includes(sizing.sourceQuote))) throw new Reject(name, `the leverage "${sizing.sourceQuote}" does not appear in your request`);
  const multiple = Number(sizing.multiple);
  const numbers = (sizing.sourceQuote.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (!numbers.some((n) => Math.abs(n - multiple) < 1e-9)) throw new Reject(name, `the ${sizing.multiple}x leverage does not appear in your request`);
  return decimalWad(sizing.multiple);
}
/**
 * How many of a token a phrase actually states.
 *
 * A number in someone's words is not always a quantity of tokens, and the anchor used to
 * compare raw digit substrings, which got both halves wrong (15 Sep findings, B1/B2):
 *
 *   "borrow 2x aqusdc"      -> `2` matched, and a LEVERAGE factor was executed as 2 tokens
 *   "remove 10k xlm"        -> `10000` did not match the substring `10`, and was refused
 *
 * So each number is read with what surrounds it. `x` is leverage and `%` is a share —
 * neither is an amount, so both are dropped rather than matched. A figure the user pinned
 * to their health factor is a target, not a quantity. `k`/`m`/`b` are how people write
 * quantities, so they are expanded. The suffix tests stop at a letter boundary, so `100xlm`
 * stays an amount of XLM and does not read as leverage.
 */
const SCALES: Readonly<Record<string, number>> = Object.freeze({ k: 1_000, m: 1_000_000, b: 1_000_000_000 });
function tokenAmountsIn(text: string): string[] {
  const amounts: string[] = [];
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)([a-z%]*)/gi)) {
    const suffix = match[2] ?? "";
    const before = text.slice(0, match.index ?? 0);
    if (/^x(?![a-z])/i.test(suffix)) continue;
    if (suffix.startsWith("%")) continue;
    if (/\b(hf|health\s*factor)\b[^\d]{0,24}$/i.test(before)) continue;
    const scale = /^[kmb](?![a-z])/i.test(suffix) ? SCALES[suffix[0].toLowerCase()] : null;
    try {
      const wad = decimalWad(match[1]);
      amounts.push(formatWad(scale ? wad * BigInt(scale) : wad));
    } catch { /* not a figure the chain can count */ }
  }
  return amounts;
}
/** Two written amounts are the same quantity — "1.40" and "1.4" are one number, not two. */
function sameAmount(a: string, b: string): boolean {
  try { return decimalWad(a) === decimalWad(b); } catch { return false; }
}
function shareOf(amount: string, share: bigint): string {
  return formatWad(mulDown(decimalWad(amount), share, WAD));
}

/** The debt rows read this investigation, as `{ asset, owed }` — what a full repay must cover. */
function debtRows(ctx: PlanContext): Array<{ asset: string; owed: string }> {
  const read = [...ctx.observations].reverse().find((o) => o.capability === "account_debt" && o.status === "ok" && o.data && ctx.now - o.observedAt <= 60_000);
  const rows = read?.data?.debt;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!isRecord(row) || typeof row.symbol !== "string") return [];
    const def = assetForVenueSpelling("margin", row.symbol);
    const owed = row.balance;
    if (!def || typeof owed !== "string") return [];
    try { return decimalWad(owed) > ZERO ? [{ asset: def.id, owed }] : []; } catch { return []; }
  });
}

class Reject extends Error {
  constructor(readonly leg: string | null, message: string) { super(message); }
}

const SIZER_REASONS: Record<string, string> = {
  floor_below_liquidation_threshold: "a health-factor floor at or below 1.1 is the liquidation line, not a safety margin — state a floor above it",
  would_be_liquidatable: "this would leave the account liquidatable",
  floor_required_for_max: "sizing to the floor needs a stated health-factor floor",
  no_capacity_at_floor: "there is no headroom at your health-factor floor",
  health_floor_breached: "this would take the health factor below your floor",
  repay_exceeds_debt: "the repay is larger than the outstanding debt",
  repay_exceeds_collateral: "the repay is larger than the collateral",
  invalid_base_or_floor: "the margin position or the floor could not be read as numbers",
};

/** One id per shape: two plans with the same legs are the same option. */
export function planCandidateId(plan: ProposedPlan): string {
  return candidateId("composed", plan.legs.map((l) => `${opCode(l.op)}.${l.asset}`).join("+"));
}

export function resolvePlans(plans: readonly ProposedPlan[], ctx: PlanContext): ResolvedPlans {
  const candidates: Candidate[] = [];
  const rejected: RejectedPlan[] = [];
  const seen = new Set<string>();
  for (const plan of plans) {
    try {
      const candidate = resolvePlan(plan, ctx);
      if (seen.has(candidate.id)) continue; // the same shape twice is one option
      seen.add(candidate.id);
      candidates.push(candidate);
    } catch (error) {
      if (error instanceof Reject) rejected.push({ title: plan.title, leg: error.leg, reason: error.message });
      else rejected.push({ title: plan.title, leg: null, reason: "this plan could not be sized from the reads that completed" });
    }
  }
  return { candidates, rejected };
}

/**
 * The on-chain collateral allowlist, when this investigation read it. The registry's
 * `marginSymbol` is static app knowledge; the contract's answer wins when both exist.
 * Null when not read, so the registry stands alone.
 */
function liveCollateralAllowed(observations: readonly Observation[]): Map<string, boolean> | null {
  const read = observations.find((o) => o.capability === "collateral_config" && o.status === "ok" && Array.isArray(o.data?.allowed_collateral));
  if (!read) return null;
  const rows = read.data!.allowed_collateral as unknown[];
  const allowed = new Map<string, boolean>();
  for (const row of rows) {
    if (isRecord(row) && typeof row.symbol === "string" && typeof row.allowed === "boolean") allowed.set(row.symbol, row.allowed);
  }
  return allowed;
}

function resolvePlan(plan: ProposedPlan, ctx: PlanContext): Candidate {
  const holdings = idleWalletHoldingsFrom(ctx.observations, ctx.now);
  const dust = dustWalletHoldingsFrom(ctx.observations, ctx.now);
  const txFloor = transactionFloorUsdWad(ctx.observations, ctx.now);
  const prices = freshPrices(ctx.observations, ctx.now);
  const evidence = new Set(ctx.observations.filter((o) => o.status === "ok").map((o) => o.id));
  const collateralAllowed = liveCollateralAllowed(ctx.observations);
  /**
   * Every amount this plan emits is cut to the precision the protocol reported for that
   * token. A token whose precision no read stated is a rejection, not a guess —
   * `readsForPlans` asks for the wallet read so this is rare.
   */
  const decimals = decimalsFrom(ctx.observations);
  const precise = (amount: string, symbol: string, name: string): string => {
    const places = decimals.get(symbol);
    if (places === undefined) throw new Reject(name, `the on-chain precision of ${symbol} was not read this investigation`);
    return truncateToDecimals(amount, places);
  };

  /**
   * Pass 1 — resolve what each leg is sized FROM. Margin legs go to the sizer as USD (or
   * "max" for `to_floor`); wallet legs are sized here. `previous_leg` is a reference the
   * sizer's output fills in.
   */
  interface Draft {
    leg: PlanLeg; name: string;
    usd: string | "max" | { previous: number };
    /** For a "max" leg: what the pocket holds, in USD — a withdraw takes no more than is posted. */
    capUsd?: string;
    /** The amount the tool is called with (vTokens for a redeem). */
    tokens: string | null;
    /** What the leg leaves for the next one; differs from `tokens` only for a redeem. */
    produces: string | null;
    heldTokens: string | null;
    targetOut?: string;
  }
  const drafts: Draft[] = [];
  for (const [index, leg] of expandLegs(plan.legs, ctx).entries()) {
    const name = `${leg.op.replaceAll("_", " ")} ${leg.asset}`;
    const def = resolveAssetDef(leg.asset);
    if (!def) throw new Reject(name, `${leg.asset} is not a supported asset`);
    const price = priceFor(leg.asset, ctx.observations, ctx.now);
    if (!price.ok) throw new Reject(name, price.reason === "stale_price" ? `the ${leg.asset} price read is older than a minute` : `no ${leg.asset} price was read this investigation`);
    // The venue the op acts on decides which spelling of the asset it needs (the op-flow table).
    const walletOp = OP_FLOW[leg.op].venue === "earn";
    if (walletOp && !def.earnSymbol) throw new Reject(name, `${leg.asset} has no Earn pool`);
    if (!walletOp && !def.marginSymbol) throw new Reject(name, `${leg.asset} is not accepted by the margin account`);
    if (leg.op === "deposit_collateral" && collateralAllowed?.get(def.marginSymbol!) === false) {
      throw new Reject(name, `${leg.asset} is not accepted as collateral on-chain right now (collateral_config)`);
    }
    if (leg.op === "supply_blend" && !def.blendReserve) throw new Reject(name, `Blend has no ${leg.asset} reserve`);
    // remove_liquidity names the token XLM is paired with; a token with no LP venue has no such pool.
    if (leg.op === "remove_liquidity" && !def.lpVenue) throw new Reject(name, `${leg.asset} has no LP pool paired with XLM`);
    /**
     * A swap buys a second asset. The account must accept it as collateral — buying
     * something the RiskEngine does not price would drop the account's backing without
     * the health projection seeing it — and the DEX must be one the protocol routes to.
     */
    /**
     * What the swap buys. The model should say so in `assetOut`, but a field that JSON
     * Schema cannot mark required only for one op is one the model routinely omits — on
     * 15 Sep "swap 10 XLM to BLUSDC" came back as a swap leg with no assetOut three times
     * running. The user named the asset in their own sentence, so it is read from there,
     * anchored exactly as a literal amount is: it must appear in their words, and it must
     * be the only candidate besides the one being spent.
     */
    const bought = leg.op === "swap" ? resolveAssetDef(leg.assetOut ?? "") : null;
    if (leg.op === "swap") {
      if (!bought) throw new Reject(name, `name the asset you want to receive — "swap ${d0(leg)} ${def.id} to BLUSDC", for instance`);
      if (bought.id === def.id) throw new Reject(name, `a swap has to change the asset — ${def.id} for ${bought.id} is the same token`);
      if (!bought.marginSymbol) throw new Reject(name, `${bought.id} is not accepted by the margin account, so the swap would leave it unbacked`);
      /**
       * A pair trades only where a pool holds both sides. `lpVenue` names the DEX that
       * pairs a token with XLM, so XLM itself carries none while trading on every venue,
       * and BLUSDC carries none because Blend's USDC has no pool at all. Reading the venue
       * off either asset would have routed XLM→BLUSDC to a pool that cannot fill it.
       */
      const pool = poolVenueFor(def.id, bought.id);
      if (!pool) {
        const tradable = swappableWith(def.id);
        throw new Reject(name, tradable.length
          ? `no pool trades ${def.id} for ${bought.id} — ${def.id} can be swapped for ${tradable.join(" or ")}`
          : `no pool trades ${def.id}`);
      }
      if (leg.venue && leg.venue !== pool) {
        throw new Reject(name, `${def.id} and ${bought.id} trade on ${venueLabel(pool)}, not ${venueLabel(leg.venue)}`);
      }
      /**
       * "Swap XLM to receive 961 AQUSDC" names the OUTPUT amount; the write API only takes
       * an input amount and a floor. On Aquarius, with the pool's live reserves read, the
       * question inverts cleanly: how much input does the pool's own curve need for that
       * exact output — sized in the sizing dispatch below, the same as any other amount.
       * Anywhere else, there is no curve to invert against, so it stays refused.
       */
      if (leg.sizing.kind === "literal" && leg.sizing.amountAsset === "assetOut") {
        // Either venue can be inverted now: both are constant product, and each has a
        // reserves read answering in the same envelope. What cannot be inverted is a
        // pool nobody read — that is refused by name rather than sized from a price.
        if (!poolReservesOf(ctx.observations, def.id === "XLM" ? bought.id : def.id, pool, ctx.now)) {
          throw new Reject(name, `no live ${pool} pool reserves were read this investigation, so an exact ${bought.id} amount cannot be sized`);
        }
      }
      /**
       * `swap_killed` is NOT a refusal.
       *
       * It comes from Aquarius's off-chain AMM API describing a pool, and it is not what
       * the chain enforces. Live, 16 Sep: with the flag true on the router-selected pool,
       * the pool's own `estimate_swap` still answered, the transaction still simulated,
       * and the website's Trade > Spot page settled a real swap on that very pool
       * (-10 XLM / +0.12 AQUSDC, matching its quote exactly) — while the copilot refused
       * every one of them on this line. Refusing here blocked swaps the chain accepts,
       * and made the copilot look broken next to the site's own swap page.
       *
       * What actually decides now: the MCP quotes every pool the router has for the pair
       * via each pool's own `estimate_swap`, takes the best, and refuses only when no pool
       * can quote at all. The flag rides along as a note on the card.
       */
      void aquariusPoolDataOf;
      const boughtPrice = priceFor(bought.id, ctx.observations, ctx.now);
      if (!boughtPrice.ok) throw new Reject(name, `no ${bought.id} price was read this investigation`);
    }
    /**
     * An add-liquidity leg spends BOTH the pool's tokens. `asset` is whichever side the
     * user stated an amount for — exactly the same "spent" convention swap uses — and
     * `assetOut` is the other side, the paired amount is NEVER the model's number: it is
     * derived at step-building time from the pool's own live reserves.
     *
     * Aquarius only, for now. Soroswap's own contract corrects an imperfect TOKEN ratio
     * on-chain (compute_soroswap_add_liquidity_auth_amounts reads its own reserves and
     * uses whichever side fits), so the deposit amounts are safe either way — but the
     * SEPARATE min_liquidity_out floor (the LP shares minted) has no such protection, and
     * this MCP has no Soroswap reserves/total-supply read to compute one honestly. Rather
     * than ship that floor as a silent 0 — exactly the swap bug fixed today — Soroswap
     * add_liquidity is refused until that read exists, same as the exact-output swap gap.
     */
    const paired = leg.op === "add_liquidity" ? resolveAssetDef(leg.assetOut ?? "") : null;
    if (leg.op === "add_liquidity") {
      if (!paired) throw new Reject(name, `name the token ${def.id} is paired with — AQUSDC for Aquarius`);
      if (paired.id === def.id) throw new Reject(name, `a pool needs two different tokens — ${def.id} and ${paired.id} is the same token`);
      if (!paired.marginSymbol) throw new Reject(name, `${paired.id} is not accepted by the margin account, so the deposit would leave it unbacked`);
      const pool = poolVenueFor(def.id, paired.id);
      if (!pool) {
        const tradable = swappableWith(def.id);
        throw new Reject(name, tradable.length
          ? `no pool holds ${def.id} and ${paired.id} together — ${def.id} pairs with ${tradable.join(" or ")}`
          : `no pool holds ${def.id}`);
      }
      if (leg.venue && leg.venue !== pool) {
        throw new Reject(name, `${def.id} and ${paired.id} pool on ${venueLabel(pool)}, not ${venueLabel(leg.venue)}`);
      }
      if (pool !== "aquarius") {
        throw new Reject(name, `add_liquidity on ${venueLabel(pool)} is not supported yet — this MCP has no live reserves read for it, so the LP-share floor cannot be set honestly; Aquarius is available`);
      }
      const reserves = aquariusReservesOf(ctx.observations, def.id === "XLM" ? paired.id : def.id, ctx.now);
      const poolData = aquariusPoolDataOf(ctx.observations, def.id === "XLM" ? paired.id : def.id, ctx.now);
      if (poolData?.deposit_killed === true) throw new Reject(name, "deposits are paused on the router-selected Aquarius pool");
      if (!reserves) throw new Reject(name, `no live ${pool} pool reserves were read this investigation, so the paired amount cannot be sized against the real ratio`);
    }
    if (!walletOp && !ctx.scope.smartAccount) throw new Reject(name, "a margin account is needed for this step and none is connected");
    if (!walletOp && !ctx.capacity) throw new Reject(name, "the margin position was not read, so nothing touching the account can be sized");
    /**
     * A withdraw lowers health exactly as a borrow does, so it carries the same gate — but
     * only for the one issue with no authoritative basis at all. `sizing_sources_disagree`
     * and `sizing_app_unavailable` both still have the contract's figures (what
     * `ctx.capacity.grossCollateralUsd`/`debtUsd` already are), which is the number that
     * liquidates the account; refusing on top of that protected nothing (doc:
     * collateral-disagreement-root-cause, 15 Sep) and blocked every withdraw on an account
     * holding so much as one unposted token.
     */
    if (leg.op === "withdraw_collateral" && ctx.capacity?.issue?.reason === "sizing_contract_unavailable") {
      throw new Reject(name, "the position could not be confirmed against the liquidation engine, so nothing that lowers health is sized");
    }
    // Owner rule (service.ts): permission to borrow is optional, not an instruction; "unspecified"
    // still offers a levered path beside the idle one. Only an explicit prohibition rules it out.
    if (leg.op === "borrow" && ctx.borrowing === "forbidden") throw new Reject(name, "you said no new borrowing");
    /**
     * A floor is only REQUIRED here for `to_floor` — the sizing word that means "borrow the
     * most the floor allows", which is meaningless without one (`sizeLegs`' own
     * `floor_required_for_max`). A stated amount ("borrow 60 AQUSDC") or a stated multiple
     * needs no floor at all: `sizeLegs` below prices the resulting health factor either way,
     * against the user's floor when they gave one or against the 1.1 liquidation line when
     * they did not, and shows the plan with that figure rather than a number nobody asked
     * for. 15 Sep, live: "deposit 10 xlm and take 6x leverage" was refused outright here —
     * before the sizer, which would have shown the resulting HF and let the user decide —
     * for a floor the leg never needed, on a sizing word this check did not even name.
     */
    if (leg.op === "borrow" && leg.sizing.kind === "to_floor" && ctx.capacity && ctx.capacity.floor === null) {
      throw new Reject(name, "borrowing to the floor needs the health-factor floor you want kept, above the 1.1 liquidation line — tell me the number, or state the amount and I'll show you the health factor it leaves");
    }
    // Same gate as withdraw, same reason: only the missing-contract-basis case has nothing to size from.
    if (leg.op === "borrow" && ctx.capacity?.issue?.reason === "sizing_contract_unavailable") {
      throw new Reject(name, "the contract's liquidation snapshot could not be read, so a borrow is not sized");
    }

    const sizing = leg.sizing;
    const flow = OP_FLOW[leg.op];
    // An idle wallet balance feeds the ops that draw from the wallet; `all_position` on those is the same thing.
    if (sizing.kind === "all_idle" || (sizing.kind === "all_position" && flow.from === "wallet")) {
      if (flow.from !== "wallet") {
        throw new Reject(name, flow.from === "account"
          ? `${verbOf(leg.op)} spends the margin account — deposit the idle tokens as collateral first`
          : `an idle wallet balance does not size a ${verbOf(leg.op).toLowerCase()}`);
      }
      /**
       * What the wallet can still fund, not what it held before this plan started: two legs
       * that both draw on the idle balance may not each take all of it. Legs that LAND in
       * the wallet (a redeem, a withdraw) add to it in the same pass.
       */
      const idle = walletAfterEarlierLegs(holdings[leg.asset as keyof typeof holdings], drafts, leg.asset);
      const held = idle.tokens === null ? null : { tokens: idle.tokens, usd: formatWad(mulDown(decimalWad(idle.tokens), price.price, WAD)) };
      if (idle.spent && (!held || decimalWad(held.tokens) <= ZERO)) {
        throw new Reject(name, `the legs before this one already use all ${idle.startedWith ?? "0"} ${leg.asset} the wallet can spend`);
      }
      /**
       * A deposit that exists to fund a repay ("repay from what I have") is capped by what
       * is owed, and when the wallet holds none of the asset the refusal says what is owed —
       * 13 Sep, "I want zero debt but keep all my collateral": the sizer's answer was "an
       * idle wallet balance does not size a repay", and the debt never appeared.
       */
      const owed = leg.fundsRepay ? positionRowBalance(ctx.observations, "account_debt", ["debt", "borrows", "positions"], def.marginSymbol!, def.id, ctx.now) : null;
      if (leg.fundsRepay) {
        if (owed === null) throw new Reject(name, `no ${leg.asset} debt was read this investigation`);
        if (decimalWad(owed) <= ZERO) throw new Reject(name, `you owe no ${leg.asset}`);
      }
      if (!held || decimalWad(held.tokens) <= ZERO) {
        if (leg.fundsRepay && owed !== null) {
          const owedTokens = precise(owed, leg.asset, name);
          const owedUsd = Number(formatWad(mulDown(decimalWad(owedTokens), price.price, WAD))).toFixed(2);
          throw new Reject(name, `you owe ${owedTokens} ${leg.asset} (~$${owedUsd}) and the wallet holds no spendable ${leg.asset} — add ${owedTokens} ${leg.asset} to the wallet, or redeem it from Earn first`);
        }
        throw new Reject(name, noIdleReason(leg.asset, dust, txFloor, ctx));
      }
      if (leg.fundsRepay && owed !== null) {
        const stillOwed = pocketBalance("debt", decimalWad(owed), drafts, leg.asset);
        if (stillOwed.available <= ZERO) throw new Reject(name, `the legs before this one already repay the whole ${owed} ${leg.asset} debt`);
        const remainingDebtTokens = formatWad(stillOwed.available);
        const target = precise(leg.repayShare ? shareOf(remainingDebtTokens, anchoredShare(leg.repayShare, ctx.messages, name)) : remainingDebtTokens, leg.asset, name);
        const tokens = decimalWad(held.tokens) < decimalWad(target) ? held.tokens : target;
        const usd = formatWad(mulDown(decimalWad(tokens), price.price, WAD));
        drafts.push({ leg, name, usd, tokens, produces: tokens, heldTokens: held.tokens });
        continue;
      }
      drafts.push({ leg, name, usd: held.usd, tokens: held.tokens, produces: held.tokens, heldTokens: held.tokens });
      continue;
    }
    if (sizing.kind === "all_position") {
      /**
       * The whole of what the op draws on, from the read that holds it: vTokens in Earn for
       * a redeem (the tool takes vTokens; the underlying comes back), the posted balance
       * for a withdraw, the outstanding balance for a repay.
       */
      if (flow.positionRead === "earn_position") {
        const position = earnPositionOf(ctx.observations, leg.asset, ctx.now);
        if (!position) throw new Reject(name, `no ${leg.asset} position in Earn was read this investigation`);
        if (decimalWad(position.vtokens) <= ZERO) throw new Reject(name, `you hold no ${leg.asset} in Earn`);
        const left = pocketBalance("earn", decimalWad(position.vtokens), drafts, leg.asset);
        if (left.available <= ZERO) throw new Reject(name, `the legs before this one already redeem the whole ${position.vtokens} ${leg.asset} position in Earn`);
        // A partial position redeems its underlying pro rata, at the position's own rate.
        const share = (left.available * WAD) / decimalWad(position.vtokens);
        const vtokens = precise(formatWad(left.available), position.vtokenSymbol ?? leg.asset, name);
        const underlying = precise(formatWad(mulDown(decimalWad(position.underlying), share, WAD)), leg.asset, name);
        const usd = formatWad(mulDown(decimalWad(underlying), price.price, WAD));
        drafts.push({ leg, name, usd, tokens: vtokens, produces: underlying, heldTokens: underlying });
        continue;
      }
      if (flow.positionRead === "farm_lp_position") {
        const raw = farmLpPositionOf(ctx.observations, leg.asset, ctx.now);
        if (raw === null) throw new Reject(name, `no ${leg.asset} LP position was read this investigation`);
        if (decimalWad(raw) <= ZERO) throw new Reject(name, `you hold no ${leg.asset} LP shares`);
        const left = pocketBalance("lp", decimalWad(raw), drafts, leg.asset);
        if (left.available <= ZERO) throw new Reject(name, `the legs before this one already remove the whole ${raw} ${leg.asset} LP position`);
        const shares = precise(formatWad(left.available), leg.asset, name);
        /**
         * Removing liquidity pays back BOTH pool tokens, not one — there is no single
         * figure to credit the account with, so `produces` is left unknown, exactly as a
         * swap's unknown fill is. A later leg spending what came out states its own amount.
         * `usd` is "0", not a guess: the shares' worth is not one token's oracle price
         * times their count, and the leg carries no rate, so nothing downstream reads it
         * as a real figure — it exists only so the economics pass has a decimal to parse.
         */
        drafts.push({ leg, name, usd: "0", tokens: shares, produces: null, heldTokens: null });
        continue;
      }
      if (flow.positionRead === null) throw new Reject(name, `all_position applies to ${positionOps()}`);
      const raw = positionRowBalance(ctx.observations, flow.positionRead, POSITION_ROWS[flow.positionRead as keyof typeof POSITION_ROWS], def.marginSymbol!, def.id, ctx.now);
      const holds = flow.positionRead === "account_debt" ? "debt"
        : flow.positionRead === "blend_position" ? "Blend supply" : "posted collateral";
      if (raw === null) throw new Reject(name, `no ${leg.asset} ${holds} was read this investigation`);
      if (decimalWad(raw) <= ZERO) {
        throw new Reject(name, flow.positionRead === "account_debt" ? `you owe no ${leg.asset}`
          : flow.positionRead === "blend_position" ? `you have no ${leg.asset} supplied to Blend`
            : `no ${leg.asset} is posted as collateral`);
      }
      const pocket = flow.positionRead === "account_debt" ? "debt"
        : flow.positionRead === "blend_position" ? "blend" : "account";
      const left = pocketBalance(pocket, decimalWad(raw), drafts, leg.asset);
      if (left.unsized) throw new Reject(name, `${verbOf(leg.op)} after a borrow sized to the floor takes what the borrow yields — size it as previous_leg`);
      if (left.available <= ZERO) {
        throw new Reject(name, pocket === "debt"
          ? `the legs before this one already repay the whole ${raw} ${leg.asset} debt`
          : pocket === "blend"
            ? `the legs before this one already withdraw the whole ${raw} ${leg.asset} Blend supply`
            : `the legs before this one already use all ${raw} ${leg.asset} in the margin account`);
      }
      const balance = precise(formatWad(left.available), leg.asset, name);
      const usd = formatWad(mulDown(decimalWad(balance), price.price, WAD));
      drafts.push({ leg, name, usd, tokens: balance, produces: leg.op === "swap" ? null : balance, heldTokens: null });
      continue;
    }
    if (sizing.kind === "to_floor") {
      // The floor caps what lowers health: a borrow (from capacity) or a withdraw (from what is posted).
      if (flow.health !== "lowers") throw new Reject(name, `only ${listOps(WORKFLOW_OPS.filter((op) => OP_FLOW[op].health === "lowers"))} can be sized to the health-factor floor`);
      if (flow.from === "debt") {
        drafts.push({ leg, name, usd: "max", tokens: null, produces: null, heldTokens: null });
        continue;
      }
      const posted = positionRowBalance(ctx.observations, "account_collateral", POSITION_ROWS.account_collateral, def.marginSymbol!, def.id, ctx.now);
      if (posted === null) throw new Reject(name, `no ${leg.asset} posted collateral was read this investigation`);
      if (decimalWad(posted) <= ZERO) throw new Reject(name, `no ${leg.asset} is posted as collateral`);
      const stillPosted = pocketBalance("account", decimalWad(posted), drafts, leg.asset);
      if (stillPosted.unsized) throw new Reject(name, `${verbOf(leg.op)} after a borrow sized to the floor takes what the borrow yields — size it as previous_leg`);
      if (stillPosted.available <= ZERO) throw new Reject(name, `the legs before this one already use all ${posted} ${leg.asset} in the margin account`);
      const capUsd = formatWad(mulDown(stillPosted.available, price.price, WAD));
      /**
       * "How much can I withdraw?" with no floor stated: the liquidation line is the only
       * stop the chain enforces, so the figure AT the line is named — and the floor they
       * want kept is asked for, never invented (14 Sep: the question was answered with a
       * question, "what specific amount would you like to verify?").
       */
      if (ctx.capacity && ctx.capacity.floor === null) {
        const room = maxWithdrawForFloorWad(decimalWad(ctx.capacity.grossCollateralUsd), decimalWad(ctx.capacity.debtUsd), LIQUIDATION_THRESHOLD_WAD);
        const atLine = room < decimalWad(capUsd) ? room : decimalWad(capUsd);
        const tokens = tokensFromUsd(formatWad(atLine), price.price, decimals.get(leg.asset) ?? 7);
        throw new Reject(name, `a withdraw sized to the floor needs the health-factor floor you want kept, above the 1.1 liquidation line — tell me the number; at the line itself up to ${tokens.ok ? tokens.tokens : "0"} ${leg.asset} of the ${precise(posted, leg.asset, name)} posted could come out`);
      }
      drafts.push({ leg, name, usd: "max", capUsd, tokens: null, produces: null, heldTokens: null });
      continue;
    }
    if (sizing.kind === "previous_leg") {
      const prev = drafts[index - 1];
      if (!prev || prev.leg.asset !== leg.asset) throw new Reject(name, "previous_leg needs a preceding leg in the same asset");
      // What the previous leg leaves behind must be what this one spends (the op-flow table).
      if (prev.leg.op === "swap") throw new Reject(name, "a swap fills at the pool's price, so how much it buys is not known in advance — state the next leg's amount yourself");
      if (prev.leg.op === "remove_liquidity") throw new Reject(name, "removing liquidity pays back two tokens, not one, so how much of either is not known in advance — state the next leg's amount yourself");
      if (!feeds(prev.leg.op, leg.op)) throw new Reject(name, handoffReason(prev.leg.op, leg.op));
      drafts.push({ leg, name, usd: { previous: index - 1 }, tokens: prev.produces, produces: prev.produces, heldTokens: null });
      continue;
    }
    /**
     * A leverage multiple is not a token handoff like `previous_leg` — the deposit stays in
     * the account as collateral, and the borrow is NEW money the multiple sizes, in
     * whichever asset the leg names (not necessarily the deposited one: "deposit 10 XLM,
     * borrow AQUSDC at 6x" is valid). So this reads the preceding leg's USD value, not its
     * tokens, and prices the borrow in the BORROWED asset — the industry-standard split
     * (`splitLeverageAmounts` elsewhere in this codebase): borrow = equity × (multiple − 1).
     *
     * The op-flow table decides what may be leveraged, not a named op: the leg before it
     * must be the thing that ADDS collateral (`to: "account"`, `health: "raises"` —
     * today only `deposit_collateral`, derived rather than named so a future op with the
     * same shape needs no change here).
     *
     * A floor stated in the same message is not sized against here at all — it is the
     * existing floor-projection every borrow already goes through (below, via SIZED_OPS),
     * which refuses this exact fixed amount with the figures if it breaches. 15 Sep, live:
     * "borrow with 6x leverage … HF > 1.19" had no sizing word for "6x", so the model
     * substituted `to_floor` — a different amount — and never said the 6x was dropped.
     */
    if (sizing.kind === "leverage") {
      /**
       * Leverage only means something for a borrow — "borrow rate" (`earn_borrow`) is
       * the one op-flow property unique to it, so this is derived from the table rather
       * than naming the op: a future op shaped like borrow needs no change here, and
       * leverage sizing on anything else (the shape matrix tries every op × sizing
       * combination) refuses cleanly instead of computing a number that means nothing.
       */
      if (flow.rate !== "earn_borrow") throw new Reject(name, `a leverage multiple only sizes a borrow — ${verbOf(leg.op).toLowerCase()} needs a literal amount or a share instead`);
      const prev = drafts[index - 1];
      const prevFlow = prev ? OP_FLOW[prev.leg.op] : null;
      if (!prev || prevFlow!.to !== "account" || prevFlow!.health !== "raises") {
        throw new Reject(name, "a leverage multiple needs the deposit that funds it stated immediately before the borrow");
      }
      if (typeof prev.usd !== "string") {
        throw new Reject(name, `${verbOf(leg.op)} at a leverage multiple needs the deposit before it to have a known amount already`);
      }
      const equityUsd = decimalWad(prev.usd);
      const multiple = anchoredMultiple(sizing, ctx.messages, name);
      const borrowUsd = formatWad(mulDown(equityUsd, multiple - WAD, WAD));
      const converted = tokensFromUsd(borrowUsd, price.price, decimals.get(leg.asset) ?? 7);
      if (!converted.ok) throw new Reject(name, `${sizing.multiple}x leverage on ${prev.leg.asset} sizes to nothing in ${leg.asset} at this precision`);
      const tokens = precise(converted.tokens, leg.asset, name);
      const usd = formatWad(mulDown(decimalWad(tokens), price.price, WAD));
      drafts.push({ leg, name, usd, tokens, produces: tokens, heldTokens: null });
      continue;
    }
    if (sizing.kind === "fraction") {
      const share = anchoredShare(sizing, ctx.messages, name);
      if (sizing.of === "idle") {
        if (flow.from !== "wallet") throw new Reject(name, `a share of the wallet balance sizes ${walletOps()}`);
        const held = holdings[leg.asset as keyof typeof holdings];
        if (!held || decimalWad(held.tokens) <= ZERO) throw new Reject(name, `no idle ${leg.asset} in the wallet`);
        const tokens = precise(shareOf(held.tokens, share), leg.asset, name);
        if (decimalWad(tokens) <= ZERO) throw new Reject(name, `${sizing.percent}% of ${held.tokens} ${leg.asset} rounds to nothing`);
        const usd = formatWad(mulDown(decimalWad(tokens), price.price, WAD));
        drafts.push({ leg, name, usd, tokens, produces: tokens, heldTokens: held.tokens });
        continue;
      }
      // of: position — a share of what the op spends. (A repay share was expanded into deposit → repay above.)
      if (flow.positionRead === "earn_position") {
        const position = earnPositionOf(ctx.observations, leg.asset, ctx.now);
        if (!position || decimalWad(position.underlying) <= ZERO) throw new Reject(name, `no ${leg.asset} position in Earn was read this investigation`);
        const left = pocketBalance("earn", decimalWad(position.vtokens), drafts, leg.asset);
        if (left.available <= ZERO) throw new Reject(name, `the legs before this one already redeem the whole ${position.vtokens} ${leg.asset} position in Earn`);
        const remaining = (left.available * WAD) / decimalWad(position.vtokens);
        const vtokens = precise(shareOf(formatWad(left.available), share), position.vtokenSymbol ?? leg.asset, name);
        const underlying = precise(shareOf(formatWad(mulDown(decimalWad(position.underlying), remaining, WAD)), share), leg.asset, name);
        const usd = formatWad(mulDown(decimalWad(underlying), price.price, WAD));
        drafts.push({ leg, name, usd, tokens: vtokens, produces: underlying, heldTokens: underlying });
        continue;
      }
      if (flow.positionRead !== "account_collateral") throw new Reject(name, `a share of the position sizes ${positionOps()}`);
      const posted = positionRowBalance(ctx.observations, flow.positionRead, POSITION_ROWS[flow.positionRead], def.marginSymbol!, def.id, ctx.now);
      if (posted === null) throw new Reject(name, `no ${leg.asset} posted collateral was read this investigation`);
      if (decimalWad(posted) <= ZERO) throw new Reject(name, `no ${leg.asset} is posted as collateral`);
      const stillPosted = pocketBalance("account", decimalWad(posted), drafts, leg.asset);
      if (stillPosted.unsized) throw new Reject(name, `${verbOf(leg.op)} after a borrow sized to the floor takes what the borrow yields — size it as previous_leg`);
      if (stillPosted.available <= ZERO) throw new Reject(name, `the legs before this one already use all ${posted} ${leg.asset} in the margin account`);
      const tokens = precise(shareOf(formatWad(stillPosted.available), share), leg.asset, name);
      const usd = formatWad(mulDown(decimalWad(tokens), price.price, WAD));
      drafts.push({ leg, name, usd, tokens, produces: tokens, heldTokens: null });
      continue;
    }
    /**
     * Exact-output on Aquarius — "swap XLM to receive 961.4183674 AQUSDC" — solves the
     * pool's own constant-product formula backwards: not "what does amountIn buy" but
     * "what amountIn does this exact output cost", at the pool's live reserves and fee.
     * The gate above already required both the venue and the reserves read, so a leg
     * reaching here always has both; `bought` is non-null for the same reason.
     *
     * `sizing.amountAsset === "assetOut"` is the model's own structural statement that
     * `amount` is the RECEIVED figure, not the spent one — set directly from its own
     * understanding of the request, not re-derived by matching sourceQuote against a fixed
     * list of phrasings. A model that correctly understands "give me 15 SOUSDC" as a
     * receive-amount, in words a hardcoded regex did not enumerate, used to fall straight
     * through to the ordinary spend-amount path below and silently swap the wrong side (16
     * Sep, live).
     *
     * `tokens` becomes the computed INPUT, same as any other sizing kind — everything
     * downstream (funding checks, the step's amount_in, Pass 3's own floor, even the price-
     * impact guard) treats it exactly like a stated input amount, because that is what it
     * now is. `produces` stays null, same as an ordinary swap: a swap fills at the pool's
     * price, not a number decided in advance.
     */
    if (leg.op === "swap" && bought && sizing.kind === "literal" && sizing.amountAsset === "assetOut") {
      const stated = tokenAmountsIn(sizing.sourceQuote);
      const quoted = ctx.messages.some((m) => m.includes(sizing.sourceQuote)) && stated.some((n) => sameAmount(n, sizing.amount));
      if (!quoted) throw new Reject(name, `the amount ${sizing.amount} does not appear in your request`);
      const reserves = poolReservesOf(ctx.observations, def.id === "XLM" ? bought.id : def.id, poolVenueFor(def.id, bought.id) ?? "aquarius", ctx.now)!;
      const { inWad: reserveInWad, outWad: reserveOutWad, feeWad } = reservesForDirection(reserves, def.id === "XLM");
      const desiredOutWad = decimalWad(sizing.amount);
      if (decimalWad(precise(sizing.amount, bought.id, name)) !== desiredOutWad) {
        throw new Reject(name, `${bought.id} cannot represent the requested output at its on-chain precision`);
      }
      if (desiredOutWad >= reserveOutWad) {
        throw new Reject(name, `the pool holds only ${formatWad(reserveOutWad)} ${bought.id} — ${sizing.amount} cannot be filled from it`);
      }
      // The input buys a small buffer; the enforced floor remains the user's exact target.
      const bufferedOutWad = (desiredOutWad * BigInt(10_000) + BigInt(10_000) - SWAP_SLIPPAGE_BPS - BigInt(1))
        / (BigInt(10_000) - SWAP_SLIPPAGE_BPS);
      const amountInWad = exactOutputIn(bufferedOutWad, reserveInWad, reserveOutWad, feeWad);
      if (amountInWad === null) throw new Reject(name, `${sizing.amount} ${bought.id} cannot be sized from this pool's reserves`);
      const places = decimals.get(leg.asset)!;
      const quantum = BigInt(10) ** BigInt(18 - places);
      let roundedInWad = ((amountInWad + quantum - BigInt(1)) / quantum) * quantum;
      while ((constantProductOut(roundedInWad, reserveInWad, reserveOutWad, feeWad) ?? ZERO) < bufferedOutWad) {
        roundedInWad += quantum;
      }
      const tokens = formatWad(roundedInWad);
      const amountWad = decimalWad(tokens);
      // The same funding check every stated amount gets — swap always spends the account.
      const earlier = drafts.slice(0, index).filter((d) => d.leg.asset === leg.asset);
      const posted = positionRowBalance(ctx.observations, "account_collateral", POSITION_ROWS.account_collateral, def.marginSymbol!, def.id, ctx.now);
      const { available } = pocketBalance("account", posted === null ? ZERO : decimalWad(posted), drafts, leg.asset);
      if (available < amountWad) {
        throw new Reject(name, posted === null && !earlier.length
          ? `${verbOf(leg.op)} takes what a deposit or borrow put in the account — add that leg before it`
          : `only ${formatWad(available)} ${leg.asset} is in the margin account${earlier.length ? " after the legs before it" : ""} — receiving ${sizing.amount} ${bought.id} needs about ${tokens}`);
      }
      const usd = formatWad(mulDown(amountWad, price.price, WAD));
      drafts.push({ leg, name, usd, tokens, produces: null, heldTokens: null, targetOut: sizing.amount });
      continue;
    }
    // literal — anchored to the user's own words, exactly as goal.actions requires.
    const stated = tokenAmountsIn(sizing.sourceQuote);
    const quoted = ctx.messages.some((m) => m.includes(sizing.sourceQuote)) && stated.some((n) => sameAmount(n, sizing.amount));
    if (!quoted) throw new Reject(name, `the amount ${sizing.amount} does not appear in your request`);
    /**
     * A stated amount is funded from the pocket the op-flow table names, after the legs
     * before it have run: the wallet's spendable balance for a lend or deposit; the account's
     * balance plus what earlier legs put in for a withdraw, repay or Blend supply — the user
     * who says "deposit 10000 XLM and deploy it in the Blend farm" has named 10000 for both
     * legs (13 Sep); the debt for a repay. 14 Sep, the shape matrix: "lend 100 XLM" was
     * offered from an empty wallet — nothing had ever checked a literal against a balance.
     */
    const amountWad = decimalWad(sizing.amount);
    const earlier = drafts.slice(0, index).filter((d) => d.leg.asset === leg.asset);
    if (flow.from === "wallet") {
      const idle = walletAfterEarlierLegs(holdings[leg.asset as keyof typeof holdings], drafts, leg.asset);
      if (idle.tokens === null) throw new Reject(name, noIdleReason(leg.asset, dust, txFloor, ctx));
      const available = decimalWad(idle.tokens);
      if (available < amountWad) throw new Reject(name, `only ${formatWad(available)} ${leg.asset} is spendable in the wallet${earlier.length ? " after the legs before it" : ""}`);
    }
    if (flow.from === "account") {
      const posted = positionRowBalance(ctx.observations, "account_collateral", POSITION_ROWS.account_collateral, def.marginSymbol!, def.id, ctx.now);
      const { available, unsized } = pocketBalance("account", posted === null ? ZERO : decimalWad(posted), drafts, leg.asset);
      if (unsized) throw new Reject(name, `${verbOf(leg.op)} after a borrow sized to the floor takes what the borrow yields — size it as previous_leg`);
      if (available < amountWad) {
        throw new Reject(name, posted === null && !earlier.length
          ? `${verbOf(leg.op)} takes what a deposit or borrow put in the account — add that leg before it`
          : `only ${formatWad(available)} ${leg.asset} is in the margin account${earlier.length ? " after the legs before it" : ""}`);
      }
    }
    if (flow.from === "blend") {
      const supplied = positionRowBalance(ctx.observations, "blend_position", POSITION_ROWS.blend_position, def.marginSymbol!, def.id, ctx.now);
      if (supplied === null) throw new Reject(name, `no ${leg.asset} Blend supply was read this investigation`);
      const { available } = pocketBalance("blend", decimalWad(supplied), drafts, leg.asset);
      if (available < amountWad) {
        throw new Reject(name, available <= ZERO
          ? `you have no ${leg.asset} supplied to Blend`
          : `only ${formatWad(available)} ${leg.asset} is supplied to Blend${earlier.length ? " after the legs before it" : ""}`);
      }
    }
    if (flow.from === "lp") {
      const held = farmLpPositionOf(ctx.observations, leg.asset, ctx.now);
      if (held === null) throw new Reject(name, `no ${leg.asset} LP position was read this investigation`);
      const { available } = pocketBalance("lp", decimalWad(held), drafts, leg.asset);
      if (available < amountWad) {
        throw new Reject(name, available <= ZERO
          ? `you hold no ${leg.asset} LP shares`
          : `only ${formatWad(available)} ${leg.asset} LP shares are held${earlier.length ? " after the legs before it" : ""}`);
      }
    }
    if (flow.to === "debt" || leg.fundsRepay) {
      const owed = positionRowBalance(ctx.observations, "account_debt", POSITION_ROWS.account_debt, def.marginSymbol!, def.id, ctx.now);
      if (owed === null) throw new Reject(name, `no ${leg.asset} debt was read this investigation`);
      if (decimalWad(owed) <= ZERO) throw new Reject(name, `you owe no ${leg.asset}`);
      const { available } = pocketBalance("debt", decimalWad(owed), drafts, leg.asset);
      if (available < amountWad) {
        throw new Reject(name, available <= ZERO
          ? `the legs before this one already repay the whole ${owed} ${leg.asset} debt`
          : `you owe only ${precise(formatWad(available), leg.asset, name)} ${leg.asset}${earlier.length ? " after the legs before it" : ""}`);
      }
    }
    if (flow.positionRead === "earn_position") {
      // The user names the underlying; the tool takes vTokens, converted at the position's own rate.
      const position = earnPositionOf(ctx.observations, leg.asset, ctx.now);
      if (!position || decimalWad(position.underlying) <= ZERO) throw new Reject(name, `no ${leg.asset} position in Earn was read this investigation`);
      const left = pocketBalance("earn", decimalWad(position.vtokens), drafts, leg.asset);
      if (left.available <= ZERO) throw new Reject(name, `the legs before this one already redeem the whole ${position.vtokens} ${leg.asset} position in Earn`);
      const redeemable = mulDown(decimalWad(position.underlying), (left.available * WAD) / decimalWad(position.vtokens), WAD);
      const underlying = decimalWad(sizing.amount);
      if (underlying > redeemable) throw new Reject(name, `only ${formatWad(redeemable)} ${leg.asset} is redeemable from Earn${earlier.length ? " after the legs before it" : ""}`);
      const vtokens = precise(formatWad((underlying * decimalWad(position.vtokens)) / decimalWad(position.underlying)), position.vtokenSymbol ?? leg.asset, name);
      const usd = formatWad(mulDown(underlying, price.price, WAD));
      drafts.push({ leg, name, usd, tokens: vtokens, produces: sizing.amount, heldTokens: null });
      continue;
    }
    const tokens = sizing.amount;
    const usd = formatWad(mulDown(decimalWad(tokens), price.price, WAD));
    drafts.push({ leg, name, usd, tokens, produces: tokens, heldTokens: null });
  }

  /**
   * Pass 2 — project the margin account through every account-touching leg, in order,
   * with the user's floor as a stop condition on each intermediate state. Wallet-only
   * Earn lending and the HF-neutral Blend supply are not sizer legs.
   */
  // A reference to a leg already sized (a redeem's underlying feeding a deposit) resolves now;
  // only a reference to a floor-sized borrow stays symbolic until the sizer has spoken.
  for (const draft of drafts) {
    if (typeof draft.usd === "object" && typeof drafts[draft.usd.previous].usd === "string" && drafts[draft.usd.previous].usd !== "max") {
      const prev = drafts[draft.usd.previous];
      draft.usd = prev.usd as string;
      draft.tokens = prev.produces;
      draft.produces = prev.produces;
    }
  }
  const marginDrafts = drafts.filter((d) => (SIZED_OPS as readonly string[]).includes(d.leg.op));
  let sized: SizedLeg[] = [];
  let finalHealthFactor: string | null = null;
  if (marginDrafts.length) {
    const capacity = ctx.capacity!;
    const requests: LegRequest[] = marginDrafts.map((d) => ({
      op: d.leg.op as SizedOp, label: d.name,
      amountUsd: d.usd === "max" ? "max" : typeof d.usd === "string" ? d.usd : "0",
      ...(d.capUsd !== undefined ? { capUsd: d.capUsd } : {}),
    }));
    /**
     * The floor is a stop condition for legs that can LOWER health. A sequence of deposits
     * and repays only raises it, so it is sized against the contract's line alone — an
     * account already under its floor can still deposit its way back above it (the PR #58
     * defect: repay and deposit were blocked exactly when they were needed).
     */
    const canLowerHealth = marginDrafts.some((d) => OP_FLOW[d.leg.op].health === "lowers");
    const result = sizeLegs({ grossCollateralUsd: capacity.grossCollateralUsd, debtUsd: capacity.debtUsd }, requests, canLowerHealth ? capacity.floor : null);
    if (!result.ok) {
      const reason = SIZER_REASONS[result.reason] ?? result.reason.replaceAll("_", " ");
      const advice = canLowerHealth && capacity.floor ? shortfallAdvice(capacity, result, holdings, prices) : null;
      throw new Reject(result.failingLeg, advice ? `${reason}; ${advice}` : reason);
    }
    sized = result.legs;
    finalHealthFactor = result.finalHealthFactor;
    // Fill in the sizer's answers where the draft only had a reference.
    marginDrafts.forEach((draft, i) => {
      if (draft.usd === "max") {
        draft.usd = sized[i].amountUsd;
        const tokens = tokensFromUsd(sized[i].amountUsd, prices.get(draft.leg.asset)!, decimals.get(draft.leg.asset) ?? 6);
        if (decimals.get(draft.leg.asset) === undefined) throw new Reject(draft.name, `the on-chain precision of ${draft.leg.asset} was not read this investigation`);
        if (!tokens.ok) throw new Reject(draft.name, "the sized amount rounds to nothing in token units");
        draft.tokens = tokens.tokens;
        draft.produces = tokens.tokens;
      }
    });
  }
  for (const draft of drafts) {
    if (typeof draft.usd === "object") {
      const prev = drafts[draft.usd.previous];
      draft.usd = prev.usd as string;
      draft.tokens = prev.produces;
      draft.produces = prev.produces;
    }
    if (!draft.tokens) throw new Reject(draft.name, "the amount could not be resolved");
  }

  /** Pass 3 — steps, then the allowlist. */
  const steps: ProposalStep[] = drafts.map((d, index) => {
    const def = resolveAssetDef(d.leg.asset)!;
    const venue = OP_FLOW[d.leg.op].venue;
    const symbol = venue === "earn" ? def.earnSymbol! : venue === "blend" ? (def.marginSymbol ?? def.id) : wireSymbol(d.leg.asset);
    const out = d.leg.op === "swap" ? resolveAssetDef(d.leg.assetOut ?? "") : null;
    const paired = d.leg.op === "add_liquidity" ? resolveAssetDef(d.leg.assetOut ?? "") : null;
    const dex = out ? poolVenueFor(def.id, out.id) : d.leg.op === "remove_liquidity" ? def.lpVenue : paired ? poolVenueFor(def.id, paired.id) : null;
    /**
     * The floor this swap is told to accept, from the prices already read this
     * investigation — the gate above already required both to be `.ok`, so this repeats
     * a check that has already passed rather than trusting that silently.
     */
    /**
     * The floor this swap is told to accept. Quoted against the POOL when its live reserves
     * were read — the curve it actually settles on, after its own fee — and only otherwise
     * against the oracle, which assumes a parity fill the pool never promised. 15 Sep, live:
     * the oracle-parity floor was refused outright by the DEX (HostError #2006) on a swap
     * that filled fine when quoted against the pool itself.
     */
    const minOut = out ? (() => {
      const places = decimals.get(out.id) ?? 7;
      const floorOf = (expectedWad: bigint) => truncateToDecimals(formatWad(slippageFloor(expectedWad)), places);
      const reserves = dex === "aquarius"
        ? aquariusReservesOf(ctx.observations, def.id === "XLM" ? out.id : def.id, ctx.now) : null;
      if (dex === "aquarius" && !reserves) {
        throw new Reject(d.name, "the Aquarius pool's live on-chain reserves were unavailable; the swap cannot be quoted safely");
      }
      if (reserves) {
        const { inWad, outWad, feeWad } = reservesForDirection(reserves, def.id === "XLM");
        const quoted = constantProductOut(decimalWad(d.tokens!), inWad, outWad, feeWad);
        if (quoted !== null && quoted > ZERO) {
          /**
           * A pool-quoted floor is always meetable by construction — which is exactly why
           * it cannot be the only check. On a pool too thin for the size, the honest floor
           * authorises an honestly terrible fill: 15 Sep the protocol's own Aquarius pool
           * quoted 1,000 XLM (~$190) at ~11.7 AQUSDC, a 94% loss, and the site's own swap
           * card refuses that outright. So the quote is valued against the oracle and
           * refused past the same threshold the website blocks on.
           */
          const spent = priceFor(def.id, ctx.observations, ctx.now);
          const bought = priceFor(out.id, ctx.observations, ctx.now);
          if (spent.ok && bought.ok) {
            const inUsdWad = mulDown(decimalWad(d.tokens!), spent.price, WAD);
            const impact = priceImpactWad(inUsdWad, mulDown(quoted, bought.price, WAD));
            if (impact !== null && impact * BigInt(100) > WAD * BigInt(MAX_PRICE_IMPACT_PCT)) {
              const lost = (Number(formatWad(impact)) * 100).toFixed(2);
              throw new Reject(d.name, `this pool is too thin for ${d.tokens} ${def.id}: it would fill at about `
                + `${truncateToDecimals(formatWad(quoted), places)} ${out.id}, ${lost}% below what ${def.id} is worth. `
                + `Swap a smaller amount, or use ${swappableWith(def.id).filter((id) => id !== out.id).join(" or ") || "another pool"}`);
            }
          }
          if (d.targetOut) {
            if (quoted < decimalWad(d.targetOut)) throw new Reject(d.name, `the pool cannot currently pay ${d.targetOut} ${out.id} for the sized input`);
            return d.targetOut;
          }
          return floorOf(quoted);
        }
      }
      const spentPrice = priceFor(def.id, ctx.observations, ctx.now);
      const outPrice = priceFor(out.id, ctx.observations, ctx.now);
      if (!spentPrice.ok || !outPrice.ok) throw new Reject(d.name, `no ${!spentPrice.ok ? def.id : out.id} price was read this investigation`);
      const usdValue = formatWad(mulDown(decimalWad(d.tokens!), spentPrice.price, WAD));
      const expected = tokensFromUsd(usdValue, outPrice.price, places);
      if (!expected.ok) throw new Reject(d.name, "the swap's expected output could not be sized from the reads that completed");
      return floorOf(decimalWad(expected.tokens));
    })() : null;
    /**
     * The paired amount and the LP-share floor, both from the pool's own live reserves —
     * never the model's number, and never oracle prices standing in for the pool's actual
     * ratio. Proportional to the stated side: derivedAmount = stated x reserveDerived /
     * reserveStated, and — because the deposit is exactly proportional — the LP shares
     * minted for it are exactly stated x totalShare / reserveStated too, the same formula
     * a constant-product pool itself mints by (no oracle needed for either number).
     */
    const addLiquidity = paired && dex === "aquarius" ? (() => {
      const reserves = aquariusReservesOf(ctx.observations, def.id === "XLM" ? paired.id : def.id, ctx.now);
      if (!reserves) throw new Reject(d.name, "no live aquarius pool reserves were read this investigation");
      const statedIsXlm = def.id === "XLM";
      const reserveStatedWad = decimalWad(statedIsXlm ? reserves.xlm : reserves.paired);
      const reserveDerivedWad = decimalWad(statedIsXlm ? reserves.paired : reserves.xlm);
      if (reserveStatedWad <= ZERO) throw new Reject(d.name, `the pool's ${def.id} reserve read as zero, so a proportional deposit cannot be sized`);
      const statedWad = decimalWad(d.tokens!);
      const derivedTokens = precise(formatWad(mulDown(statedWad, reserveDerivedWad, reserveStatedWad)), paired.id, d.name);
      const totalShareWad = decimalWad(reserves.totalShare);
      const expectedSharesWad = mulDown(statedWad, totalShareWad, reserveStatedWad);
      return { amountB: derivedTokens, minLiquidityOut: truncateToDecimals(formatWad(slippageFloor(expectedSharesWad)), 7) };
    })() : null;
    const label = d.leg.op === "redeem"
      ? `Redeem ${d.tokens} ${def.id} vTokens from Earn (≈ ${d.produces} ${def.displayLabel ?? def.id})`
      : d.leg.op === "swap" && out
        ? `Swap ${d.tokens} ${def.displayLabel ?? def.id} for at least ${minOut} ${out.displayLabel ?? out.id} on ${venueLabel(dex!)}`
        : d.leg.op === "remove_liquidity"
          ? `Remove ${d.tokens} XLM/${def.displayLabel ?? def.id} LP shares on ${venueLabel(dex!)}`
          : d.leg.op === "add_liquidity" && paired && addLiquidity
            ? `Add ${d.tokens} ${def.displayLabel ?? def.id} + ${addLiquidity.amountB} ${paired.displayLabel ?? paired.id} to the ${venueLabel(dex!)} pool`
            : `${verbOf(d.leg.op)} ${d.tokens} ${def.displayLabel ?? def.id}${WHERE[d.leg.op]}`;
    const step: ProposalStep = {
      id: `s${index}-${d.leg.op}`,
      op: d.leg.op,
      asset: def.id,
      amount: d.tokens!,
      label,
      tool: TOOLS[d.leg.op],
      args: writeArgsFor(d.leg.op, symbol, d.tokens!, ctx.scope,
        out && dex ? { tokenOut: out.marginSymbol ?? out.id, venue: dex, minOut: minOut ?? undefined }
          : d.leg.op === "remove_liquidity" && dex ? { venue: dex }
          : paired && dex && addLiquidity ? { tokenOut: paired.marginSymbol ?? paired.id, venue: dex, amountB: addLiquidity.amountB, minOut: addLiquidity.minLiquidityOut }
          : undefined),
      ...(d.targetOut ? { targetOut: d.targetOut } : {}),
      // Token units are frozen at approval; a USD resize cannot be substituted into token-denominated arguments.
      sizing: { basis: "stated" },
    };
    try { allowedInvocation(step, ctx.scope); } catch { throw new Reject(d.name, "this step is not an allowed protocol write"); }
    return step;
  });

  /**
   * Economics, from the same comparison rows the fixed shapes use. Expected return is
   * Σ supplied × supply APR − Σ borrowed × borrow APR; the net APR is that over the
   * amount deployed, so a plan that borrows to supply is judged on its carry, not its
   * headline rate.
   */
  let supplied = ZERO, returnWad = ZERO, borrowed = ZERO;
  /**
   * A supply leg's rate is the label on the option, not an input to its size. A leg whose
   * rate was not read (or failed the cross-check) is still sized and offered; the card says
   * the rate is unknown. Only a plan that BORROWS needs every supply rate — its carry cannot
   * be judged without them. 14 Sep: "lend 25% of xlm" was refused outright for a rate.
   */
  let rateUnknown = false;
  for (const d of drafts) {
    const usd = decimalWad(d.usd as string);
    const rate = OP_FLOW[d.leg.op].rate;
    if (rate === null) continue;
    const apr = legRate(d.leg.op, d.leg.asset, ctx.comparisons);
    if (rate === "earn_borrow") {
      if (apr === null) throw new Reject(d.name, `no ${d.leg.asset} borrow rate was read`);
      borrowed += usd;
      returnWad -= mulDown(usd, decimalWad(apr), WAD);
      continue;
    }
    supplied += usd;
    if (apr === null) { rateUnknown = true; continue; }
    returnWad += mulDown(usd, decimalWad(apr), WAD);
  }
  if (rateUnknown && borrowed > ZERO) {
    const missing = drafts.find((d) => suppliesAtRate(d.leg.op) && legRate(d.leg.op, d.leg.asset, ctx.comparisons) === null)!;
    throw new Reject(missing.name, `no usable ${RATE_VENUE[OP_FLOW[missing.leg.op].rate!]} supply rate was read for ${missing.leg.asset}, so the borrow's carry cannot be judged`);
  }
  /**
   * The same rule the fixed shapes apply: if what the borrow costs meets or exceeds what
   * the supply earns, the position loses money by construction and no health factor
   * makes that acceptable. Ruled out with the rates, not ranked last.
   */
  if (borrowed > ZERO && returnWad <= ZERO) {
    const borrowLeg = drafts.find((d) => OP_FLOW[d.leg.op].rate === "earn_borrow")!;
    const supplyLeg = [...drafts].reverse().find((d) => suppliesAtRate(d.leg.op));
    const borrowRow = ctx.comparisons.find((c) => c.asset === borrowLeg.leg.asset);
    const supplyApr = supplyLeg ? legRate(supplyLeg.leg.op, supplyLeg.leg.asset, ctx.comparisons) : null;
    throw new Reject(borrowLeg.name, supplyLeg && supplyApr
      ? `borrowing ${borrowLeg.leg.asset} costs ${Number(borrowRow?.marginBorrowApr).toFixed(2)}% APR and supplying ${supplyLeg.leg.asset} earns ${Number(supplyApr).toFixed(2)}% — this loses money by construction`
      : "this borrows without a supply that could cover the borrow cost");
  }
  /**
   * After the repays, what debt remains — decided from the debt rows and the repay legs,
   * not from USD arithmetic: the liquidation engine's debt figure and the debt read round
   * differently, and a projection that subtracts one from the other leaves cents, and
   * cents under a five-figure collateral print as "health factor 2495879.67" (13 Sep).
   */
  const repaidBy = new Map<string, bigint>();
  for (const d of drafts) if (d.leg.op === "repay" && d.tokens) repaidBy.set(d.leg.asset, (repaidBy.get(d.leg.asset) ?? ZERO) + decimalWad(d.tokens));
  const remainingDebt = repaidBy.size
    ? debtRows(ctx).flatMap(({ asset, owed }) => {
        // A debt row is stated at accounting precision (18 places); a repay is cut to the
        // token's. Coverage is judged at the token's precision — the contract accepts no finer.
        const places = decimals.get(asset);
        const owedAtToken = places === undefined ? owed : truncateToDecimals(owed, places);
        const left = decimalWad(owedAtToken) - (repaidBy.get(asset) ?? ZERO);
        return left > ZERO ? [{ asset, left: formatWad(left) }] : [];
      })
    : null;
  if (remainingDebt && remainingDebt.length === 0) finalHealthFactor = null;
  // What the plan places: the supplied total, else the final leg's amount (a redeem feeding a
  // deposit is one sum of money, not two).
  const deployed = supplied > ZERO ? supplied : decimalWad(drafts[drafts.length - 1].usd as string);
  const netApr = deployed > ZERO ? (returnWad * WAD) / deployed : ZERO;
  const borrows = borrowed > ZERO;
  const lastSupply = [...drafts].reverse().find((d) => suppliesAtRate(d.leg.op));
  const first = drafts[0];

  return {
    id: planCandidateId(plan),
    kind: "composed",
    label: plan.title,
    borrows,
    asset: first.leg.asset,
    venue: lastSupply ? OP_FLOW[lastSupply.leg.op].venue : "margin",
    netAprPct: borrows ? formatWad(netApr) : null,
    supplyAprPct: rateUnknown ? null : formatWad(grossSupplyApr(drafts, ctx.comparisons, supplied)),
    legs: sized,
    finalHealthFactor,
    amountUsd: formatWad(deployed),
    evidenceIds: plan.evidenceIds.filter((id) => evidence.has(id)),
    amountBasis: drafts.some((d) => d.leg.sizing.kind === "literal" || d.leg.sizing.kind === "fraction") ? "stated" : drafts.some((d) => d.leg.sizing.kind === "to_floor") ? "derived_max_at_floor" : "stated",
    heldAmount: first.heldTokens,
    steps,
    rationale: remainingDebt?.length
      ? `${plan.rationale} Leaves ${remainingDebt.map((r) => `${trimAmount(r.left)} ${r.asset}`).join(" and ")} of debt — the wallet covers no more.`
      : remainingDebt ? `${plan.rationale} No debt remains after this.` : plan.rationale,
    ...(remainingDebt ? { repaysAllDebt: remainingDebt.length === 0 } : {}),
  };
}

function trimAmount(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : value;
}

/**
 * What would make a plan that breached the floor fit — the copilot's job is to say what
 * closes the gap, not only that there is one. From the same closed form the sizer uses:
 * to reach floor F from (G, D) either add collateral ΔG = F·D − G, or repay
 * x = (F·D − G)/(F − 1). When the breach is a literal borrow of X, the collateral needed
 * is F·(D + X) − (G + X). Amounts are USD and, when the wallet holds a priced asset,
 * that asset too.
 */
function shortfallAdvice(
  capacity: { grossCollateralUsd: string; debtUsd: string; floor: string | null },
  result: { reason: string; failingLeg: string | null; legs: SizedLeg[] },
  holdings: ReturnType<typeof idleWalletHoldingsFrom>,
  prices: Map<string, bigint>,
): string | null {
  if (!capacity.floor) return null;
  let gross: bigint, debt: bigint, floor: bigint;
  try { gross = decimalWad(capacity.grossCollateralUsd); debt = decimalWad(capacity.debtUsd); floor = decimalWad(capacity.floor); } catch { return null; }
  if (floor <= WAD) return null;
  // The state the breaching leg started from, and the amount it tried to add.
  const last = result.legs[result.legs.length - 1];
  const before = result.legs.length >= 2 ? result.legs[result.legs.length - 2] : null;
  if (result.reason === "health_floor_breached" && last) {
    const g0 = before ? decimalWad(before.grossAfterUsd) : gross;
    const d0 = before ? decimalWad(before.debtAfterUsd) : debt;
    const x = decimalWad(last.amountUsd);
    gross = g0; debt = d0;
    if (last.op === "borrow") debt = d0 + x, gross = g0 + x;
  }
  const needCollateral = (floor * debt) / WAD - gross;
  if (needCollateral <= ZERO) return null;
  const repay = (needCollateral * WAD) / (floor - WAD);
  const usd = (wad: bigint) => `$${Number(formatWad(wad)).toFixed(2)}`;
  const inTokens = Object.entries(holdings).map(([asset, held]) => {
    const price = prices.get(asset);
    if (!price || !held) return null;
    const tokens = (needCollateral * WAD) / price;
    return decimalWad(held.tokens) >= tokens ? `≈ ${Number(formatWad(tokens)).toFixed(2)} ${asset} from your wallet` : null;
  }).find(Boolean);
  return `to fit at a ${capacity.floor} floor, add ${usd(needCollateral)} of collateral${inTokens ? ` (${inTokens})` : ""} or repay ${usd(repay)} of debt first`;
}

/** The user's Earn position for an asset, from the `earn_position` read: vTokens held and what they redeem for. */
function earnPositionOf(observations: readonly Observation[], asset: string, now: number): { vtokens: string; underlying: string; vtokenSymbol: string | null } | null {
  const read = [...observations].reverse().find((o) => o.capability === "earn_position" && o.status === "ok" && o.data && o.args.asset === asset && now - o.observedAt <= 60_000);
  const vtokens = read?.data?.human, underlying = read?.data?.redeemable_human;
  if (typeof vtokens !== "string" || typeof underlying !== "string") return null;
  try { decimalWad(vtokens); decimalWad(underlying); } catch { return null; }
  // Raw figures: `redeemable_human` is WAD (18 places); the caller cuts to the precision the reads state.
  return { vtokens, underlying, vtokenSymbol: typeof read?.data?.vtoken_symbol === "string" ? read.data.vtoken_symbol : null };
}

/**
 * The LP shares held in one pair's position, from `farm_lp_position`'s own shape: a flat
 * object per pair, not a rows array like the account reads — `positionRowBalance` cannot
 * read it as-is. Matched by the same `asset` argument the catalog bound the read with, so
 * a Soroswap SOUSDC read is never mistaken for the default Aquarius AQUSDC pair.
 */
function farmLpPositionOf(observations: readonly Observation[], asset: string, now: number): string | null {
  const read = [...observations].reverse().find((o) =>
    o.capability === "farm_lp_position" && o.status === "ok" && o.data && o.args.asset === asset && now - o.observedAt <= 60_000);
  const shares = read?.data?.lp_shares_human;
  if (typeof shares !== "string" && typeof shares !== "number") return null;
  try { decimalWad(String(shares)); return String(shares); } catch { return null; }
}

/**
 * Live XLM/paired-token reserves for an Aquarius pool, matched by the same `asset`
 * argument the catalog bound the read with. The reserves dict is keyed by the AMM API's
 * OWN token label, not our registry spelling ("USDC", not "AQUSDC") — the same venue-vs-
 * registry mismatch documented throughout this codebase — so this reads by position
 * (the "XLM" key is always exactly that; whichever other key remains is the paired side)
 * rather than assume the paired token's key matches `def.marginSymbol` literally.
 */
/**
 * Reserves for the pool a swap will actually settle against, by venue.
 *
 * Both venues are constant product and both reads answer in the same envelope, so the
 * same formula prices either one. Soroswap used to have no reserves read at all and was
 * sized from the oracle instead — which is what the pair is WORTH, not what the pool will
 * PAY. Live, 16 Sep: that offered "100 XLM for at least 17.4469985 SOUSDC" against a pool
 * paying 7.4921219, a floor the pool could never fill.
 */
function poolReservesOf(
  observations: readonly Observation[], pairedAsset: string, venue: string, now: number,
): PoolReserves | null {
  const capability = venue === "soroswap" ? "soroswap_pool_reserves" : "aquarius_pool_reserves";
  const read = [...observations].reverse().find((o) =>
    o.capability === capability && o.status === "ok" && o.data && o.args.asset === pairedAsset && now - o.observedAt <= 60_000);
  return read?.data ? poolReservesFrom(read.data) : null;
}

function aquariusReservesOf(observations: readonly Observation[], pairedAsset: string, now: number): PoolReserves | null {
  return poolReservesOf(observations, pairedAsset, "aquarius", now);
}

function aquariusPoolDataOf(observations: readonly Observation[], pairedAsset: string, now: number): Record<string, unknown> | null {
  const read = [...observations].reverse().find((o) =>
    o.capability === "aquarius_pool_reserves" && o.status === "ok" && o.data && o.args.asset === pairedAsset && now - o.observedAt <= 60_000);
  return isRecord(read?.data?.pool) ? read.data.pool : null;
}

/** A row's balance in an account read (`account_collateral` / `account_debt`), by the symbol the contract uses or the registry id. */
function positionRowBalance(observations: readonly Observation[], capability: string, keys: readonly string[], symbol: string, id: string, now: number): string | null {
  const read = [...observations].reverse().find((o) => o.capability === capability && o.status === "ok" && o.data && now - o.observedAt <= 60_000);
  if (!read?.data) return null;
  for (const key of keys) {
    const rows = read.data[key];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!isRecord(row) || (row.symbol !== symbol && row.symbol !== id) || row.balance_untrusted === true) continue;
      // `underlying_value` is how a Blend position states its size; the account reads use `balance`.
      const balance = row.balance ?? row.amount_human ?? row.amount ?? row.underlying_value;
      if (typeof balance !== "string" && typeof balance !== "number") continue;
      try { decimalWad(String(balance)); return String(balance); } catch { return null; }
    }
  }
  return null;
}

/**
 * Why the wallet cannot fund a leg: a dust line is named with its worth, a held-but-locked
 * line with the read's own minimum balance and fee reserve, an empty one plainly.
 */
/**
 * What a pocket can still supply, after the legs already sized in this plan.
 *
 * One prompt is often several instructions — "repay my debt, and if I don't have the funds
 * deposit into my margin account" is two. Every leg used to size itself from the READ, as
 * though it were the only leg, so two legs drawing on one balance each took all of it. On
 * 14 Sep that produced a plan depositing the same 3,315.63 XLM twice; the shape matrix
 * then found the same flaw in the Earn position and the margin account. A pocket carries
 * a running balance instead.
 *
 * `debt` runs the other way: it is what is still OWED, so a repay reduces it.
 */
const CREDITABLE: ReadonlySet<Pocket> = new Set<Pocket>(["wallet", "account", "blend"]);
function pocketBalance(
  pocket: Pocket,
  starting: bigint,
  drafts: ReadonlyArray<{ leg: PlanLeg; tokens: string | null; produces: string | null }>,
  asset: string,
): { available: bigint; consumed: boolean; credited: boolean; unsized: boolean } {
  let available = starting;
  let consumed = false, credited = false, unsized = false;
  for (const draft of drafts) {
    const flow = OP_FLOW[draft.leg.op];
    // What a leg spends and what it produces are the same asset everywhere but a swap.
    const spends = draft.leg.asset === asset;
    const produces = (draft.leg.assetOut ?? draft.leg.asset) === asset;
    if (!spends && !produces) continue;
    if (flow.from === pocket && spends) {
      // A borrow sized to the floor has no amount yet; a later leg cannot be checked against it.
      if (draft.tokens === null) unsized = true;
      else { available -= decimalWad(draft.tokens); consumed = true; }
    }
    if (flow.to === pocket && produces) {
      /**
       * What a swap fills at is not known until it runs: the oracle gives a price, the
       * pool gives the trade. Rather than credit a number the chain may not honour, the
       * pocket is marked unsized and a later leg must state its own amount.
       */
      if (draft.leg.op === "swap") { unsized = true; continue; }
      if (draft.produces === null) unsized = true;
      // A lend's output is underlying but the Earn pocket is vTokens: crediting it would
      // compare unlike units. Blend is safe — a supply and a withdraw are both in underlying.
      else if (CREDITABLE.has(pocket)) { available += decimalWad(draft.produces); credited = true; }
      else if (pocket === "debt") { available -= decimalWad(draft.produces); consumed = true; }
    }
  }
  return { available, consumed, credited, unsized };
}

/** The idle balance a leg may still draw on, as tokens. */
function walletAfterEarlierLegs(
  held: { usd: string; tokens: string } | undefined,
  drafts: ReadonlyArray<{ leg: PlanLeg; tokens: string | null; produces: string | null }>,
  asset: string,
): { tokens: string | null; spent: boolean; startedWith: string | null } {
  const { available, consumed, credited } = pocketBalance("wallet", held ? decimalWad(held.tokens) : ZERO, drafts, asset);
  // No wallet line is not "nothing available": an earlier redeem or withdraw may land some
  // in this same plan, and a deposit after it is fundable by exactly that.
  if (!held && !credited) return { tokens: null, spent: false, startedWith: null };
  return { tokens: available > ZERO ? formatWad(available) : "0", spent: consumed, startedWith: held?.tokens ?? "0" };
}

function noIdleReason(asset: string, dust: Partial<Record<string, { usd: string; tokens: string }>>, txFloor: bigint | null, ctx: PlanContext): string {
  const speck = dust[asset];
  if (speck && txFloor !== null) {
    return `${speck.tokens} ${asset} ($${Number(speck.usd).toFixed(2)}) is worth less than the fee reserve one transaction needs ($${Number(formatWad(txFloor)).toFixed(2)}) — not worth moving`;
  }
  const locked = unspendableWalletLine(ctx.observations, ctx.now, asset);
  if (locked) {
    const why = [locked.minBalance ? `${locked.minBalance} ${asset} is the chain's minimum balance` : null, locked.feeReserve ? `${locked.feeReserve} ${asset} is the fee reserve` : null].filter(Boolean);
    return `${locked.balance} ${asset} is held, but ${why.length ? `${why.join(" and ")} — ` : ""}nothing is spendable`;
  }
  return `no idle ${asset} in the wallet`;
}

/**
 * A stated write ("lend 1 xlm to earn") is a plan of literal legs, sized, funded and
 * checked exactly as a model plan is — the same reads, the same pockets, the same refusal
 * that names the figure. 14 Sep: stated actions compiled straight to steps with nothing
 * checked against a balance; "lend 1 xlm" was offered from a wallet with nothing
 * spendable, approved, and refused by the contract after the fact.
 */
export function planFromStatedActions(actions: NonNullable<GoalUnderstanding["actions"]>, objective: string): ProposedPlan | null {
  if (!actions.length) return null;
  return {
    title: actions.map((a) => `${verbOf(a.op)} ${a.amount} ${a.asset}`).join(", then "),
    rationale: objective,
    evidenceIds: [],
    legs: actions.map((a) => ({ op: a.op, asset: a.asset, sizing: { kind: "literal", amount: a.amount, sourceQuote: a.sourceQuote } })),
  };
}

/** Supply-side APR alone, weighted by amount, for the "supply APR" column when a plan also borrows. */
function grossSupplyApr(drafts: ReadonlyArray<{ leg: PlanLeg; usd: string | "max" | { previous: number } }>, comparisons: readonly RateComparison[], supplied: bigint): bigint {
  let acc = ZERO;
  for (const d of drafts) {
    if (!suppliesAtRate(d.leg.op)) continue;
    const apr = legRate(d.leg.op, d.leg.asset, comparisons);
    if (apr === null) continue;
    acc += mulDown(decimalWad(d.usd as string), decimalWad(apr), WAD);
  }
  return supplied > ZERO ? (acc * WAD) / supplied : ZERO;
}

// ── the op-flow table, read for the sizer ───────────────────────────────────

/** The row set each position read carries its balances under (the MCP's shapes, as normalised). */
const POSITION_ROWS: Record<Exclude<NonNullable<OpFlow["positionRead"]>, "earn_position" | "farm_lp_position">, readonly string[]> = {
  blend_position: ["positions"],
  account_collateral: ["collateral", "positions", "balances"],
  account_debt: ["debt", "borrows", "positions"],
};
/** The rate row column each table rate names. */
const RATE_COLUMN: Record<NonNullable<OpFlow["rate"]>, keyof Pick<RateComparison, "earnSupplyApr" | "marginBorrowApr" | "blendSupplyApr">> = {
  earn_supply: "earnSupplyApr", earn_borrow: "marginBorrowApr", blend_supply: "blendSupplyApr",
};
const RATE_VENUE: Record<NonNullable<OpFlow["rate"]>, string> = { earn_supply: "Earn", earn_borrow: "Earn", blend_supply: "Blend" };
function legRate(op: WorkflowOp, asset: string, comparisons: readonly RateComparison[]): string | null {
  const rate = OP_FLOW[op].rate;
  if (rate === null) return null;
  return comparisons.find((c) => c.asset === asset)?.[RATE_COLUMN[rate]] ?? null;
}
/** A leg that earns a supply rate (as opposed to paying a borrow rate or carrying none). */
function suppliesAtRate(op: WorkflowOp): boolean {
  const rate = OP_FLOW[op].rate;
  return rate !== null && rate !== "earn_borrow";
}
/**
 * A swap or add_liquidity leg completed with its second asset, taken from the user's own
 * words when the model left `assetOut` off. A full plan shape always carries it —
 * `parsePlan` drops the whole plan otherwise — so this only ever fires on the single-leg
 * literal actions `planFromStatedActions` builds from `goal.actions`, whose schema has no
 * `assetOut` field at all: JSON Schema cannot make a field required for one op only there
 * either, and Gemini skips optional fields.
 *
 * This runs ONCE, before the reads phase, because everything downstream reads the finished
 * leg: `readsForPlans` fetches the bought asset's price from it, the sizer values it, the
 * label names it and the write carries it as `token_out`. Recovering it in the sizer alone
 * left the reads blind — on 15 Sep "swap 10 XLM to AQUSDC" was refused for "no AQUSDC
 * price was read", a price the reads phase had never been told to ask for.
 */
export function withBoughtAsset(plans: readonly ProposedPlan[], messages: readonly string[]): ProposedPlan[] {
  const incomplete = (leg: PlanLeg) => (ASSET_OUT_OPS as readonly string[]).includes(leg.op) && !leg.assetOut;
  return plans.map((plan) => plan.legs.some(incomplete)
    ? {
      ...plan,
      legs: plan.legs.map((leg) => {
        if (!incomplete(leg)) return leg;
        const bought = assetNamedInText(messages, leg.asset);
        return bought ? { ...leg, assetOut: bought.id } : leg;
      }),
    }
    : plan);
}

/**
 * The asset a user named in their own words, excluding the one already being spent. Null
 * when they named none or named several — a swap is not guessed from a list of maybes.
 */
function assetNamedInText(messages: readonly string[], spending: string): ReturnType<typeof resolveAssetDef> {
  const found = new Map<string, NonNullable<ReturnType<typeof resolveAssetDef>>>();
  const pattern = new RegExp(ASSET_SYMBOL_PATTERN.source, "gi");
  for (const message of messages) {
    for (const word of message.match(pattern) ?? []) {
      const def = resolveAssetDef(word);
      if (def && def.id !== spending && def.marginSymbol && poolVenueFor(spending, def.id)) found.set(def.id, def);
    }
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

/** The leg's own amount when it has one, for a refusal that shows the shape of the answer. */
function d0(leg: PlanLeg): string {
  return leg.sizing.kind === "literal" ? leg.sizing.amount : "10";
}

/** A venue as a person writes it, from its own name rather than a table of two. */
function venueLabel(venue: string): string {
  return venue.charAt(0).toUpperCase() + venue.slice(1);
}

/** "Deposit", "Withdraw", "Supply", "Lend" … — the op's verb for labels and refusals. */
function verbOf(op: WorkflowOp): string {
  const verb = op === "supply_blend" ? "supply" : op.split("_")[0];
  return verb.charAt(0).toUpperCase() + verb.slice(1);
}
/** Where a step's label says the tokens go, from the table's destination pocket. */
const WHERE: Record<WorkflowOp, string> = Object.fromEntries(WORKFLOW_OPS.map((op) => {
  const { from, to } = OP_FLOW[op];
  const text = to === "earn" ? " to Earn" : to === "blend" ? " to Blend" : to === "account" && from === "wallet" ? " as collateral"
    : to === "wallet" && from === "account" ? " of collateral to the wallet" : "";
  return [op, text];
})) as Record<WorkflowOp, string>;
/** "a lend or a deposit" — the ops the wallet feeds, for a refusal. */
function walletOps(): string {
  return listOps(WORKFLOW_OPS.filter((op) => OP_FLOW[op].from === "wallet"));
}
/** "a redeem, a withdraw or a repay" — the ops sized from a position, for a refusal. */
function positionOps(): string {
  return listOps(WORKFLOW_OPS.filter((op) => OP_FLOW[op].positionRead !== null));
}
function listOps(ops: readonly WorkflowOp[]): string {
  const words = ops.map((op) => `a ${verbOf(op).toLowerCase()}`);
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}
/** Why `later` cannot take what `earlier` left behind, said from where the tokens actually went. */
function handoffReason(earlier: WorkflowOp, later: WorkflowOp): string {
  const left = OP_FLOW[earlier].to;
  if (left === "earn") return "Earn lending leaves nothing in the account to use next";
  if (left === "debt") return "a repay leaves nothing behind to use next";
  if (left === "blend") return "a Blend supply leaves nothing in the account to use next";
  const takers = WORKFLOW_OPS.filter((op) => feeds(earlier, op)).map((op) => verbOf(op).toLowerCase());
  const list = takers.length <= 1 ? takers.join("") : `${takers.slice(0, -1).join(", ")} or ${takers[takers.length - 1]}`;
  const where = left === "wallet" ? "returns tokens to the wallet" : "puts tokens in the account";
  return `a ${verbOf(earlier).toLowerCase()} ${where} — ${list} them next, not a ${verbOf(later).toLowerCase()}`;
}
