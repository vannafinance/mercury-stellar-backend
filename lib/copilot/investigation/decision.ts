import { ASSET_IDS } from "../registry/assets";
import { WORKFLOW_OPS } from "../workflow/types";
import type { PlanLeg, PlanOp, PlanSizing, ProposedPlan, ReadRequest, ResearchDecision } from "./types";

export const PLAN_OPS: readonly PlanOp[] = WORKFLOW_OPS;
/** The sizing words a leg may carry. `plan.ts` gives each one its meaning; the prompt lists them from here. */
export const PLAN_SIZINGS = ["all_idle", "all_position", "to_floor", "previous_leg", "literal"] as const;
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

/** Strict boundary for model output, regardless of provider schema enforcement. */
export function parseDecision(raw: unknown): ResearchDecision | null {
  if (!isRecord(raw)) return null;
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
        !text(read.capability, 80) || !isRecord(read.args)) return null;
      reads.push({ capability: read.capability, args: { ...read.args } });
    }
    // A batch that names the same capability+args twice would burn budget on a duplicate.
    const keys = reads.map((read) => JSON.stringify([read.capability, read.args]));
    if (new Set(keys).size !== keys.length) return null;
    return { kind: "inspect", reads };
  }
  if (raw.kind === "clarify" && exactKeys(raw, ["kind", "question"]) && text(raw.question)) {
    return { kind: "clarify", question: raw.question };
  }
  if (raw.kind === "blocked" && exactKeys(raw, ["kind", "reason"]) && text(raw.reason)) {
    return { kind: "blocked", reason: raw.reason };
  }
  if (raw.kind !== "research_complete" || !exactKeys(raw, ["kind", "goal", "findings", "openQuestions", ...(Object.hasOwn(raw, "plans") ? ["plans"] : [])])) return null;
  const goal = raw.goal;
  if (!isRecord(goal) || !exactKeys(goal, ["objective", "constraints", "borrowing", ...(Object.hasOwn(goal, "intent") ? ["intent"] : []), ...(Object.hasOwn(goal, "relation") ? ["relation"] : []), ...(Object.hasOwn(goal, "actions") ? ["actions"] : []), ...(Object.hasOwn(goal, "healthFactorFloor") ? ["healthFactorFloor"] : [])]) ||
    (goal.relation !== undefined && !["new", "refine"].includes(String(goal.relation))) ||
    (goal.intent !== undefined && !["answer", "strategy"].includes(String(goal.intent))) ||
    !text(goal.objective) || !texts(goal.constraints) ||
    !["unspecified", "allowed", "required", "forbidden"].includes(String(goal.borrowing))) return null;
  if (goal.actions !== undefined && (!Array.isArray(goal.actions) || goal.actions.length > 8 || !goal.actions.every(action =>
    isRecord(action) && exactKeys(action, ["op", "asset", "amount", "sourceQuote"]) &&
    (WORKFLOW_OPS as readonly string[]).includes(String(action.op)) &&
    (ASSET_IDS as readonly string[]).includes(String(action.asset)) &&
    typeof action.amount === "string" && action.amount.length <= 60 && /^\d+(\.\d{1,18})?$/.test(action.amount) &&
    text(action.sourceQuote, 1600)))) return null;
  // A floor is a literal: the exact decimal, inside a quote of the user's message. Anything else is no floor.
  const floor = goal.healthFactorFloor === undefined || goal.healthFactorFloor === null ? undefined
    : isRecord(goal.healthFactorFloor) && exactKeys(goal.healthFactorFloor, ["value", "sourceQuote"]) &&
      typeof goal.healthFactorFloor.value === "string" && /^\d+(\.\d{1,6})?$/.test(goal.healthFactorFloor.value) &&
      text(goal.healthFactorFloor.sourceQuote, 400) && goal.healthFactorFloor.sourceQuote.includes(goal.healthFactorFloor.value)
      ? { value: goal.healthFactorFloor.value, sourceQuote: goal.healthFactorFloor.sourceQuote }
      : undefined;
  if (!Array.isArray(raw.findings) || raw.findings.length === 0 || raw.findings.length > 12 ||
    !texts(raw.openQuestions)) return null;
  /**
   * Plans are optional and additive. A malformed plan must not void the research it
   * rides on — the goal, findings and reads are still good — so the bad ones are dropped
   * and counted, and the service tells the user that some proposed shapes could not be read.
   */
  const parsedPlans = raw.plans === undefined ? { plans: [], dropped: 0 } : parsePlans(raw.plans);
  const findings: Array<{ summary: string; evidenceIds: string[] }> = [];
  const allowEmptyEvidence = goal.intent === "answer"
    || (Array.isArray(goal.actions) && goal.actions.length > 0);
  for (const finding of raw.findings) {
    if (!isRecord(finding) || !exactKeys(finding, ["summary", "evidenceIds"]) ||
      !text(finding.summary) || !texts(finding.evidenceIds) ||
      (!allowEmptyEvidence && finding.evidenceIds.length === 0)) return null;
    findings.push({ summary: finding.summary, evidenceIds: [...finding.evidenceIds] });
  }
  return {
    kind: "research_complete",
    goal: {
      ...(goal.intent ? { intent: goal.intent as "answer" | "strategy" } : {}),
      ...(goal.relation ? { relation: goal.relation as "new" | "refine" } : {}),
      ...(goal.actions ? { actions: structuredClone(goal.actions) as NonNullable<Extract<ResearchDecision, { kind: "research_complete" }>["goal"]["actions"]> } : {}),
      ...(floor ? { healthFactorFloor: floor } : {}),
      objective: goal.objective,
      constraints: [...goal.constraints],
      borrowing: goal.borrowing as "unspecified" | "allowed" | "required" | "forbidden",
    },
    findings,
    openQuestions: [...raw.openQuestions],
    ...(parsedPlans.plans.length ? { plans: parsedPlans.plans } : {}),
    ...(parsedPlans.dropped ? { droppedPlans: parsedPlans.dropped } : {}),
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
    if (!isRecord(leg) || !exactKeys(leg, ["op", "asset", "sizing"]) ||
      !(PLAN_OPS as readonly string[]).includes(String(leg.op)) ||
      !(ASSET_IDS as readonly string[]).includes(String(leg.asset))) return null;
    const sizing = parseSizing(leg.sizing);
    if (!sizing) return null;
    legs.push({ op: leg.op as PlanOp, asset: String(leg.asset), sizing });
  }
  return { title: plan.title, rationale: plan.rationale, evidenceIds: [...plan.evidenceIds], legs };
}

function parseSizing(raw: unknown): PlanSizing | null {
  // The declared schema sends sizing as a flat object; a bare word is accepted too.
  const value = typeof raw === "string" ? { kind: raw } : raw;
  if (!isRecord(value) || !(PLAN_SIZINGS as readonly string[]).includes(String(value.kind))) return null;
  if (value.kind !== "literal") return exactKeys(value, ["kind"]) ? { kind: value.kind as "all_idle" | "all_position" | "to_floor" | "previous_leg" } : null;
  if (!exactKeys(value, ["kind", "amount", "sourceQuote"]) || typeof value.amount !== "string" ||
    value.amount.length > 60 || !/^\d+(\.\d{1,18})?$/.test(value.amount) || !text(value.sourceQuote, 1600)) return null;
  return { kind: "literal", amount: value.amount, sourceQuote: value.sourceQuote };
}
