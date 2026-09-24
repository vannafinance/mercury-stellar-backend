import { lpPairs, lpVenues, type LpVenue, ASSET_IDS } from "../registry/assets";
import { parseQuestionnaireMissingList } from "./questionnaire";
import { ASSET_OUT_OPS, MAX_WORKFLOW_STEPS, OP_FLOW, WORKFLOW_OPS, type WorkflowOp } from "../workflow/types";
import { LIFECYCLE_WRITES, isLifecycleWriteOp } from "../workflow/lifecycle";
import type { PlanLeg, PlanOp, PlanSizing, ProposedPlan, ReadRequest, ResearchDecision, StatedAction } from "./types";

export const PLAN_OPS: readonly PlanOp[] = WORKFLOW_OPS;
/** The sizing words a leg may carry. `plan.ts` gives each one its meaning; the prompt lists them from here. */
export const PLAN_SIZINGS = ["all_idle", "all_position", "to_floor", "previous_leg", "literal", "fraction", "leverage"] as const;
const MAX_PLANS = 3;
/** A plan may have as many legs as one approval can run; sizing refuses one that grows past it. */
const MAX_LEGS = MAX_WORKFLOW_STEPS;

/** Bounded so one decision cannot drain the whole tool budget in a single turn. */
export const MAX_BATCHED_READS = 8;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function text(value: unknown, max = 1600): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function texts(value: unknown, maxItems = 12): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => text(item));
}

/**
 * Why the last `parseDecision` returned null — the runtime logs it. Until 13 Sep a refused
 * decision surfaced only as "Research stopped: invalid decision", with nothing anywhere
 * saying which check the model failed.
 */
let lastRefusal = "";
export function lastDecisionRefusal(): string { return lastRefusal; }
function refuse(reason: string): null { lastRefusal = reason; return null; }

