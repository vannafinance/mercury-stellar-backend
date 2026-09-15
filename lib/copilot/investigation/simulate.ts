/**
 * Propose-time simulation: before a plan is shown, its steps are put to the protocol's
 * own preview — the MCP `preview` actions, which read the RiskEngine's liquidation
 * snapshot and the oracle and ask the contract's `is_borrow_allowed` /
 * `is_withdraw_allowed`, the pool's borrow ceiling and Earn's minimum. The sizer projects
 * with the facts it read; the preview asks the thing that will actually say yes or no.
 *
 * ## What a preview can and cannot tell
 *
 * Every preview answers against the CURRENT chain state. A step whose funds or health
 * depend on an earlier step of the same plan (a Blend supply that takes what the deposit
 * before it put in; a borrow after a deposit that raises health) cannot be previewed
 * truthfully — the preview would refuse what the run would allow. Those steps are
 * `dependent`: the sizer's projection stands for them, and the card says so. Which steps
 * depend on which is read from the op-flow table, not from the op names.
 *
 * ## Honesty rules
 *
 * - A preview the protocol REFUSES removes the option, with the protocol's own sentence.
 * - A preview that could not be made (an older MCP without the action, a timeout) never
 *   blocks: the option stays, labelled not simulated. Silence is not a "yes".
 * - Nothing here changes an amount. A blocked step is a refusal, not a resize.
 */

import type { MCPClient } from "../mcp-client";
import type { Venue } from "../registry/assets";
import { OP_FLOW, SIZED_OPS, type ProposalStep, type WorkflowOp } from "../workflow/types";
import type { Candidate, CandidateSet } from "./candidates";
import { isRecord } from "./decision";
import { interruptible } from "./runtime";
import type { InvestigationScope } from "./types";

const PREVIEW_MS = 15_000;
const CONCURRENCY = 4;

export type StepVerdict = "allowed" | "blocked" | "dependent" | "unavailable";

export interface StepSimulation {
  stepId: string;
  verdict: StepVerdict;
  /** The protocol's own sentence, when it gave one; ours for `dependent` / `unavailable`. */
  reason: string;
  limitingFactor: string | null;
  /** Projected account after the step, as the RiskEngine snapshot arithmetic states it. */
  projected: { collateralUsd: string; debtUsd: string; ltvPct: string; healthy: boolean } | null;
}

export interface PlanSimulation {
  /** `runnable`: every step the chain could be asked about said yes and nothing was left unasked. */
  verdict: "runnable" | "blocked" | "partial" | "unavailable";
  steps: StepSimulation[];
  /** One sentence for the card. */
  summary: string;
}

/** The preview each venue offers, by the legacy name the transport maps to `{ tool, action: "preview" }`. */
const PREVIEW_TOOL: Record<Venue, string | null> = {
  earn: "vanna_preview_earn",
  margin: "vanna_preview_margin",
  blend: null,
  aquarius: null,
  soroswap: null,
};

/** The preview's `operation` word is the op's verb: deposit, withdraw, borrow, repay, lend, redeem. */
function operationOf(op: WorkflowOp): string {
  return op.split("_")[0];
}

/**
 * A step can be previewed against the current state only when nothing before it in the
 * plan changes what the preview would look at: the pocket it draws from, or — for a
 * margin step — the account's health.
 */
export function dependsOnEarlier(steps: readonly ProposalStep[], index: number): boolean {
  const step = steps[index];
  const flow = OP_FLOW[step.op];
  return steps.slice(0, index).some((earlier) => {
    const before = OP_FLOW[earlier.op];
    const feedsIt = earlier.asset === step.asset && before.to === flow.from;
    const movesHealth = flow.venue === "margin" && (SIZED_OPS as readonly string[]).includes(earlier.op);
    return feedsIt || movesHealth;
  });
}

/**
 * A swap's args carry no `symbol`/`amount` at all — `writeArgsFor` built them as
 * `token_in`/`amount_in` (plus `token_out`/`min_out`), since a swap moves two assets, not
 * one. Sourcing the spent side from the op's own argument shape here, and passing the
 * SAME `min_out` the write carries, is what lets `vanna_preview_margin`'s swap branch
 * (PR #6) project the exact trade that gets signed rather than a different one.
 */
