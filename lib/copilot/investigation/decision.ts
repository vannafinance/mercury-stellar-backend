import { lpVenues, type LpVenue, ASSET_IDS } from "../registry/assets";
import { ASSET_OUT_OPS, WORKFLOW_OPS } from "../workflow/types";
import { LIFECYCLE_WRITES, isLifecycleWriteOp } from "../workflow/lifecycle";
import type { PlanLeg, PlanOp, PlanSizing, ProposedPlan, ReadRequest, ResearchDecision } from "./types";

export const PLAN_OPS: readonly PlanOp[] = WORKFLOW_OPS;
/** The sizing words a leg may carry. `plan.ts` gives each one its meaning; the prompt lists them from here. */
export const PLAN_SIZINGS = ["all_idle", "all_position", "to_floor", "previous_leg", "literal", "fraction", "leverage"] as const;
const MAX_PLANS = 3;
const MAX_LEGS = 6;

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
  if (raw.kind === "clarify" && exactKeys(raw, ["kind", "question"]) && text(raw.question)) {
    return { kind: "clarify", question: raw.question };
  }
  if (raw.kind === "blocked" && exactKeys(raw, ["kind", "reason"]) && text(raw.reason)) {
    return { kind: "blocked", reason: raw.reason };
  }
  if (raw.kind !== "research_complete" || !exactKeys(raw, ["kind", "goal", "findings", "openQuestions", ...(Object.hasOwn(raw, "plans") ? ["plans"] : [])])) {
    return refuse(`unknown kind or keys: kind=${String(raw.kind)} keys=${Object.keys(raw).join(",")}`);
  }
  const goal = raw.goal;
  if (!isRecord(goal) || !exactKeys(goal, ["objective", "constraints", "borrowing", ...(Object.hasOwn(goal, "intent") ? ["intent"] : []), ...(Object.hasOwn(goal, "relation") ? ["relation"] : []), ...(Object.hasOwn(goal, "actions") ? ["actions"] : []), ...(Object.hasOwn(goal, "write") ? ["write"] : []), ...(Object.hasOwn(goal, "healthFactorFloor") ? ["healthFactorFloor"] : []), ...(Object.hasOwn(goal, "slippageAccepted") ? ["slippageAccepted"] : [])]) ||
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
  if (!Array.isArray(raw.findings) || raw.findings.length === 0 || raw.findings.length > 12 ||
    !texts(raw.openQuestions)) return refuse(`findings/openQuestions: findings=${Array.isArray(raw.findings) ? raw.findings.length : typeof raw.findings}`);
  /**
   * Plans are optional and additive. A malformed plan must not void the research it
   * rides on — the goal, findings and reads are still good — so the bad ones are dropped
   * and counted, and the service tells the user that some proposed shapes could not be read.
   */
  const parsedPlans = raw.plans === undefined ? { plans: [], dropped: 0 } : parsePlans(raw.plans);
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
      objective: goal.objective,
      constraints: [...goal.constraints],
      borrowing: goal.borrowing as "unspecified" | "allowed" | "required" | "forbidden",
    },
    findings,
    openQuestions: [...raw.openQuestions],
    ...(parsedPlans.plans.length ? { plans: parsedPlans.plans } : {}),
    ...(parsedPlans.dropped + droppedActions ? { droppedPlans: parsedPlans.dropped + droppedActions } : {}),
    ...(droppedFindings ? { droppedFindings } : {}),
  };
}

/**
 * Plans are shapes only. A leg with a number outside `literal`, an op outside the
 * vocabulary, an asset outside the registry, or a sizing word nobody defined makes the
 * whole decision invalid — the loop then stops with `invalid_decision` rather than
 * letting a half-understood plan reach the sizer.
 */
function parsePlans(raw: unknown): { plans: ProposedPlan[]; dropped: number } {
  if (!Array.isArray(raw)) return { plans: [], dropped: 1 };
  const plans: ProposedPlan[] = [];
  let dropped = 0;
  for (const plan of raw.slice(0, MAX_PLANS)) {
    const parsed = parsePlan(plan);
    if (parsed) plans.push(parsed);
    else dropped += 1;
  }
  return { plans, dropped: dropped + Math.max(0, raw.length - MAX_PLANS) };
}

