"use client";

import { useEffect, useRef, useState } from "react";
import { CircleAlert, Search } from "lucide-react";
import { VANNA_ICON_SRC } from "@/components/copilot/vanna-icon-data";
import type { ResearchView } from "@/lib/copilot/investigation/view";
import type { InvestigationProgress } from "@/lib/copilot/investigation/types";
import type { WorkflowView } from "@/lib/copilot/workflow/types";
import type { ThreadTurn } from "@/lib/copilot/investigation/thread";
import { completionMatches } from "@/lib/copilot/workflow-completion";
import { ExecutionStepper, type StepperStep } from "@/components/copilot/execution-stepper";
import { SwapIntentPreviewCard, SwapReviewCard } from "@/components/copilot/swap-review-card";
import { PlanReviewCard } from "@/components/copilot/plan-review-card";
import { preparingStatedRun } from "@/components/copilot/preparing-run";
import { REQUESTED_ACTIONS_ID } from "@/lib/copilot/investigation/candidate-id";
import { finished } from "@/hooks/use-workflow";
import { formatRunClock } from "@/lib/copilot/investigation/duration";
import { recommendationReason } from "@/lib/copilot/investigation/recommendation";
import { ChatTurns, REPLY_CARD_GAP_PX } from "@/components/copilot/chat-message";
import { signRefusalCopy } from "@/components/copilot/sign-refusal-copy";

export interface InvestigationCardProps {
  prompt: string;
  result: ResearchView | null;
  progress: InvestigationProgress | null;
  loading: boolean;
  error: string | null;
  turns?: ThreadTurn[];
  /** Workspace already paints the transcript; the card then only holds research/plan. */
  omitTranscript?: boolean;
  /** Act on what was understood - the plan card takes over from here. */
  onContinue?: () => void;
  continueLabel?: string;
  /** Prepare the journal proposal for one of the sized options. */
  onPropose?: (candidateId: string) => void;
  workflow?: WorkflowView | null;
  /**
   * Why the waiting plan no longer holds, from the live re-check. A plan sized minutes ago
   * against a price that has since moved must stop offering Approve, and say why.
   */
  planWithdrawn?: string | null;
  /** The floor the write would use now, when the pool has moved under the sealed one. */
  planLiveFloor?: { minOut: string; note: string } | null;
  workflowError?: string | null;
  workflowLoading?: boolean;
  onApprove?: () => void;
  onResume?: () => void;
  onCancelPlan?: () => void;
  onSign?: () => void;
  wallet?: string | null;
  autoSign?: boolean;
  /**
   * One click on a plan's Approve: prepare it and, once it is prepared, approve it
   * (the workspace chains the two). Falls back to `onPropose` when not given.
   */
  onApproveCandidate?: (candidateId: string) => void;
  /** Send a choice's text as the user's next turn (a "did you mean" button). */
  onReply?: (text: string) => void;
  /** A `write` choice was clicked (e.g. "Open a margin account"). */
  onWrite?: (op: "create_account") => void;
  /**
   * The thread has been told to hide this run's receipt so this card is the one place the
   * run is drawn: the plan card becomes the execution card in the same spot.
   */
  threadDefersReceipt?: boolean;
  /** The workspace has this plan queued for approval and has not sent the request yet. */
  approvalQueued?: boolean;
}