/** Strict boundary for model output, regardless of provider schema enforcement. */
export function parseDecision(raw: unknown): ResearchDecision | null {
  lastRefusal = "";
  if (!isRecord(raw)) return refuse("not an object");
  // Single-read form. Kept because it is the natural output for a genuinely dependent
  // read, and the capability registry still validates every name and argument.
  if (raw.kind === "inspect" && exactKeys(raw, ["kind", "capability", "args"]) &&
    text(raw.capability, 80) && isRecord(raw.args)) {
    return { kind: "inspect", reads: [{ capability: raw.capability, args: { ...raw.args } }] };
  }
  // Batched form: independent reads answered in one turn.
  if (raw.kind === "inspect" && exactKeys(raw, ["kind", "reads"]) && Array.isArray(raw.reads) &&
    raw.reads.length > 0 && raw.reads.length <= MAX_BATCHED_READS) {
    const reads: ReadRequest[] = [];
    for (const read of raw.reads) {
      if (!isRecord(read) || !exactKeys(read, ["capability", "args"]) ||
        !text(read.capability, 80) || !isRecord(read.args)) return refuse("inspect: a read is malformed");
      reads.push({ capability: read.capability, args: { ...read.args } });
    }
    // A batch that names the same capability+args twice would burn budget on a duplicate.
    const keys = reads.map((read) => JSON.stringify([read.capability, read.args]));
    if (new Set(keys).size !== keys.length) return refuse("inspect: duplicate reads");
    return { kind: "inspect", reads };
  }
  if (raw.kind === "clarify" && text(raw.question)) {
    const keys = ["kind", "question", ...(raw.missing !== undefined ? ["missing"] : []), ...(raw.actions !== undefined ? ["actions"] : [])];
    if (!exactKeys(raw, keys)) return refuse("clarify: unexpected keys");
    const missing = raw.missing !== undefined ? parseQuestionnaireMissingList(raw.missing) : undefined;
    if (raw.missing !== undefined && !missing) return refuse("clarify: missing inputs are not a known op, asset or slot");
    const actionRows = raw.actions === undefined ? [] : Array.isArray(raw.actions) ? raw.actions.slice(0, 8) : [];
    const actions: StatedAction[] = actionRows.flatMap((action) => {
      const leg = parseLeg(action, ["sourceQuote"]);
      if (!leg || !isRecord(action) || !text(action.sourceQuote, 1600)) return [];
      return [{ ...leg, sourceQuote: String(action.sourceQuote) }];
    });
    return {
      kind: "clarify",
      question: raw.question,
      ...(missing ? { missing } : {}),
      ...(actions.length ? { actions } : {}),
    };
  }
  if (raw.kind === "blocked" && exactKeys(raw, ["kind", "reason"]) && text(raw.reason)) {
    return { kind: "blocked", reason: raw.reason };
  }
  if (raw.kind !== "research_complete" || !exactKeys(raw, ["kind", "goal", "findings", "openQuestions", ...(Object.hasOwn(raw, "plans") ? ["plans"] : [])])) {
    return refuse(`unknown kind or keys: kind=${String(raw.kind)} keys=${Object.keys(raw).join(",")}`);
  }
  const goal = raw.goal;
  if (!isRecord(goal) || !exactKeys(goal, ["objective", "constraints", "borrowing", ...(Object.hasOwn(goal, "intent") ? ["intent"] : []), ...(Object.hasOwn(goal, "relation") ? ["relation"] : []), ...(Object.hasOwn(goal, "actions") ? ["actions"] : []), ...(Object.hasOwn(goal, "write") ? ["write"] : []), ...(Object.hasOwn(goal, "healthFactorFloor") ? ["healthFactorFloor"] : []), ...(Object.hasOwn(goal, "slippageAccepted") ? ["slippageAccepted"] : []), ...(Object.hasOwn(goal, "walletReserves") ? ["walletReserves"] : []), ...(Object.hasOwn(goal, "planRelation") ? ["planRelation"] : []), ...(Object.hasOwn(goal, "trigger") ? ["trigger"] : [])]) ||
    (goal.relation !== undefined && !["new", "refine"].includes(String(goal.relation))) ||
    (goal.intent !== undefined && !["answer", "strategy"].includes(String(goal.intent))) ||
    !text(goal.objective) || !texts(goal.constraints) ||
    !["unspecified", "allowed", "required", "forbidden"].includes(String(goal.borrowing))) {
    return refuse(`goal: keys=${isRecord(goal) ? Object.keys(goal).join(",") : typeof goal} intent=${String(isRecord(goal) ? goal.intent : "")} borrowing=${String(isRecord(goal) ? goal.borrowing : "")}`);
  }
  /**
   * A literal action is kept only when it is exactly that — a supported op, a registry
   * asset, a decimal amount and the quote it came from. One that is not ("amount: all")
   * is dropped and counted, like a malformed plan; it must not void the research and the
   * plans beside it (13 Sep: "use my AqUSDC in Earn as collateral" died here).
   */
  const actionRows = goal.actions === undefined ? [] : Array.isArray(goal.actions) ? goal.actions.slice(0, 8) : [];
  /**
   * A stated action is a plan leg plus the sentence it came from, validated by the very
   * same `parseLeg`. It used to be validated separately against `{op, asset, amount,
   * sourceQuote}` — a bare decimal — which silently dropped every instruction a leg could
   * express but that shape could not: "borrow 2x" (leverage is a sizing word, and "2x"
   * failed the decimal test) and "SOUSDC and XLM in Soroswap" (no field for the paired
   * asset or the DEX, and `exactKeys` rejects unknown keys). Those instructions then had
   * to survive as free-form `plans` or not at all, which is how a precise multi-leg
   * request came back as unrelated ranked options.
   */
  const validActions = actionRows.flatMap((action) => {
    const leg = parseLeg(action, ["sourceQuote"]);
    if (!leg || !isRecord(action) || !text(action.sourceQuote, 1600)) return [];
    return [{ ...leg, sourceQuote: String(action.sourceQuote) }];
  });
  const droppedActions = (goal.actions === undefined ? 0 : Array.isArray(goal.actions) ? goal.actions.length : 1) - validActions.length;
  const write = goal.write === undefined || goal.write === null ? undefined
    : isRecord(goal.write) && exactKeys(goal.write, ["op", "sourceQuote"]) &&
      isLifecycleWriteOp(String(goal.write.op)) && text(goal.write.sourceQuote, 1600)
      ? { op: goal.write.op as (typeof LIFECYCLE_WRITES)[number], sourceQuote: String(goal.write.sourceQuote) }
      : undefined;
  // A floor is a literal: the exact decimal, inside a quote of the user's message. Anything else is no floor.
  /**
   * Accepted only when the model quotes the user saying it. The quote is checked against
   * the message itself by the caller's existing anchoring, so "the user accepted a loss"
   * cannot be something the model decided on their behalf — the one thing that must not
   * be inferred here is consent.
   */
  const slippage = goal.slippageAccepted === undefined || goal.slippageAccepted === null ? undefined
    : isRecord(goal.slippageAccepted) && exactKeys(goal.slippageAccepted, ["accepted", "sourceQuote"]) &&
      goal.slippageAccepted.accepted === true && text(goal.slippageAccepted.sourceQuote, 400)
      ? { accepted: true, sourceQuote: goal.slippageAccepted.sourceQuote }
      : undefined;
  const floor = goal.healthFactorFloor === undefined || goal.healthFactorFloor === null ? undefined
    : isRecord(goal.healthFactorFloor) && exactKeys(goal.healthFactorFloor, ["value", "sourceQuote"]) &&
      typeof goal.healthFactorFloor.value === "string" && /^\d+(\.\d{1,6})?$/.test(goal.healthFactorFloor.value) &&
      text(goal.healthFactorFloor.sourceQuote, 400) && goal.healthFactorFloor.sourceQuote.includes(goal.healthFactorFloor.value)
      ? { value: goal.healthFactorFloor.value, sourceQuote: goal.healthFactorFloor.sourceQuote }
      : undefined;
  /**
   * Each reserve is kept only when it is exactly that: a registry token, a decimal, and a
   * quote that contains the decimal. One malformed entry is dropped on its own; it does not
   * void the goal. Whether the quote is really the user's is checked against their messages
   * by the caller, as for the floor.
   */
  // Kept only when well formed; whether the quote is really the user's is checked by the caller.
  const relation = isRecord(goal.planRelation) && exactKeys(goal.planRelation, ["kind", "sourceQuote"]) &&
    (goal.planRelation.kind === "alternatives" || goal.planRelation.kind === "parts") && text(goal.planRelation.sourceQuote, 400)
    ? { kind: goal.planRelation.kind as "alternatives" | "parts", sourceQuote: goal.planRelation.sourceQuote } : undefined;
  const trigger = goal.trigger === undefined || goal.trigger === null ? undefined
    : isRecord(goal.trigger) && goal.trigger.kind === "none" && exactKeys(goal.trigger, ["kind"])
      ? { kind: "none" as const }
      // Kept even without a usable quote: the refusal fails safe (conditional-guard.ts).
      : isRecord(goal.trigger) && goal.trigger.kind === "future_condition"
        ? { kind: "future_condition" as const, ...(text(goal.trigger.sourceQuote, 400) ? { sourceQuote: String(goal.trigger.sourceQuote) } : {}) }
        : undefined;
  const reserves = Array.isArray(goal.walletReserves) ? goal.walletReserves.slice(0, 8).flatMap((row) =>
    isRecord(row) && exactKeys(row, ["asset", "amount", "sourceQuote"]) &&
      (ASSET_IDS as readonly string[]).includes(String(row.asset)) &&
      typeof row.amount === "string" && /^\d+(\.\d{1,18})?$/.test(row.amount) &&
      text(row.sourceQuote, 400) && row.sourceQuote.includes(row.amount)
      ? [{ asset: String(row.asset), amount: row.amount, sourceQuote: row.sourceQuote }] : []) : [];
  if (!Array.isArray(raw.findings) || raw.findings.length === 0 || raw.findings.length > 12 ||
    !texts(raw.openQuestions)) return refuse(`findings/openQuestions: findings=${Array.isArray(raw.findings) ? raw.findings.length : typeof raw.findings}`);
  /**
   * Plans are optional and additive. A malformed plan must not void the research it
   * rides on — the goal, findings and reads are still good — so the bad ones are dropped
   * and counted, and the service tells the user that some proposed shapes could not be read.
   */
  const parsedPlans = raw.plans === undefined ? { plans: [], dropped: 0, reasons: [] as string[] } : parsePlans(raw.plans);
  const findings: Array<{ summary: string; evidenceIds: string[] }> = [];
  /**
   * What the evidence rule protects is figures: a balance, a rate or a health number the
   * user reads must trace to a read. Prose does not — and the prompt asks for prose with
   * nothing to cite when the goal needs an operation outside the vocabulary ("say so in
   * findings as a limitation"). So an uncited finding is kept when it states no figure,
   * and an uncited figure is dropped and counted, like a malformed plan; it voids the
   * research only when nothing else remains. 13 Sep: "put my XLM and USDC into the
   * Aquarius LP" produced exactly the limitation asked for, and the whole turn died as
   * "invalid decision" because that sentence had no evidence id.
   */
  /**
   * "Nothing else remains" has to mean plans too. This counted stated ACTIONS only, so a
   * strategy turn that composed its plans and wrote one uncited figure beside them was
   * refused whole and the plans went with it — the same shape of loss the note above
   * describes, in the branch it did not cover. 15 Sep: "remove 26k XLM liquidity from
   * blend pool and swap 5k xlm to AqUSDC" sized two legs and died as "invalid decision".
   */
  const allowEmptyEvidence = goal.intent === "answer" || validActions.length > 0 || parsedPlans.plans.length > 0 || !!write;
  let droppedFindings = 0;
  for (const finding of raw.findings) {
    if (!isRecord(finding) || !exactKeys(finding, ["summary", "evidenceIds"]) ||
      !text(finding.summary) || !texts(finding.evidenceIds)) {
      return refuse(`finding: ${isRecord(finding) ? `keys=${Object.keys(finding).join(",")} evidence=${Array.isArray(finding.evidenceIds) ? finding.evidenceIds.length : "?"}` : typeof finding}`);
    }
    if (!allowEmptyEvidence && finding.evidenceIds.length === 0 && /\d/.test(finding.summary)) { droppedFindings += 1; continue; }
    findings.push({ summary: finding.summary, evidenceIds: [...finding.evidenceIds] });
  }
  if (!findings.length) return refuse(`findings: every finding stated a figure with no evidence (${droppedFindings})`);
  return {
    kind: "research_complete",
    goal: {
      ...(goal.intent ? { intent: goal.intent as "answer" | "strategy" } : {}),
      ...(goal.relation ? { relation: goal.relation as "new" | "refine" } : {}),
      ...(validActions.length ? { actions: structuredClone(validActions) as NonNullable<Extract<ResearchDecision, { kind: "research_complete" }>["goal"]["actions"]> } : {}),
      ...(write ? { write } : {}),
      ...(floor ? { healthFactorFloor: floor } : {}),
      ...(slippage ? { slippageAccepted: slippage } : {}),
      ...(reserves.length ? { walletReserves: reserves } : {}),
      ...(relation ? { planRelation: relation } : {}),
      ...(trigger ? { trigger } : {}),
      objective: goal.objective,
      constraints: [...goal.constraints],
      borrowing: goal.borrowing as "unspecified" | "allowed" | "required" | "forbidden",
    },
    findings,
    openQuestions: [...raw.openQuestions],
    ...(parsedPlans.plans.length ? { plans: parsedPlans.plans } : {}),
    ...(parsedPlans.dropped + droppedActions ? { droppedPlans: parsedPlans.dropped + droppedActions } : {}),
    ...(parsedPlans.reasons.length ? { droppedPlanReasons: parsedPlans.reasons } : {}),
    ...(droppedFindings ? { droppedFindings } : {}),
  };
}