function parsePlan(plan: unknown): ProposedPlan | null {
  if (!isRecord(plan) || !exactKeys(plan, ["title", "rationale", "evidenceIds", "legs"]) ||
    !text(plan.title, 120) || !text(plan.rationale, 1600) || !texts(plan.evidenceIds) ||
    !Array.isArray(plan.legs) || plan.legs.length === 0 || plan.legs.length > MAX_LEGS) return null;
  const legs: PlanLeg[] = [];
  for (const leg of plan.legs) {
    const parsed = parseLeg(leg);
    if (!parsed) return null;
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
  if (!isRecord(leg)) return null;
  /**
   * `assetOut` and the DEX `venue` belong to the ops that name a SECOND asset — a swap
   * ends in a different one, add_liquidity spends a paired token. Any other op carrying
   * them is malformed, not tolerated: the leg is rejected, as with every unknown key.
   */
  const hasAssetOut = (ASSET_OUT_OPS as readonly string[]).includes(String(leg.op));
  // `venue` is the one optional key on a leg: absent means the registry picks the DEX.
  const allowed = [
    "op", "asset", "sizing",
    ...(hasAssetOut ? ["assetOut"] : []),
    ...(hasAssetOut && Object.hasOwn(leg, "venue") ? ["venue"] : []),
    ...extraKeys,
  ];
  if (!exactKeys(leg, allowed) ||
    !(PLAN_OPS as readonly string[]).includes(String(leg.op)) ||
    !(ASSET_IDS as readonly string[]).includes(String(leg.asset))) return null;
  const sizing = parseSizing(leg.sizing);
  if (!sizing) return null;
  if (!hasAssetOut) return { op: leg.op as PlanOp, asset: String(leg.asset), sizing };
  // The second asset must be a known one, and not the one the leg already spends.
  if (!(ASSET_IDS as readonly string[]).includes(String(leg.assetOut)) || leg.assetOut === leg.asset) return null;
  if (leg.venue !== undefined && !(lpVenues() as readonly string[]).includes(String(leg.venue))) return null;
  return {
    op: leg.op as PlanOp, asset: String(leg.asset), sizing, assetOut: String(leg.assetOut),
    ...(leg.venue ? { venue: leg.venue as LpVenue } : {}),
  };
}

function parseSizing(raw: unknown): PlanSizing | null {
  // The declared schema sends sizing as a flat object; a bare word is accepted too.
  const value = typeof raw === "string" ? { kind: raw } : raw;
  if (!isRecord(value) || !(PLAN_SIZINGS as readonly string[]).includes(String(value.kind))) return null;
  if (value.kind === "fraction") {
    if (!exactKeys(value, ["kind", "percent", "of", "sourceQuote"]) || typeof value.percent !== "string" ||
      !/^\d+(\.\d{1,6})?$/.test(value.percent) || Number(value.percent) <= 0 || Number(value.percent) > 100 ||
      (value.of !== "idle" && value.of !== "position") || !text(value.sourceQuote, 1600)) return null;
    return { kind: "fraction", percent: value.percent, of: value.of, sourceQuote: value.sourceQuote };
  }
  if (value.kind === "leverage") {
    // Upper-bounded generously; the sizer's own floor-projection is what actually stops an
    // unsafe multiple — this is only proof the model did not invent an absurd digit string.
    if (!exactKeys(value, ["kind", "multiple", "sourceQuote"]) || typeof value.multiple !== "string" ||
      !/^\d+(\.\d{1,3})?$/.test(value.multiple) || Number(value.multiple) <= 1 || Number(value.multiple) > 100 ||
      !text(value.sourceQuote, 1600)) return null;
    return { kind: "leverage", multiple: value.multiple, sourceQuote: value.sourceQuote };
  }
  if (value.kind !== "literal") return exactKeys(value, ["kind"]) ? { kind: value.kind as "all_idle" | "all_position" | "to_floor" | "previous_leg" } : null;
  // amountAsset is optional — every non-swap leg, and the ordinary "spend" swap, omit it.
  const hasAmountAsset = Object.hasOwn(value, "amountAsset");
  const literalKeys = hasAmountAsset ? ["kind", "amount", "sourceQuote", "amountAsset"] : ["kind", "amount", "sourceQuote"];
  if (!exactKeys(value, literalKeys) || typeof value.amount !== "string" ||
    value.amount.length > 60 || !/^\d+(\.\d{1,18})?$/.test(value.amount) || !text(value.sourceQuote, 1600) ||
    (hasAmountAsset && value.amountAsset !== "asset" && value.amountAsset !== "assetOut")) return null;
  return {
    kind: "literal", amount: value.amount, sourceQuote: value.sourceQuote,
    ...(hasAmountAsset ? { amountAsset: value.amountAsset as "asset" | "assetOut" } : {}),
  };
}
