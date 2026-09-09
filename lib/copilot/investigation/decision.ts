import type { ReadRequest, ResearchDecision } from "./types";

/** Bounded so one decision cannot drain the whole tool budget in a single turn. */
export const MAX_BATCHED_READS = 4;

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
  if (raw.kind !== "research_complete" || !exactKeys(raw, ["kind", "goal", "findings", "openQuestions"])) return null;
  const goal = raw.goal;
  if (!isRecord(goal) || !exactKeys(goal, ["objective", "constraints", "borrowing", ...(Object.hasOwn(goal, "intent") ? ["intent"] : []), ...(Object.hasOwn(goal, "relation") ? ["relation"] : []), ...(Object.hasOwn(goal, "actions") ? ["actions"] : [])]) ||
    (goal.relation !== undefined && !["new", "refine"].includes(String(goal.relation))) ||
    (goal.intent !== undefined && !["answer", "strategy"].includes(String(goal.intent))) ||
    !text(goal.objective) || !texts(goal.constraints) ||
    !["unspecified", "allowed", "required", "forbidden"].includes(String(goal.borrowing))) return null;
  if (goal.actions !== undefined && (!Array.isArray(goal.actions) || goal.actions.length > 8 || !goal.actions.every(action =>
    isRecord(action) && exactKeys(action, ["op", "asset", "amount", "sourceQuote"]) &&
    ["lend", "deposit_collateral", "borrow", "repay", "supply_blend"].includes(String(action.op)) &&
    ["XLM", "BLUSDC", "AQUSDC", "SOUSDC"].includes(String(action.asset)) &&
    typeof action.amount === "string" && action.amount.length <= 60 && /^\d+(\.\d{1,18})?$/.test(action.amount) &&
    text(action.sourceQuote, 1600)))) return null;
  if (!Array.isArray(raw.findings) || raw.findings.length === 0 || raw.findings.length > 12 ||
    !texts(raw.openQuestions)) return null;
  const findings: Array<{ summary: string; evidenceIds: string[] }> = [];
  const allowEmptyEvidence = goal.intent === "answer";
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
      objective: goal.objective,
      constraints: [...goal.constraints],
      borrowing: goal.borrowing as "unspecified" | "allowed" | "required" | "forbidden",
    },
    findings,
    openQuestions: [...raw.openQuestions],
  };
}