/**
 * Plans are shapes only. A leg with a number outside `literal`, an op outside the
 * vocabulary, an asset outside the registry, or a sizing word nobody defined makes the
 * whole decision invalid — the loop then stops with `invalid_decision` rather than
 * letting a half-understood plan reach the sizer.
 */
/**
 * Why the last plan, leg or sizing was dropped, in the validator's own terms. Recorded so a
 * dropped plan can be diagnosed from the result (23 Sep, XS5: both unwind plans vanished as
 * "could not be read" with nothing to say which rule fired). Never shown to the user as is.
 */
let lastPlanDrop = "";
function drop(why: string): null { lastPlanDrop = why; return null; }

function parsePlans(raw: unknown): { plans: ProposedPlan[]; dropped: number; reasons: string[] } {
  if (!Array.isArray(raw)) return { plans: [], dropped: 1, reasons: [`plans is ${typeof raw}, not a list`] };
  const plans: ProposedPlan[] = [];
  const reasons: string[] = [];
  for (const plan of raw.slice(0, MAX_PLANS)) {
    lastPlanDrop = "";
    const parsed = parsePlan(plan);
    if (parsed) plans.push(parsed);
    else reasons.push(`${isRecord(plan) && typeof plan.title === "string" ? plan.title.slice(0, 60) : "untitled"}: ${lastPlanDrop || "rejected"}`);
  }
  const overflow = Math.max(0, raw.length - MAX_PLANS);
  if (overflow) reasons.push(`${overflow} over the ${MAX_PLANS}-plan limit`);
  return { plans, dropped: raw.slice(0, MAX_PLANS).length - plans.length + overflow, reasons };
}