function previewArgs(step: ProposalStep, scope: Pick<InvestigationScope, "trader" | "smartAccount">): Record<string, unknown> {
  const base = step.op === "swap"
    ? {
        symbol: String(step.args.token_in), amount: String(step.args.amount_in), operation: operationOf(step.op),
        token_out: String(step.args.token_out),
        ...(typeof step.args.min_out === "string" && step.args.min_out ? { min_out: step.args.min_out } : {}),
      }
    : { symbol: String(step.args.symbol), amount: step.amount, operation: operationOf(step.op) };
  return OP_FLOW[step.op].venue === "earn"
    ? { ...base, holder: scope.trader }
    : { ...base, smart_account: scope.smartAccount };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Read the preview's answer. Anything that is not a clear yes or no is "unavailable". */
function verdictOf(step: ProposalStep, response: unknown): StepSimulation {
  const none = (reason: string): StepSimulation => ({ stepId: step.id, verdict: "unavailable", reason, limitingFactor: null, projected: null });
  if (!isRecord(response)) return none("the protocol preview returned nothing usable");
  if (response.error !== undefined || response.isError === true || response.ok === false) {
    return none(text(response.message) ?? "the protocol preview is not available on this server");
  }
  if (typeof response.allowed !== "boolean") return none("the protocol preview gave no verdict");
  const projected = isRecord(response.projected_position) ? response.projected_position : null;
  return {
    stepId: step.id,
    verdict: response.allowed ? "allowed" : "blocked",
    reason: text(response.reason) ?? (response.allowed ? "permitted by the protocol" : "refused by the protocol"),
    limitingFactor: text(response.limiting_factor),
    projected: projected && text(projected.collateral_usd) && text(projected.debt_usd)
      ? { collateralUsd: String(projected.collateral_usd), debtUsd: String(projected.debt_usd), ltvPct: text(projected.ltv_pct) ?? "", healthy: projected.is_healthy === true }
      : null,
  };
}

async function previewStep(
  step: ProposalStep,
  scope: Pick<InvestigationScope, "trader" | "smartAccount">,
  mcp: Pick<MCPClient, "call">,
  signal: AbortSignal,
): Promise<StepSimulation> {
  const tool = PREVIEW_TOOL[OP_FLOW[step.op].venue];
  if (!tool) return { stepId: step.id, verdict: "unavailable", reason: `the protocol offers no preview for a ${operationOf(step.op)}`, limitingFactor: null, projected: null };
  try {
    const response = await interruptible(
      () => mcp.call(tool, previewArgs(step, scope), scope.trader ?? undefined),
      AbortSignal.any([signal, AbortSignal.timeout(PREVIEW_MS)]),
    );
    return verdictOf(step, response);
  } catch (error) {
    const why = error instanceof Error && error.name === "AbortError" ? "the protocol preview did not answer in time" : "the protocol preview could not be reached";
    return { stepId: step.id, verdict: "unavailable", reason: why, limitingFactor: null, projected: null };
  }
}

function summarise(steps: readonly ProposalStep[], results: StepSimulation[]): PlanSimulation {
  const blocked = results.find((r) => r.verdict === "blocked");
  const label = (id: string) => steps.find((s) => s.id === id)?.label ?? id;
  if (blocked) {
    return { verdict: "blocked", steps: results, summary: `The protocol refuses "${label(blocked.stepId)}": ${blocked.reason}` };
  }
  const allowed = results.filter((r) => r.verdict === "allowed");
  const dependent = results.filter((r) => r.verdict === "dependent");
  const unavailable = results.filter((r) => r.verdict === "unavailable");
  if (!allowed.length) {
    return { verdict: "unavailable", steps: results, summary: unavailable.length
      ? `Not simulated against the protocol: ${unavailable[0].reason}.`
      : "Not simulated against the protocol: every step follows from the one before it, so the projection stands." };
  }
  const said = allowed.map((r) => {
    const after = r.projected ? ` (LTV ${r.projected.ltvPct}% after)` : "";
    return `${label(r.stepId)} allowed${after}`;
  }).join("; ");
  if (!dependent.length && !unavailable.length) return { verdict: "runnable", steps: results, summary: `Simulated against the protocol: ${said}.` };
  const rest = dependent.length && unavailable.length
    ? `${dependent.length + unavailable.length} other step${dependent.length + unavailable.length === 1 ? "" : "s"} could not be simulated ahead`
    : dependent.length
      ? `${dependent.length === 1 ? "the other step follows" : `the other ${dependent.length} steps follow`} from it and stand on the projection`
      : `${unavailable.length === 1 ? "one step" : `${unavailable.length} steps`} could not be simulated`;
  return { verdict: "partial", steps: results, summary: `Simulated against the protocol: ${said}; ${rest}.` };
}

/** Put a plan's steps to the protocol's preview. Never throws; never changes a step. */
export async function simulateSteps(
  steps: readonly ProposalStep[],
  scope: Pick<InvestigationScope, "trader" | "smartAccount">,
  mcp: Pick<MCPClient, "call">,
  signal: AbortSignal,
): Promise<PlanSimulation> {
  const results: StepSimulation[] = await Promise.all(steps.map(async (step, index) =>
    dependsOnEarlier(steps, index)
      ? { stepId: step.id, verdict: "dependent" as const, reason: "follows from the step before it; projected, not simulated", limitingFactor: null, projected: null }
      : previewStep(step, scope, mcp, signal)));
  return summarise(steps, results);
}

/**
 * Simulate every offered option that has steps; an option the protocol refuses moves to
 * the rejected list with the protocol's sentence. Options without steps (the fixed shapes
 * compile theirs at propose time) are simulated there instead.
 */
export async function simulateCandidates(
  set: CandidateSet,
  scope: Pick<InvestigationScope, "trader" | "smartAccount">,
  mcp: Pick<MCPClient, "call">,
  signal: AbortSignal,
): Promise<CandidateSet> {
  const feasible: Candidate[] = [];
  const rejected = [...set.rejected];
  const queue = [...set.feasible];
  const simulated = new Map<string, PlanSimulation>();
  // Bounded fan-out: a handful of options, a few previews each, never a flood of RPC reads.
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (next.steps?.length) simulated.set(next.id, await simulateSteps(next.steps, scope, mcp, signal));
    }
  }));
  for (const candidate of set.feasible) {
    const simulation = simulated.get(candidate.id);
    if (!simulation) { feasible.push(candidate); continue; }
    if (simulation.verdict === "blocked") {
      rejected.push({ label: candidate.label, reason: simulation.summary, asset: candidate.asset });
      continue;
    }
    feasible.push({ ...candidate, simulation });
  }
  return { feasible, rejected };
}