const money = (value: string) =>
  `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The steps of a run being prepared: the first one reads as being checked, the rest wait. */
function preparingSteps(workflow: WorkflowView): StepperStep[] {
  const steps = workflow.steps.map(toStepperStep);
  const first = steps.findIndex((step) => step.status === "pending");
  return steps.map((step, index) => (index === first ? { ...step, status: "claiming" as const } : step));
}

function toStepperStep(step: WorkflowView["steps"][number]): StepperStep {
  const status: StepperStep["status"] =
    step.status === "settled" ? "settled"
      : step.status === "uncertain" ? "uncertain"
        : step.status === "failed" ? "failed"
        : step.status === "awaiting_signature" ? "signing"
          : step.status === "submitted" || step.status === "submitting" ? "submitting"
            : step.status === "invoking" ? "claiming"
              : "pending";
  return {
    id: step.id, label: step.label, op: step.op, asset: step.asset, amount: step.amount,
    status, txHash: step.txHash, ledger: step.settledLedger, error: step.message, refusal: signRefusalCopy(step.signRefusal),
  };
}


/** The rate is shown only when the option earns or pays one; a repay has none, and "0.00% APR" was a false figure. */
function rateOf(candidate: NonNullable<ResearchView["candidates"]>["feasible"][number]): string | null {
  // 23 Sep (owner-approved): quoted as APY, the way the Earn and Farm pages show it (apy.ts).
  // A candidate without the APY figure keeps its APR, labelled as APR, never relabelled.
  if (candidate.netAprPct !== null) {
    const [value, unit] = candidate.netApyPct != null ? [candidate.netApyPct, "APY"] : [candidate.netAprPct, "APR"];
    return `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}% net ${unit}`;
  }
  if (candidate.supplyAprPct === null) return candidate.venue === "margin" ? null : "Rate not read";
  if (!(Number(candidate.supplyAprPct) > 0)) return null;
  return candidate.supplyApyPct != null ? `${Number(candidate.supplyApyPct).toFixed(2)}% APY` : `${Number(candidate.supplyAprPct).toFixed(2)}% APR`;
}

type PlanCandidate = NonNullable<ResearchView["candidates"]>["feasible"][number];
/** Steps a single plan shows before "Show all"; with several plans they stay behind a toggle (mockup boards 5–7). */
const SINGLE_PLAN_PREVIEW_STEPS = 4;

/** Health factor as the plan card states it: where it goes, not just where it ends. */
function healthCell(candidate: PlanCandidate, fallbackBefore: string | null): { value: string; tone: "ok" | "plain" } {
  const fmt = (value: string | null | undefined) =>
    value != null && Number.isFinite(Number(value)) ? Number(value).toFixed(2) : null;
  const before = fmt(candidate.initialHealthFactor ?? candidate.healthFactorBefore ?? fallbackBefore);
  if (candidate.repaysAllDebt) return { value: before ? `${before} → No debt` : "No debt", tone: "ok" };
  const after = fmt(candidate.finalHealthFactor);
  if (before && after) return { value: before === after ? `${before} · unchanged` : `${before} → ${after}`, tone: "plain" };
  return { value: after ?? "unchanged", tone: "plain" };
}

/** A model's paragraph as separate sentences: split where a full stop is followed by a space and a new sentence. */
function sentencesOf(text: string | null | undefined): string[] {
  return (text ?? "").split(/(?<=[.!?])\s+(?=[A-Z])/).map((part) => part.trim()).filter(Boolean);
}

/**
 * What a plan says about itself: the three figures, its steps, and the notes under them. One
 * body for both ways a plan is shown (the lone card and the selected row of a picker), so the
 * two can never drift apart. The figures sit on one line each; on a phone they become rows.
 */
function PlanDetails({
  candidate, lead, beforeHf, previewSteps, stepsOpen, onToggleSteps,
}: {
  candidate: PlanCandidate; lead: boolean; beforeHf: string | null;
  previewSteps: number; stepsOpen: boolean; onToggleSteps: () => void;
}) {
  const health = healthCell(candidate, beforeHf);
  const steps = candidate.steps ?? [];
  const shownSteps = stepsOpen ? steps : steps.slice(0, previewSteps);
  const hiddenCount = steps.length - shownSteps.length;
  const [headline] = sentencesOf(candidate.rationale);
  const cell = "flex items-baseline justify-between gap-3 border-t border-vgray-100 px-3.5 py-2.5 first:border-t-0 sm:flex-col sm:items-start sm:justify-start sm:gap-0.5 sm:border-l sm:border-t-0 sm:first:border-l-0";
  const label = "text-[12px] text-vgray-400 sm:whitespace-nowrap";
  const value = "text-[15px] font-semibold tabular-nums text-vgray-900 sm:whitespace-nowrap";
  return (
    <>
      <dl className="grid grid-cols-1 rounded-xl border border-vgray-100 sm:grid-cols-3">
        <div className={cell}>
          <dt className={label}>Moves</dt>
          <dd className={value}>{money(candidate.amountUsd)}</dd>
        </div>
        <div className={cell}>
          <dt className={label}>Health factor</dt>
          <dd className={`${value} ${health.tone === "ok" ? "!text-[var(--cp-ok-fg)]" : ""}`}>{health.value}</dd>
        </div>
        <div className={cell}>
          <dt className={label}>Transactions</dt>
          <dd className={value}>{Math.max(1, steps.length)}</dd>
        </div>
      </dl>
      {shownSteps.length > 0 && (
        <ol className="flex flex-col" data-testid="plan-steps">
          {shownSteps.map((step, stepIndex) => (
            <li key={step.id} className={`flex items-baseline gap-3 py-2 ${stepIndex === shownSteps.length - 1 ? "" : "border-b border-vgray-50"}`}>
              <span className="w-4 shrink-0 font-mono text-[11.5px] tabular-nums text-vgray-300">{stepIndex + 1}</span>
              <span className="min-w-0 grow break-words text-[13.5px] leading-5 text-vgray-800">{step.label}</span>
            </li>
          ))}
        </ol>
      )}
      {steps.length > 1 && (hiddenCount > 0 || stepsOpen) && (
        <button type="button" onClick={onToggleSteps} className="self-start text-[13px] font-semibold text-violet-500 hover:text-violet-600">
          {stepsOpen ? "Hide steps" : shownSteps.length ? `Show all ${steps.length} steps` : `Show the ${steps.length} steps`}
        </button>
      )}
      {/* The plan's main point in one line. The protocol check is only worth a line when it did not pass cleanly. */}
      {headline && <p className="max-w-[68ch] text-[13px] leading-5 text-vgray-600" data-testid="plan-rationale">{headline}</p>}
      {candidate.simulation && candidate.simulation.verdict !== "runnable" && candidate.simulation.verdict !== "partial" && (
        <p className="max-w-[68ch] text-[12.5px] leading-5 text-vgray-500" data-testid="plan-simulation">{candidate.simulation.summary}</p>
      )}
      {lead && candidate.decision?.reason && <p className="max-w-[68ch] text-[13px] leading-5 text-vgray-700">{candidate.decision.reason}</p>}
    </>
  );
}

/** A plan's title line: its letter when there are several, what it does, and the rate it earns or pays. */
function PlanHeading({ candidate, index, several, selected }: { candidate: PlanCandidate; index: number; several: boolean; selected: boolean }) {
  const rate = rateOf(candidate);
  return (
    <div className="flex min-w-0 grow flex-wrap items-start justify-between gap-x-4 gap-y-1">
      <div className="flex min-w-0 flex-col gap-1">
        {several && (
          <span className="flex items-center gap-2">
            <span className={`text-[12px] font-semibold ${selected ? "text-violet-500" : "text-vgray-400"}`}>Plan {planLetter(index)}</span>
            {/* The plans arrive ranked, best first: the leading one is the recommendation, and the card says so. */}
            {index === 0 && <span data-testid="plan-recommended" className="rounded-full bg-[var(--cp-ok-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--cp-ok-fg)]">Recommended</span>}
          </span>
        )}
        <p className="min-w-0 break-words text-[15.5px] font-semibold leading-[22px] text-vgray-900">{candidate.label}</p>
      </div>
      {rate && <p className="shrink-0 text-[14px] font-semibold tabular-nums text-violet-500">{rate}</p>}
    </div>
  );
}

/**
 * A wait the user can read: after a while on the same step it says that it is taking longer than usual, that nothing has been
 * submitted, and what to do (7 Oct: a plan sat on "Preparing the plan" with no sign of whether anything was happening).
 */
function StillWorking({ afterMs = 20_000 }: { afterMs?: number }) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), afterMs);
    return () => clearTimeout(timer);
  }, [afterMs]);
  return late ? (
    <p role="status" aria-live="polite" className="max-w-[60ch] text-[12.5px] leading-5 text-vgray-500" data-testid="workflow-slow">
      This is taking longer than usual. Nothing has been submitted; if it does not move in a minute, send your request again.
    </p>
  ) : null;
}

/** The one plan on offer: a full card with its own Approve and Cancel. */
function PlanCard({
  candidate, index, several, beforeHf, stepsOpen, onToggleSteps,
  onApprove, onCancel, approveDisabled, cancelDisabled,
}: {
  candidate: PlanCandidate; index: number; several: boolean;
  beforeHf: string | null; stepsOpen: boolean; onToggleSteps: () => void;
  onApprove?: () => void; onCancel: () => void; approveDisabled: boolean; cancelDisabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-vgray-100 bg-surface px-5 py-5 sm:px-6">
      <PlanHeading candidate={candidate} index={index} several={several} selected={false} />
      <PlanDetails candidate={candidate} lead={index === 0} beforeHf={beforeHf} previewSteps={SINGLE_PLAN_PREVIEW_STEPS} stepsOpen={stepsOpen} onToggleSteps={onToggleSteps} />
      {onApprove && (
        <div className="flex gap-2">
          <button type="button" onClick={onApprove} disabled={approveDisabled} className={BTN_PRIMARY}>
            Approve
          </button>
          <button type="button" onClick={onCancel} disabled={cancelDisabled} className={BTN_QUIET}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Two or more plans in one card: a radio row per plan, the chosen one open with its figures and
 * steps, and a single Approve and Cancel for the chosen plan at the bottom. Choosing a row only
 * changes what is shown; Approve and Cancel call exactly what a plan's own buttons called, with
 * that plan's id.
 */
function PlanPicker({
  plans, letterOf, selectedId, onSelect, beforeHf, openSteps, onToggleSteps,
  onApprove, onCancel, approveDisabled, cancelDisabled,
}: {
  plans: PlanCandidate[]; letterOf: (candidate: PlanCandidate) => number; selectedId: string;
  onSelect: (id: string) => void; beforeHf: string | null;
  openSteps: Record<string, boolean>; onToggleSteps: (id: string) => void;
  onApprove?: (id: string) => void; onCancel: (id: string) => void; approveDisabled: boolean; cancelDisabled: boolean;
}) {
  const selected = plans.find((candidate) => candidate.id === selectedId) ?? plans[0];
  const why = recommendationReason(plans);
  const move = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = plans[(plans.findIndex((candidate) => candidate.id === selected.id) + step + plans.length) % plans.length];
    onSelect(next.id);
    event.currentTarget.querySelector<HTMLElement>(`[data-plan-id="${CSS.escape(next.id)}"]`)?.focus();
  };
  return (
    <section aria-label="Plans" className="overflow-hidden rounded-2xl border border-vgray-100 bg-surface">
      <div role="radiogroup" aria-label="Choose a plan" onKeyDown={move}>
        {plans.map((candidate) => {
          const isSelected = candidate.id === selected.id;
          const index = letterOf(candidate);
          return (
            <div key={candidate.id} className="border-t border-vgray-100 first:border-t-0" style={isSelected ? { background: "var(--cp-violet-soft)" } : undefined}>
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                data-plan-id={candidate.id}
                tabIndex={isSelected ? 0 : -1}
                onClick={() => onSelect(candidate.id)}
                className="flex w-full items-start gap-3 px-5 py-4 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-violet-500"
              >
                <span aria-hidden="true" className={`mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-[1.5px] ${isSelected ? "border-violet-500" : "border-vgray-200"}`}>
                  {isSelected && <span className="h-2 w-2 rounded-full bg-violet-500" />}
                </span>
                <PlanHeading candidate={candidate} index={index} several selected={isSelected} />
              </button>
              {/* Outside the radio, so the plan's accessible name stays its own and not the sentence about its rival. */}
              {index === 0 && why && <p data-testid="plan-recommended-why" className="max-w-[68ch] px-5 pb-3 pl-[3.25rem] text-[12.5px] leading-5 text-vgray-500">{why}</p>}
              {isSelected && (
                <div className="flex flex-col gap-4 px-5 pb-5 pl-[3.25rem]">
                  <PlanDetails candidate={candidate} lead={index === 0} beforeHf={beforeHf} previewSteps={0} stepsOpen={!!openSteps[candidate.id]} onToggleSteps={() => onToggleSteps(candidate.id)} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {onApprove && (
        <div className="flex gap-2 border-t border-vgray-100 px-5 py-4">
          <button type="button" onClick={() => onApprove(selected.id)} disabled={approveDisabled} className={BTN_PRIMARY}>
            Approve Plan {planLetter(letterOf(selected))}
          </button>
          <button type="button" onClick={() => onCancel(selected.id)} disabled={cancelDisabled} className={BTN_QUIET}>
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * The server's one-tap choices. A `send` choice replies with text built from the user's own
 * words; a `write` choice starts a lifecycle write (today only opening a margin account), which
 * the workspace runs through the existing `pending_write` path. Never created on its own: only
 * a click on this button opens the account.
 */
function ChoiceButtons({ choices, onReply, onWrite }: {
  choices: ResearchView["choices"];
  onReply?: (text: string) => void;
  onWrite?: (op: "create_account") => void;
}) {
  const usable = (choices ?? []).filter((choice) => (choice.write && onWrite) || (choice.send && onReply));
  if (!usable.length) return null;
  return (
    <div className="mt-2.5 flex flex-wrap gap-2" data-testid="question-choices">
      {usable.map((choice) => (
        <button
          key={choice.id}
          type="button"
          onClick={() => (choice.write && onWrite ? onWrite(choice.write) : onReply!(choice.send!))}
          className={choice.write ? BTN_PRIMARY : BTN_QUIET}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

/** A small heading for a section of the reply. Sentence case, no tracking, no mono. */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[12px] font-semibold text-vgray-500">{children}</h3>;
}

const BTN_PRIMARY = "rounded-r2 bg-gradient px-3.5 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 disabled:cursor-not-allowed disabled:opacity-45";
/** Plan A, Plan B, Plan C: the owner's layout names alternatives, not "Option 1 of 3". */
const planLetter = (index: number) => String.fromCharCode(65 + index);

const BTN_QUIET = "rounded-r2 border border-vgray-100 px-3.5 py-2 text-[13px] font-semibold text-vgray-800 transition-colors hover:border-violet-400 hover:text-violet-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 disabled:cursor-not-allowed disabled:text-vgray-300";

export function InvestigationCard({
  prompt, result: researchResult, progress, loading, error, turns = [], omitTranscript = false, onContinue, continueLabel,
  onPropose, workflow, planWithdrawn, planLiveFloor, workflowError, workflowLoading, onApprove, onSign, onResume, onCancelPlan,
  wallet = null, autoSign = false, onApproveCandidate, onReply, onWrite, threadDefersReceipt = false, approvalQueued = false,
}: InvestigationCardProps) {
  /**
   * Cancel on a plan that was never prepared: nothing was sent, so it only closes the plans
   * for this reply. Keyed by the reply's continuation so a new reply starts open.
   */
  const [dismissed, setDismissed] = useState<{ key: string; ids: string[] } | null>(null);
  /** Plans whose steps are shown in full, and the one opened in a list of three or more. */
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({});
  const [openPlan, setOpenPlan] = useState<string | null>(null);
  const result: ResearchView | null = researchResult ?? (workflow ? {
    status: "researched", message: "Restored your recorded plan.", originalRequest: workflow.objective, refinements: [],
    understanding: null, question: null, facts: [], checks: [], warnings: [], continuation: "", executionAllowed: false,
    scope: { wallet: null, smartAccount: null, network: "testnet" },
  } : null);
  const progressLabel = !progress ? "Starting the investigation"
    : progress.kind === "scope" ? progress.label
      : progress.kind === "reviewing" ? "Working out what to check next"
        : progress.kind === "reading" ? `Reading ${progress.label}`
          : `${progress.label}: ${progress.status === "ok" ? "read" : "unavailable"}`;

  /**
   * Another option may be prepared once the current plan can no longer submit anything:
   * blocked before broadcast, finished, or cancelled. While a plan is proposed, approved,
   * running, awaiting a signature - or uncertain, where a transaction may be in flight -
   * a second plan would race it, so the buttons wait.
   */
  const planInFlight = !!workflow && !finished(workflow);
  /**
   * The thread already draws this run's progress, so drawing it again here is one run
   * shown twice.
   *
   * Live, 22 Sep: "I accept the quoted loss, can you swap 100 XLM to AQUSDC" rendered
   * the swap's EXECUTION PROGRESS stepper in the conversation AND again inside this
   * card, one above the other, both settled, same tx. The workspace copies every
   * `workflow.view` onto the assistant turn as a durable receipt
   * (`executionReceiptFromWorkflowView`), which `ChatTurns` renders - so once that
   * receipt exists, both components are painting the same steps from the same source.
   *
   * `workflowId` is what the receipt is keyed by, so it settles which run a receipt
   * belongs to and the two can never disagree. The receipt wins, matching how the
   * workspace already suppresses its own single-tx stepper when a turn carries one.
   * Only the stepper is dropped: this section's heading, objective, message and its
   * Sign / Check progress / Cancel buttons are not duplicated anywhere and stay.
   */
  const stepperDrawnInThread =
    !!workflow && !threadDefersReceipt &&
    turns.some((turn) => turn.role === "assistant" && turn.executionReceipt?.workflowId === workflow.id);
  /** A stated action has no plan card: the execution card stands in while its approval is prepared. */
  const preparingRun = !!workflow && !!result && preparingStatedRun({
    stated: result.proposalCandidateId === REQUESTED_ACTIONS_ID,
    status: workflow.status,
    hasSwap: !!workflow.swap || workflow.steps.some((step) => step.op === "swap"),
    withdrawn: !!planWithdrawn,
    busy: !!workflowLoading,
    approvalQueued,
  });
  const completionSummaryReady = !!workflow && turns.some((turn) => turn.executionReceipt?.workflowId === workflow.id && completionMatches(turn.executionReceipt, turn.completion));
  /**
   * The run clock. Zeroing it inside the effect made every start a second render pass; a
   * run that begins is a prop change, so the reset belongs in render, where React handles
   * it in the same pass.
   */
  const [elapsedSec, setElapsedSec] = useState(0);
  const [clockRunning, setClockRunning] = useState(loading);
  if (loading !== clockRunning) {
    setClockRunning(loading);
    if (loading) setElapsedSec(0);
  }
  const startedAt = useRef(0);
  useEffect(() => {
    if (!loading) return;
    startedAt.current = Date.now();
    const id = setInterval(() => setElapsedSec(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, [loading]);
  // The running clock beside the progress line. A finished reply carries no "Checked in" line
  // (owner, 29 Sep); the server's timing stays on the view (`elapsedMs`) for diagnostics.
  const deviceClock = elapsedSec > 0 ? formatRunClock(elapsedSec) : null;

  const lastTurn = turns[turns.length - 1];
  /**
   * Hide the previous research while a new user turn is in flight (last row is
   * the question). Empty `turns` still shows `result` so a live research card -
   * and the options tests - keep the sized answer without a matching transcript row.
   */
  const resultIsLatest = !!result && lastTurn?.role !== "user";
  const hasCardContent = Boolean(
    result?.understanding ||
    result?.capacity ||
    result?.swapIntent ||
    (result?.candidates && (result.candidates.feasible.length > 0 || result.candidates.rejected.length > 0)) ||
    workflow ||
    result?.question ||
    !!result?.choices?.length ||
    (result?.warnings && result.warnings.length > 0)
  );

  /** Cancel closes THAT plan only (owner, 24 Sep); the others stay. Keyed per reply. */
  const replyKey = result?.continuation || result?.originalRequest || "";
  const dismissedIds = dismissed?.key === replyKey ? dismissed.ids : [];
  const visiblePlans = (result?.candidates?.feasible ?? []).filter((candidate) => !dismissedIds.includes(candidate.id));

  return (
    <div aria-label="Copilot investigation" className="min-w-0">
      {!prompt && !result && !error ? (
        <div className="py-2">
          <Search size={20} className="mb-3 text-violet-500" aria-hidden="true" />
          <p className="text-[17px] leading-7 text-vgray-900">Say what you want to do with your position.</p>
          <p className="mt-1.5 max-w-[60ch] text-[14px] leading-6 text-vgray-500">
            The copilot checks your account and the live markets first, sizes every amount from what it read, and shows you the plan before anything runs.
          </p>
        </div>
      ) : (
        <div className="flex flex-col" style={{ gap: REPLY_CARD_GAP_PX }}>
          {!omitTranscript && (
            <ChatTurns
              turns={turns}
              hideAssistantText={loading && !workflow && result ? result.message : null}
            />
          )}

          {loading && (
            <p role="status" aria-live="polite" className="flex items-center gap-2.5 text-[13px] text-violet-500">
              <span className="cp-loader-mark" aria-hidden="true"><img src={VANNA_ICON_SRC} alt="" width={18} height={18} /></span>
              {progressLabel}{deviceClock ? ` (${deviceClock})` : ""}
            </p>
          )}
          {error && (
            <p role="alert" className="flex items-start gap-2 text-[14px] leading-6 text-vgray-700">
              <CircleAlert size={17} className="mt-1 shrink-0 text-imperial-500" aria-hidden="true" />
              {error}
            </p>
          )}

          {/*
            * While the next turn is running, `result` is still the PREVIOUS turn's - the
            * hook keeps it deliberately so the column does not go blank. Rendering it here
            * put the last reply on screen twice: clamped in the thread above, and again in
            * full BELOW the question just asked, where it reads as the answer to it. The
            * thread already carries it, so during a run the answer area stays empty and the
            * spinner is the only thing under the new question.
            */}
          {result && resultIsLatest && !completionSummaryReady && !(loading && !workflow) && hasCardContent && (
            <article aria-label="Copilot reply" className="flex flex-col" style={{ gap: REPLY_CARD_GAP_PX }}>

              {/*
                No "Understood as" block and no constraint chips (owner, 24 Sep, live): the plan card
                already shows exactly what will run, and the reply says it. A restatement next to it is
                the extra wording the layout sketch rules out.
              */}

              {/* Only when the message needed reading (misspelled, shorthand, ambiguous): what the model took it to mean, so a wrong reading is caught here. */}
              {result.understanding?.reading && (
                <p className="max-w-[68ch] text-[13px] leading-5 text-vgray-500" data-testid="read-as">Read as: {result.understanding.reading}</p>
              )}

              {/* The one computed number worth its own block: real headroom at their floor. */}
              {result.capacity && (
                <section className="rounded-xl border border-vgray-100 px-4 py-3.5">
                  <SectionTitle>Headroom at your {result.capacity.floor} floor</SectionTitle>
                  <p className="mt-1 text-[22px] font-semibold tabular-nums text-violet-500">{money(result.capacity.maxBorrowUsd)}</p>
                  <p className="mt-1.5 max-w-[60ch] text-[12.5px] leading-5 text-vgray-500">
                    From {money(result.capacity.grossCollateralUsd)} of collateral against {money(result.capacity.debtUsd)} of debt.
                    A borrow counts on both sides, so this is the exact amount that leaves your health factor at {result.capacity.floor}.
                  </p>
                </section>
              )}

              {result.swapIntent && !workflow?.swap && (
                <SwapIntentPreviewCard intent={result.swapIntent} wallet={wallet ?? result.scope.wallet}
                  refusal={result.candidates?.rejected.find((entry) => /swap/i.test(entry.label))?.reason ?? null} />
              )}

              {/*
                The owner's layout (23 Sep sketch): one plan card per real alternative, each with
                its own Approve and Cancel. Plan A / B / C only when there is more than one. Once a
                plan is prepared, the journal's card takes this place, then the execution card:
                the set of plans goes, so the chosen plan is the only card left. Refusals are not
                a second card; the reply above already says why (UI-FIX-LIST 12, 16).
              */}
              {!!result.candidates && visiblePlans.length > 0 && !workflow && (() => {
                const feasible = result.candidates!.feasible;
                const several = feasible.length > 1;
                const approve = onApproveCandidate ?? onPropose;
                const selectedId = visiblePlans.some((c) => c.id === openPlan) ? openPlan! : visiblePlans[0].id;
                const dismiss = (id: string) => setDismissed({ key: replyKey, ids: [...dismissedIds, id] });
                const toggleSteps = (id: string) => setOpenSteps((open) => ({ ...open, [id]: !open[id] }));
                if (visiblePlans.length === 1) {
                  const only = visiblePlans[0];
                  return (
                    <section aria-label={several ? "Plans" : "Plan"} className="flex flex-col gap-3.5">
                      <PlanCard
                        candidate={only}
                        index={feasible.indexOf(only)}
                        several={several}
                        beforeHf={result.capacity?.healthFactor ?? null}
                        stepsOpen={!!openSteps[only.id]}
                        onToggleSteps={() => toggleSteps(only.id)}
                        onApprove={approve ? () => approve(only.id) : undefined}
                        onCancel={() => dismiss(only.id)}
                        approveDisabled={!!workflowLoading || planInFlight}
                        cancelDisabled={!!workflowLoading}
                      />
                    </section>
                  );
                }
                return (
                  <PlanPicker
                    plans={visiblePlans}
                    letterOf={(candidate) => feasible.indexOf(candidate)}
                    selectedId={selectedId}
                    onSelect={setOpenPlan}
                    beforeHf={result.capacity?.healthFactor ?? null}
                    openSteps={openSteps}
                    onToggleSteps={toggleSteps}
                    onApprove={approve}
                    onCancel={dismiss}
                    approveDisabled={!!workflowLoading || planInFlight}
                    cancelDisabled={!!workflowLoading}
                  />
                );
              })()}
              {!!result.candidates?.feasible.length && !workflow && visiblePlans.length === 0 && (
                <p className="text-[13px] leading-5 text-vgray-500" data-testid="plans-cancelled">Cancelled. Nothing was submitted.</p>
              )}

              {/* Between a click and its result the user must see the state, not a frozen card. */}
              {workflowLoading && (!workflow || workflow.status === "proposed" || workflow.status === "validating") && !preparingRun && (
                <p role="status" aria-live="polite" className="flex items-center gap-2 text-[13px] text-violet-500" data-testid="workflow-progress">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-violet-500" aria-hidden="true" />
                  {!workflow
                    ? "Getting your transaction ready"
                    : "Checking funds, prices and projected health before anything is submitted"}
                </p>
              )}
              {workflowLoading && (!workflow || workflow.status === "proposed" || workflow.status === "validating") && <StillWorking />}

              {/* Withdrawn by the live re-check: the amounts below were true when they were read
                  and are not any more, so the card states that instead of offering Approve. */}
              {workflow?.status === "proposed" && planWithdrawn && (
                <section role="alert" data-testid="plan-withdrawn" className="rounded-xl border border-imperial-500/30 bg-surface px-4 py-3.5">
                  <SectionTitle>No longer valid</SectionTitle>
                  <p className="mt-1.5 max-w-[68ch] text-[14px] leading-6 text-vgray-900">{planWithdrawn}</p>
                  <p className="mt-1.5 max-w-[68ch] text-[13px] leading-5 text-vgray-500">
                    Nothing was submitted. Ask again and the amounts will be sized from fresh reads.
                  </p>
                  {onCancelPlan && (
                    <button type="button" onClick={onCancelPlan} disabled={workflowLoading} className={`${BTN_QUIET} mt-3`}>
                      Clear this plan
                    </button>
                  )}
                </section>
              )}
              {workflow?.status === "proposed" && !planWithdrawn && workflow.swap && onApprove && (
                <SwapReviewCard workflow={workflow} wallet={wallet} busy={!!workflowLoading}
                  autoSign={autoSign} liveFloor={planLiveFloor} onConfirm={onApprove} onCancel={onCancelPlan} />
              )}
              {workflow?.status === "proposed" && !planWithdrawn && workflow.steps.some((step) => step.op === "swap") && !workflow.swap && (
                <section role="alert" className="rounded-xl border border-imperial-500/30 bg-surface p-4 text-[13px] text-imperial-600">
                  The swap terms could not be reviewed. Ask copilot to prepare a new swap quote.
                  {onCancelPlan && <button type="button" onClick={onCancelPlan} className="ml-2 underline">Cancel plan</button>}
                </section>
              )}
              {workflow && preparingRun && (
                <div className="flex flex-col gap-2.5">
                  <ExecutionStepper steps={preparingSteps(workflow)} currentStepIndex={0} network={result.scope.network} autoApprove={!!autoSign} busy />
                </div>
              )}
              {workflow?.status === "proposed" && !planWithdrawn && !preparingRun && !workflow.steps.some((step) => step.op === "swap") && onApprove && (
                <PlanReviewCard workflow={workflow} wallet={wallet ?? null} busy={!!workflowLoading}
                  autoSign={!!autoSign} onConfirm={onApprove} onCancel={onCancelPlan} />
              )}
              {/*
                The execution card stands on its own (owner, 24 Sep, live): no outer box, no "Done"
                heading or objective above it, since its own header already says Completed / Stopped
                / Executing. The boxed section stays only where the card is NOT drawn here: a run
                blocked before it started (a plain step list), or one whose receipt the thread draws.
              */}
              {workflow && !completionSummaryReady && workflow.status !== "proposed" && workflow.status !== "blocked" && !stepperDrawnInThread && (
                <div className="flex flex-col gap-2.5">
                  <ExecutionStepper steps={workflow.steps.map(toStepperStep)} currentStepIndex={Math.max(0, workflow.steps.findIndex((step) => step.status !== "settled"))} network={result.scope.network} autoApprove={!!autoSign}
                    busy={!!workflowLoading}
                    cancelled={workflow.status === "cancelled"}
                    onSign={workflow.status === "awaiting_signature" ? onSign : undefined}
                    onStop={["approved", "awaiting_signature"].includes(workflow.status) ? onCancelPlan : undefined} />
                  {["running", "approved"].includes(workflow.status) && onResume && (
                    <button type="button" disabled={workflowLoading} onClick={onResume} className={`${BTN_QUIET} self-start`}>Check progress</button>
                  )}
                </div>
              )}
              {workflow && !completionSummaryReady && workflow.status !== "proposed" && (workflow.status === "blocked" || stepperDrawnInThread) && (
                <section className="rounded-xl border border-violet-100 px-4 py-3.5">
                  <SectionTitle>
                    {/* 23 Sep, X10: a run stopped at leg 5 after 4 legs settled read "Not executed".
                        What settled is on-chain, so a stopped run says how much of it ran. */}
                    {workflow.status === "blocked" || workflow.status === "cancelled"
                        ? (() => {
                            const settled = workflow.steps.filter((step) => step.status === "settled").length;
                            return settled ? `Partly executed: ${settled} of ${workflow.steps.length} steps settled` : "Not executed";
                          })()
                        : workflow.status === "completed" ? "Done" : "Running"}
                  </SectionTitle>
                  <p className="mt-1.5 text-[15px] leading-6 text-vgray-900">{workflow.objective}</p>
                  {(workflow.status === "completed" || workflow.status === "blocked" || workflow.status === "cancelled") && (
                    <p className="mt-1 max-w-[68ch] text-[13px] leading-5 text-vgray-500">{workflow.message}</p>
                  )}
                  {workflow.status === "blocked" ? (
                    <ol className="mt-3 space-y-1.5">
                      {workflow.steps.map((step, stepIndex) => (
                        <li key={step.id} className="flex gap-2.5 text-[13px] leading-5 text-vgray-800">
                          <span className="w-4 shrink-0 text-right tabular-nums text-vgray-400">{stepIndex + 1}</span>
                          <span className="min-w-0 break-words">
                            {step.label}
                            <span className="tabular-nums text-vgray-500"> ({step.amount} {step.asset})</span>
                          </span>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {/* Sign and Stop live on the execution card itself; the blocked list has neither. */}
                    {workflow.status === "awaiting_signature" && onSign && stepperDrawnInThread && (
                      <button type="button" onClick={onSign} disabled={workflowLoading} className={BTN_PRIMARY}>Sign in wallet</button>
                    )}
                    {["running", "approved"].includes(workflow.status) && onResume && (
                      <button type="button" disabled={workflowLoading} onClick={onResume} className={BTN_QUIET}>Check progress</button>
                    )}
                    {["approved", "awaiting_signature"].includes(workflow.status) && onCancelPlan && stepperDrawnInThread && (
                      <button type="button" disabled={workflowLoading} onClick={onCancelPlan} className={BTN_QUIET}>Cancel remaining steps</button>
                    )}
                  </div>
                </section>
              )}
              {workflowError && (
                <p role="alert" className="flex items-start gap-2 text-[14px] leading-6 text-vgray-700">
                  <CircleAlert size={17} className="mt-1 shrink-0 text-imperial-500" aria-hidden="true" />
                  {workflowError}
                </p>
              )}

              {/* A questionnaire asks this in the chat box's place; the same question twice is noise. */}
              {result.question && !result.questionnaire && (
                <section className="rounded-xl border border-violet-100 bg-violet-50 px-4 py-3.5">
                  <SectionTitle>{result.candidates?.feasible.length ? "Open point" : "Needs your answer"}</SectionTitle>
                  <p className="mt-1.5 whitespace-pre-wrap break-words text-[14px] leading-6 text-vgray-900">{result.question}</p>
                  {/* Choices the server built from the user's own words ("did you mean"): one tap answers. */}
                  <ChoiceButtons choices={result.choices} onReply={onReply} onWrite={onWrite} />
                  <p className="mt-1.5 text-[12.5px] leading-5 text-vgray-500">
                    {result.candidates?.feasible.length ? "The plans above stand. Reply below to change them." : "Reply below to continue."}
                  </p>
                </section>
              )}

              {/* With a questionnaire the question box is hidden, so its choices (e.g. "Open a margin account") show here. */}
              {(!result.question || result.questionnaire) && <ChoiceButtons choices={result.choices} onReply={onReply} onWrite={onWrite} />}

              {/* Notes explain a partial answer. With a plan or a run on screen they are noise (UI-FIX-LIST 3). */}
              {!(result.status === "incomplete" && result.understanding?.intent === "answer") && result.warnings.length > 0 && !result.candidates?.feasible.length && !workflow && (
                <ul className="space-y-1.5 text-[12.5px] leading-5 text-vgray-500" aria-label="Notes">
                  {result.warnings.map((warning, index) => (
                    <li key={index} className="flex gap-2">
                      <CircleAlert size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span className="max-w-[68ch]">{warning}</span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          )}

          {/* "New chat" lives in the page header now - one control, not one per card. */}
          {!loading && onContinue && result && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={onContinue} className={BTN_PRIMARY}>{continueLabel ?? "Continue"}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