function parsePlan(plan: unknown): ProposedPlan | null {
  if (!isRecord(plan) || !exactKeys(plan, ["title", "rationale", "evidenceIds", "legs"]) ||
    !text(plan.title, 120) || !text(plan.rationale, 1600) || !texts(plan.evidenceIds) ||
    !Array.isArray(plan.legs) || plan.legs.length === 0 || plan.legs.length > MAX_LEGS) return drop(`plan: keys ${isRecord(plan) ? Object.keys(plan).join(",") : typeof plan}, legs ${isRecord(plan) && Array.isArray(plan.legs) ? plan.legs.length : "missing"} (limit ${MAX_LEGS})`);
  const legs: PlanLeg[] = [];
  for (const leg of plan.legs) {
    const parsed = parseLeg(leg);
    if (!parsed) return drop(`leg ${legs.length + 1}: ${lastPlanDrop}`);
    legs.push(parsed);
  }
  return { title: plan.title, rationale: plan.rationale, evidenceIds: [...plan.evidenceIds], legs };
}

/**
 * Validate one leg — the single definition of what a leg may contain.
 *
 * Shared with the `goal.actions` validator rather than duplicated there. The two used to
 * enforce different shapes: a plan leg could carry `sizing`, `assetOut` and `venue` while
 * a stated action was limited to a bare decimal `amount`, so an instruction the plan
 * contract could express perfectly well was rejected on the way in. Two copies of "what a
 * leg is" is what let that gap open, so there is one copy now and `extraKeys` lets the
 * action validator add its own `sourceQuote` without restating anything else.
 */
