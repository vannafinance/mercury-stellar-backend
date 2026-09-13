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

import { resolveAssetDef } from "../registry/assets";
import { allowedInvocation, TOOLS, writeArgsFor } from "../workflow/allowlist";
import { WALLET_OPS, type ProposalStep } from "../workflow/types";
import { isRecord } from "./decision";
import { candidateId } from "./candidate-id";
import { freshPrices, idleWalletHoldingsFrom, type Candidate } from "./candidates";
import { priceFor, tokensFromUsd, wireSymbol, writeArgs } from "./compile";
import { decimalWad, formatWad, mulDown, WAD, ZERO } from "./fixed";
import type { RateComparison } from "./rate-comparison";
import { sizeLegs, type LegRequest, type SizedLeg } from "./sizing";
import type { InvestigationScope, Observation, PlanLeg, ProposedPlan } from "./types";

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

class Reject extends Error {
  constructor(readonly leg: string | null, message: string) { super(message); }
}

const SIZER_REASONS: Record<string, string> = {
  floor_below_liquidation_threshold: "a health-factor floor at or below 1.1 is the liquidation line, not a safety margin — state a floor above it",
  would_be_liquidatable: "this would leave the account liquidatable",
  floor_required_for_max: "sizing to the floor needs a stated health-factor floor",
  no_capacity_at_floor: "there is no borrowing headroom at your health-factor floor",
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
  const prices = freshPrices(ctx.observations, ctx.now);
  const evidence = new Set(ctx.observations.filter((o) => o.status === "ok").map((o) => o.id));
  const collateralAllowed = liveCollateralAllowed(ctx.observations);

  /**
   * Pass 1 — resolve what each leg is sized FROM. Margin legs go to the sizer as USD (or
   * "max" for `to_floor`); wallet legs are sized here. `previous_leg` is a reference the
   * sizer's output fills in.
   */
  interface Draft {
    leg: PlanLeg; name: string;
    usd: string | "max" | { previous: number };
    /** The amount the tool is called with (vTokens for a redeem). */
    tokens: string | null;
    /** What the leg leaves for the next one; differs from `tokens` only for a redeem. */
    produces: string | null;
    heldTokens: string | null;
  }
  const drafts: Draft[] = [];
  for (const [index, leg] of plan.legs.entries()) {
    const name = `${leg.op.replaceAll("_", " ")} ${leg.asset}`;
    const def = resolveAssetDef(leg.asset);
    if (!def) throw new Reject(name, `${leg.asset} is not a supported asset`);
    const price = priceFor(leg.asset, ctx.observations, ctx.now);
    if (!price.ok) throw new Reject(name, price.reason === "stale_price" ? `the ${leg.asset} price read is older than a minute` : `no ${leg.asset} price was read this investigation`);
    const walletOp = WALLET_OPS.includes(leg.op);
    if (walletOp && !def.earnSymbol) throw new Reject(name, `${leg.asset} has no Earn pool`);
    if (!walletOp && !def.marginSymbol) throw new Reject(name, `${leg.asset} is not accepted by the margin account`);
    if (leg.op === "deposit_collateral" && collateralAllowed?.get(def.marginSymbol!) === false) {
      throw new Reject(name, `${leg.asset} is not accepted as collateral on-chain right now (collateral_config)`);
    }
    if (leg.op === "supply_blend" && !def.blendReserve) throw new Reject(name, `Blend has no ${leg.asset} reserve`);
    if (!walletOp && !ctx.scope.smartAccount) throw new Reject(name, "a margin account is needed for this step and none is connected");
    if (!walletOp && !ctx.capacity) throw new Reject(name, "the margin position was not read, so nothing touching the account can be sized");
    // A withdraw lowers health exactly as a borrow does, so it carries the same two gates.
    if (leg.op === "withdraw_collateral" && ctx.capacity?.issue) {
      throw new Reject(name, ctx.capacity.issue.reason === "sizing_sources_disagree"
        ? "the Margin page and the liquidation engine disagree on your position, so nothing that lowers health is sized until they agree"
        : "the position could not be confirmed against the liquidation engine, so nothing that lowers health is sized");
    }
    // Owner rule (service.ts): permission to borrow is optional, not an instruction; "unspecified"
    // still offers a levered path beside the idle one. Only an explicit prohibition rules it out.
    if (leg.op === "borrow" && ctx.borrowing === "forbidden") throw new Reject(name, "you said no new borrowing");
    if (leg.op === "borrow" && ctx.capacity && ctx.capacity.floor === null) {
      throw new Reject(name, "a borrow needs the health-factor floor you want kept, above the 1.1 liquidation line — tell me the number");
    }
    if (leg.op === "borrow" && ctx.capacity?.issue) {
      const issue = ctx.capacity.issue;
      throw new Reject(name, issue.reason === "sizing_sources_disagree" && issue.contract
        ? `the Margin page and the liquidation engine disagree on your position (collateral $${issue.app.grossCollateralUsd} vs $${issue.contract.grossCollateralUsd}, debt $${issue.app.debtUsd} vs $${issue.contract.debtUsd}) — tokens in the account that are not posted as collateral count for the page but not for the engine; a borrow is not sized until they agree`
        : issue.reason === "sizing_app_unavailable"
          ? "the Margin page snapshot could not be read in time to confirm the liquidation engine's figures, so a borrow is not sized — try again in a moment"
          : "the contract's liquidation snapshot could not be read, so a borrow is not sized");
    }

    const sizing = leg.sizing;
    // An idle wallet balance feeds a lend or a deposit; `all_position` on those is the same thing.
    if (sizing.kind === "all_idle" || (sizing.kind === "all_position" && (leg.op === "lend" || leg.op === "deposit_collateral"))) {
      if (leg.op !== "lend" && leg.op !== "deposit_collateral") {
        throw new Reject(name, leg.op === "supply_blend"
          ? "Blend supply spends the margin account — deposit the idle tokens as collateral first"
          : "an idle wallet balance does not size a borrow, repay, redeem or withdraw");
      }
      const held = holdings[leg.asset as keyof typeof holdings];
      if (!held || decimalWad(held.tokens) <= ZERO) throw new Reject(name, `no idle ${leg.asset} in the wallet`);
      drafts.push({ leg, name, usd: held.usd, tokens: held.tokens, produces: held.tokens, heldTokens: held.tokens });
      continue;
    }
    if (sizing.kind === "all_position") {
      /**
       * The whole of what the op draws on, from the read that holds it: vTokens in Earn for
       * a redeem (the tool takes vTokens; the underlying comes back), the posted balance
       * for a withdraw, the outstanding balance for a repay.
       */
      if (leg.op === "redeem") {
        const position = earnPositionOf(ctx.observations, leg.asset, ctx.now);
        if (!position) throw new Reject(name, `no ${leg.asset} position in Earn was read this investigation`);
        if (decimalWad(position.vtokens) <= ZERO) throw new Reject(name, `you hold no ${leg.asset} in Earn`);
        const usd = formatWad(mulDown(decimalWad(position.underlying), price.price, WAD));
        drafts.push({ leg, name, usd, tokens: position.vtokens, produces: position.underlying, heldTokens: position.underlying });
        continue;
      }
      const rowsOf = leg.op === "withdraw_collateral" ? ["account_collateral", ["collateral", "positions", "balances"]] as const
        : leg.op === "repay" ? ["account_debt", ["debt", "borrows", "positions"]] as const : null;
      if (!rowsOf) throw new Reject(name, "all_position applies to a redeem, a withdraw or a repay");
      const balance = positionRowBalance(ctx.observations, rowsOf[0], rowsOf[1], def.marginSymbol!, def.id, ctx.now);
      if (balance === null) throw new Reject(name, `no ${leg.asset} ${leg.op === "repay" ? "debt" : "posted collateral"} was read this investigation`);
      if (decimalWad(balance) <= ZERO) throw new Reject(name, leg.op === "repay" ? `you owe no ${leg.asset}` : `no ${leg.asset} is posted as collateral`);
      const usd = formatWad(mulDown(decimalWad(balance), price.price, WAD));
      drafts.push({ leg, name, usd, tokens: balance, produces: balance, heldTokens: null });
      continue;
    }
    if (sizing.kind === "to_floor") {
      if (leg.op !== "borrow") throw new Reject(name, "only a borrow can be sized to the health-factor floor");
      drafts.push({ leg, name, usd: "max", tokens: null, produces: null, heldTokens: null });
      continue;
    }
    if (sizing.kind === "previous_leg") {
      const prev = drafts[index - 1];
      if (!prev || prev.leg.asset !== leg.asset) throw new Reject(name, "previous_leg needs a preceding leg in the same asset");
      if (prev.leg.op === "lend") throw new Reject(name, "Earn lending leaves nothing in the account to use next");
      if (prev.leg.op === "redeem" && leg.op !== "deposit_collateral" && leg.op !== "lend") throw new Reject(name, "a redeem returns tokens to the wallet — deposit or lend them next");
      drafts.push({ leg, name, usd: { previous: index - 1 }, tokens: prev.produces, produces: prev.produces, heldTokens: null });
      continue;
    }
    // literal — anchored to the user's own words, exactly as goal.actions requires.
    const numbersInQuote: string[] = sizing.sourceQuote.match(/\d+(?:\.\d+)?/g) ?? [];
    const quoted = ctx.messages.some((m) => m.includes(sizing.sourceQuote)) && numbersInQuote.includes(sizing.amount);
    if (!quoted) throw new Reject(name, `the amount ${sizing.amount} does not appear in your request`);
    if (leg.op === "supply_blend") throw new Reject(name, "Blend supply takes what a deposit or borrow put in the account — size that leg instead");
    if (leg.op === "redeem") {
      // The user names the underlying; the tool takes vTokens, converted at the position's own rate.
      const position = earnPositionOf(ctx.observations, leg.asset, ctx.now);
      if (!position || decimalWad(position.underlying) <= ZERO) throw new Reject(name, `no ${leg.asset} position in Earn was read this investigation`);
      const underlying = decimalWad(sizing.amount);
      if (underlying > decimalWad(position.underlying)) throw new Reject(name, `only ${position.underlying} ${leg.asset} is redeemable from Earn`);
      const vtokens = formatWad((underlying * decimalWad(position.vtokens)) / decimalWad(position.underlying));
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
  const marginDrafts = drafts.filter((d) => !WALLET_OPS.includes(d.leg.op) && d.leg.op !== "supply_blend");
  let sized: SizedLeg[] = [];
  let finalHealthFactor: string | null = null;
  if (marginDrafts.length) {
    const capacity = ctx.capacity!;
    const requests: LegRequest[] = marginDrafts.map((d) => ({
      op: d.leg.op as LegRequest["op"], label: d.name,
      amountUsd: d.usd === "max" ? "max" : typeof d.usd === "string" ? d.usd : "0",
    }));
    /**
     * The floor is a stop condition for legs that can LOWER health. A sequence of deposits
     * and repays only raises it, so it is sized against the contract's line alone — an
     * account already under its floor can still deposit its way back above it (the PR #58
     * defect: repay and deposit were blocked exactly when they were needed).
     */
    const canLowerHealth = marginDrafts.some((d) => d.leg.op === "borrow" || d.leg.op === "withdraw_collateral");
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
        const tokens = tokensFromUsd(sized[i].amountUsd, prices.get(draft.leg.asset)!);
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

  /** Pass 3 — steps, exactly as `compileRequestedActions` builds them, then the allowlist. */
  const steps: ProposalStep[] = drafts.map((d, index) => {
    const def = resolveAssetDef(d.leg.asset)!;
    const symbol = WALLET_OPS.includes(d.leg.op) ? def.earnSymbol! : d.leg.op === "supply_blend" ? (def.marginSymbol ?? def.id) : wireSymbol(d.leg.asset);
    const verb = d.leg.op === "supply_blend" ? "Supply" : d.leg.op === "deposit_collateral" ? "Deposit" : d.leg.op === "withdraw_collateral" ? "Withdraw" : d.leg.op.charAt(0).toUpperCase() + d.leg.op.slice(1);
    const where = d.leg.op === "lend" ? " to Earn" : d.leg.op === "supply_blend" ? " to Blend" : d.leg.op === "deposit_collateral" ? " as collateral" : d.leg.op === "withdraw_collateral" ? " of collateral to the wallet" : "";
    const label = d.leg.op === "redeem"
      ? `Redeem ${d.tokens} ${def.id} vTokens from Earn (≈ ${d.produces} ${def.displayLabel ?? def.id})`
      : `${verb} ${d.tokens} ${def.displayLabel ?? def.id}${where}`;
    const step: ProposalStep = {
      id: `s${index}-${d.leg.op}`,
      op: d.leg.op,
      asset: def.id,
      amount: d.tokens!,
      label,
      tool: TOOLS[d.leg.op],
      args: writeArgsFor(d.leg.op, symbol, d.tokens!, ctx.scope),
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
  for (const d of drafts) {
    const row = ctx.comparisons.find((c) => c.asset === d.leg.asset);
    const usd = decimalWad(d.usd as string);
    if (d.leg.op === "lend" || d.leg.op === "supply_blend") {
      const apr = d.leg.op === "lend" ? row?.earnSupplyApr : row?.blendSupplyApr;
      if (apr === null || apr === undefined) throw new Reject(d.name, `no usable ${d.leg.op === "lend" ? "Earn" : "Blend"} supply rate was read for ${d.leg.asset}`);
      supplied += usd;
      returnWad += mulDown(usd, decimalWad(apr), WAD);
    }
    if (d.leg.op === "borrow") {
      if (!row?.marginBorrowApr) throw new Reject(d.name, `no ${d.leg.asset} borrow rate was read`);
      borrowed += usd;
      returnWad -= mulDown(usd, decimalWad(row.marginBorrowApr), WAD);
    }
  }
  /**
   * The same rule the fixed shapes apply: if what the borrow costs meets or exceeds what
   * the supply earns, the position loses money by construction and no health factor
   * makes that acceptable. Ruled out with the rates, not ranked last.
   */
  if (borrowed > ZERO && returnWad <= ZERO) {
    const borrowLeg = drafts.find((d) => d.leg.op === "borrow")!;
    const supplyLeg = [...drafts].reverse().find((d) => d.leg.op === "lend" || d.leg.op === "supply_blend");
    const borrowRow = ctx.comparisons.find((c) => c.asset === borrowLeg.leg.asset);
    const supplyRow = supplyLeg ? ctx.comparisons.find((c) => c.asset === supplyLeg.leg.asset) : undefined;
    const supplyApr = supplyLeg ? (supplyLeg.leg.op === "lend" ? supplyRow?.earnSupplyApr : supplyRow?.blendSupplyApr) : null;
    throw new Reject(borrowLeg.name, supplyLeg && supplyApr
      ? `borrowing ${borrowLeg.leg.asset} costs ${Number(borrowRow?.marginBorrowApr).toFixed(2)}% APR and supplying ${supplyLeg.leg.asset} earns ${Number(supplyApr).toFixed(2)}% — this loses money by construction`
      : "this borrows without a supply that could cover the borrow cost");
  }
  const deployed = supplied > ZERO ? supplied : drafts.reduce((sum, d) => sum + decimalWad(d.usd as string), ZERO);
  const netApr = deployed > ZERO ? (returnWad * WAD) / deployed : ZERO;
  const borrows = borrowed > ZERO;
  const lastSupply = [...drafts].reverse().find((d) => d.leg.op === "lend" || d.leg.op === "supply_blend");
  const first = drafts[0];

  return {
    id: planCandidateId(plan),
    kind: "composed",
    label: plan.title,
    borrows,
    asset: first.leg.asset,
    venue: lastSupply?.leg.op === "lend" ? "earn" : lastSupply ? "blend" : "margin",
    netAprPct: borrows ? formatWad(netApr) : null,
    supplyAprPct: formatWad(grossSupplyApr(drafts, ctx.comparisons, supplied)),
    legs: sized,
    finalHealthFactor,
    amountUsd: formatWad(deployed),
    evidenceIds: plan.evidenceIds.filter((id) => evidence.has(id)),
    amountBasis: drafts.some((d) => d.leg.sizing.kind === "literal") ? "stated" : drafts.some((d) => d.leg.sizing.kind === "to_floor") ? "derived_max_at_floor" : "stated",
    heldAmount: first.heldTokens,
    steps,
    rationale: plan.rationale,
  };
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
function earnPositionOf(observations: readonly Observation[], asset: string, now: number): { vtokens: string; underlying: string } | null {
  const read = [...observations].reverse().find((o) => o.capability === "earn_position" && o.status === "ok" && o.data && o.args.asset === asset && now - o.observedAt <= 60_000);
  const vtokens = read?.data?.human, underlying = read?.data?.redeemable_human;
  if (typeof vtokens !== "string" || typeof underlying !== "string") return null;
  try { decimalWad(vtokens); decimalWad(underlying); } catch { return null; }
  return { vtokens, underlying };
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
      const balance = row.balance ?? row.amount_human ?? row.amount;
      if (typeof balance !== "string" && typeof balance !== "number") continue;
      try { decimalWad(String(balance)); return String(balance); } catch { return null; }
    }
  }
  return null;
}

/** Supply-side APR alone, weighted by amount, for the "supply APR" column when a plan also borrows. */
function grossSupplyApr(drafts: ReadonlyArray<{ leg: PlanLeg; usd: string | "max" | { previous: number } }>, comparisons: readonly RateComparison[], supplied: bigint): bigint {
  let acc = ZERO;
  for (const d of drafts) {
    if (d.leg.op !== "lend" && d.leg.op !== "supply_blend") continue;
    const row = comparisons.find((c) => c.asset === d.leg.asset);
    const apr = d.leg.op === "lend" ? row?.earnSupplyApr : row?.blendSupplyApr;
    if (!apr) continue;
    acc += mulDown(decimalWad(d.usd as string), decimalWad(apr), WAD);
  }
  return supplied > ZERO ? (acc * WAD) / supplied : ZERO;
}