function parseLeg(leg: unknown, extraKeys: readonly string[] = []): PlanLeg | null {
  if (!isRecord(leg)) return drop("not an object");
  /**
   * `assetOut` and the DEX `venue` belong to the ops that name a SECOND asset — a swap
   * ends in a different one, add_liquidity spends a paired token. Any other op carrying
   * them is malformed, not tolerated: the leg is rejected, as with every unknown key.
   */
  const hasAssetOut = (ASSET_OUT_OPS as readonly string[]).includes(String(leg.op));
  /**
   * An op that leaves or enters an LP pool also names a DEX, even with one asset: 24 Sep,
   * X14, the model wrote `remove_liquidity AQUSDC venue aquarius` and the whole plan was
   * dropped for the extra key. Read off the op's own pocket (OP_FLOW), not a list of ops.
   */
  const flow = Object.hasOwn(OP_FLOW, String(leg.op)) ? OP_FLOW[leg.op as WorkflowOp] : null;
  const touchesLp = flow !== null && (flow.from === "lp" || flow.to === "lp");
  // `venue` is the one optional key on a leg: absent means the registry picks the DEX.
  const allowed = [
    "op", "asset", "sizing",
    ...(hasAssetOut ? ["assetOut"] : []),
    ...((hasAssetOut || touchesLp) && Object.hasOwn(leg, "venue") ? ["venue"] : []),
    ...extraKeys,
  ];
  if (!exactKeys(leg, allowed) ||
    !(PLAN_OPS as readonly string[]).includes(String(leg.op)) ||
    !(ASSET_IDS as readonly string[]).includes(String(leg.asset))) return drop(`${String(leg.op)} ${String(leg.asset)}: keys ${Object.keys(leg).join(",")} (allowed ${allowed.join(",")}); op or asset must be known`);
  const sizing = parseSizing(leg.sizing);
  if (!sizing) return drop(`${String(leg.op)} ${String(leg.asset)}: ${lastPlanDrop}`);
  // `amountAsset` chooses between the leg's TWO assets, so it is meaningless — and a sign
  // the leg was misunderstood — on an op that has only one. Derived from the same
  // ASSET_OUT_OPS property as `assetOut` itself rather than naming the ops again.
  if (!hasAssetOut && sizing.kind === "literal" && sizing.amountAsset !== undefined) return drop(`${String(leg.op)} ${String(leg.asset)}: amountAsset on an op with one asset`);
  if (!hasAssetOut) {
    /**
     * With one asset the pool is the registry's, not the model's: the venue stands only
     * when it names the one pool that holds that asset, and is then redundant. A venue
     * that disagrees, or an asset in several pools, is refused rather than ignored, since
     * ignoring it could act on a different pool than the user meant.
     */
    if (leg.venue !== undefined) {
      const pools = lpPairs().filter(({ tokens }) => tokens.includes(String(leg.asset) as never));
      if (pools.length !== 1 || pools[0].venue !== leg.venue) return drop(`${String(leg.op)} ${String(leg.asset)}: venue ${String(leg.venue)} is not the one pool that holds ${String(leg.asset)}`);
    }
    return { op: leg.op as PlanOp, asset: String(leg.asset), sizing };
  }
  // The second asset must be a known one, and not the one the leg already spends.
  if (!(ASSET_IDS as readonly string[]).includes(String(leg.assetOut)) || leg.assetOut === leg.asset) return drop(`${String(leg.op)} ${String(leg.asset)}: assetOut ${String(leg.assetOut)} is unknown or the same asset`);
  if (leg.venue !== undefined && !(lpVenues() as readonly string[]).includes(String(leg.venue))) return drop(`${String(leg.op)} ${String(leg.asset)}: venue ${String(leg.venue)} is not an LP venue`);
  return {
    op: leg.op as PlanOp, asset: String(leg.asset), sizing, assetOut: String(leg.assetOut),
    ...(leg.venue ? { venue: leg.venue as LpVenue } : {}),
  };
}

function parseSizing(raw: unknown): PlanSizing | null {
  // The declared schema sends sizing as a flat object; a bare word is accepted too.
  const value = typeof raw === "string" ? { kind: raw } : raw;
  if (!isRecord(value) || !(PLAN_SIZINGS as readonly string[]).includes(String(value.kind))) return drop(`sizing kind ${isRecord(value) ? String(value.kind) : typeof value} is not a sizing word`);
  if (value.kind === "fraction") {
    if (!exactKeys(value, ["kind", "percent", "of", "sourceQuote"]) || typeof value.percent !== "string" ||
      !/^\d+(\.\d{1,6})?$/.test(value.percent) || Number(value.percent) <= 0 || Number(value.percent) > 100 ||
      (value.of !== "idle" && value.of !== "position") || !text(value.sourceQuote, 1600)) return drop(`fraction sizing malformed: ${JSON.stringify(value)?.slice(0, 160)}`);
    return { kind: "fraction", percent: value.percent, of: value.of, sourceQuote: value.sourceQuote };
  }
  if (value.kind === "leverage") {
    // Upper-bounded generously; the sizer's own floor-projection is what actually stops an
    // unsafe multiple — this is only proof the model did not invent an absurd digit string.
    if (!exactKeys(value, ["kind", "multiple", "sourceQuote"]) || typeof value.multiple !== "string" ||
      !/^\d+(\.\d{1,3})?$/.test(value.multiple) || Number(value.multiple) <= 1 || Number(value.multiple) > 100 ||
      !text(value.sourceQuote, 1600)) return drop(`leverage sizing malformed: ${JSON.stringify(value)?.slice(0, 160)}`);
    return { kind: "leverage", multiple: value.multiple, sourceQuote: value.sourceQuote };
  }
  if (value.kind !== "literal") return exactKeys(value, ["kind"]) ? { kind: value.kind as "all_idle" | "all_position" | "to_floor" | "previous_leg" } : drop(`sizing ${String(value.kind)} takes no other keys, got ${Object.keys(value).join(",")}`);
  // amountAsset is optional — every non-swap leg, and the ordinary "spend" swap, omit it.
  const hasAmountAsset = Object.hasOwn(value, "amountAsset");
  const literalKeys = hasAmountAsset ? ["kind", "amount", "sourceQuote", "amountAsset"] : ["kind", "amount", "sourceQuote"];
  if (!exactKeys(value, literalKeys) || typeof value.amount !== "string" ||
    value.amount.length > 60 || !/^\d+(\.\d{1,18})?$/.test(value.amount) || !text(value.sourceQuote, 1600) ||
    (hasAmountAsset && value.amountAsset !== "asset" && value.amountAsset !== "assetOut")) return drop(`literal sizing malformed: ${JSON.stringify(value)?.slice(0, 160)}`);
  return {
    kind: "literal", amount: value.amount, sourceQuote: value.sourceQuote,
    ...(hasAmountAsset ? { amountAsset: value.amountAsset as "asset" | "assetOut" } : {}),
  };
}
