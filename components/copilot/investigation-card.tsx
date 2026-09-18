"use client";

import { useEffect, useRef, useState } from "react";
import { CircleAlert, Loader2, Search } from "lucide-react";
import type { ResearchView } from "@/lib/copilot/investigation/view";
import type { InvestigationProgress } from "@/lib/copilot/investigation/types";
import type { WorkflowView } from "@/lib/copilot/workflow/types";
import type { ThreadTurn } from "@/lib/copilot/investigation/thread";
import { ExecutionStepper, type StepperStep } from "@/components/copilot/execution-stepper";
import { SwapIntentPreviewCard, SwapReviewCard } from "@/components/copilot/swap-review-card";
import { inFlight } from "@/hooks/use-workflow";
import { formatElapsedMs, formatRunClock } from "@/lib/copilot/investigation/duration";
import { investigationAnswerDocument } from "@/lib/copilot/investigation/answer-document";
import { AnswerView } from "@/components/copilot/answer-view";
import type { ExecutionReceiptSnapshot } from "@/lib/copilot/execution-receipt";

export interface InvestigationCardProps {
  prompt: string;
  result: ResearchView | null;
  progress: InvestigationProgress | null;
  loading: boolean;
  error: string | null;
  turns?: ThreadTurn[];
  /** Act on what was understood — the plan card takes over from here. */
  onContinue?: () => void;
  continueLabel?: string;
  /** Prepare the journal proposal for one of the sized options. */
  onPropose?: (candidateId: string) => void;
  workflow?: WorkflowView | null;
  workflowError?: string | null;
  workflowLoading?: boolean;
  onApprove?: () => void;
  onResume?: () => void;
  onCancelPlan?: () => void;
  onSign?: () => void;
  wallet?: string | null;
  autoSign?: boolean;
}

const money = (value: string) =>
  `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function toStepperStep(step: WorkflowView["steps"][number]): StepperStep {
  const status: StepperStep["status"] =
    step.status === "settled" ? "settled"
      : step.status === "failed" || step.status === "uncertain" ? "failed"
        : step.status === "awaiting_signature" ? "signing"
          : step.status === "submitted" || step.status === "submitting" ? "submitting"
            : step.status === "invoking" ? "claiming"
              : "pending";
  return {
    id: step.id, label: step.label, op: step.op, asset: step.asset, amount: step.amount,
    status, txHash: step.txHash, ledger: step.settledLedger, error: step.message,
  };
}

function receiptStepperSteps(receipt: ExecutionReceiptSnapshot): StepperStep[] {
  return receipt.steps.map((step, index) => ({
    id: `${receipt.workflowId}-${index}`,
    label: "",
    op: step.operation,
    asset: step.asset,
    amount: step.amount,
    status: step.status === "settled" ? "settled"
      : step.status === "failed" || step.status === "uncertain" ? "failed"
        : step.status === "awaiting_signature" ? "signing"
          : step.status === "submitted" || step.status === "submitting" ? "submitting"
            : step.status === "invoking" ? "claiming" : "pending",
    ...(step.txHash ? { txHash: step.txHash } : {}),
    ...(step.settledLedger != null ? { ledger: step.settledLedger } : {}),
  }));
}

type Borrowing = NonNullable<ResearchView["understanding"]>["borrowing"];
const BORROWING: Record<Borrowing, string | null> = {
  unspecified: null,
  allowed: "Borrowing allowed, not required",
  required: "Borrowing required",
  forbidden: "No new borrowing",
};

/** The rate is shown only when the option earns or pays one; a repay has none, and "0.00% APR" was a false figure. */
function rateOf(candidate: NonNullable<ResearchView["candidates"]>["feasible"][number]): string | null {
  if (candidate.netAprPct !== null) return `${Number(candidate.netAprPct) >= 0 ? "+" : ""}${Number(candidate.netAprPct).toFixed(2)}% net APR`;
  if (candidate.supplyAprPct === null) return candidate.venue === "margin" ? null : "Rate not read";
  return Number(candidate.supplyAprPct) > 0 ? `${Number(candidate.supplyAprPct).toFixed(2)}% APR` : null;
}

/** A small heading for a section of the reply. Sentence case, no tracking, no mono. */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[12px] font-semibold text-vgray-500">{children}</h3>;
}

const BTN_PRIMARY = "rounded-r2 bg-gradient px-3.5 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 disabled:cursor-not-allowed disabled:opacity-45";
const BTN_QUIET = "rounded-r2 border border-vgray-100 px-3.5 py-2 text-[13px] font-semibold text-vgray-800 transition-colors hover:border-violet-400 hover:text-violet-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 disabled:cursor-not-allowed disabled:text-vgray-300";

export function InvestigationCard({
  prompt, result: researchResult, progress, loading, error, turns = [], onContinue, continueLabel,
  onPropose, workflow, workflowError, workflowLoading, onApprove, onSign, onResume, onCancelPlan,
  wallet = null, autoSign = false,
}: InvestigationCardProps) {
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

  const stance = result?.understanding ? BORROWING[result.understanding.borrowing] : null;
  /**
   * Another option may be prepared once the current plan can no longer submit anything:
   * blocked before broadcast, finished, or cancelled. While a plan is proposed, approved,
   * running, awaiting a signature — or uncertain, where a transaction may be in flight —
   * a second plan would race it, so the buttons wait.
   */
  const planInFlight = !!workflow && !["blocked", "completed", "cancelled"].includes(workflow.status);
  /** A transaction is on its way to a ledger; the hook asks again at every ledger close. */
  const awaitingLedger = !!workflow && ["approved", "running"].includes(workflow.status) && inFlight(workflow);
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
  const serverClock = result?.elapsedMs != null ? formatElapsedMs(result.elapsedMs) : null;
  const deviceClock = elapsedSec > 0 ? formatRunClock(elapsedSec) : null;
  /**
   * The server's time and the device's time are one figure unless they differ enough to
   * mean something — then the gap is the fact worth stating (14 Sep: 9 s on the server,
   * 1 m 59 s on the device, the difference spent in the browser before the request left).
   */
  const clock = serverClock
    ? deviceClock && elapsedSec >= 30 && result?.elapsedMs != null && elapsedSec * 1000 > result.elapsedMs * 2
      ? `Checked in ${serverClock}, though it took ${deviceClock} to reach you`
      : `Checked in ${serverClock}`
    : !loading && deviceClock ? `Checked in ${deviceClock}` : null;
  const answerDocument = result ? investigationAnswerDocument(result) : null;

  // The thread ends with the assistant turn the reply block explains; the block is that turn.
  const lastTurn = turns[turns.length - 1];
  const priorTurns = result && lastTurn?.role === "assistant" && lastTurn.text === result.message ? turns.slice(0, -1) : turns;
  const currentStep = workflow ? Math.max(1, workflow.steps.findIndex((step) => step.status !== "settled") + 1) : 0;

  return (
    <div aria-label="Copilot investigation" className="cp-console__section min-w-0">
      {!prompt && !result && !error ? (
        <div className="py-2">
          <Search size={20} className="mb-3 text-violet-500" aria-hidden="true" />
          <p className="text-[17px] leading-7 text-vgray-900">Say what you want to do with your position.</p>
          <p className="mt-1.5 max-w-[60ch] text-[14px] leading-6 text-vgray-500">
            The copilot checks your account and the live markets first, sizes every amount from what it read, and shows you the plan before anything runs.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {priorTurns.length > 0 && (
            <ol className="space-y-4" aria-label="Conversation">
              {priorTurns.map((turn, index) => (
                <li key={`${turn.role}-${index}`} className={turn.role === "user" ? "flex justify-end" : "min-w-0"}>
                  {turn.role === "user" ? (
                    <p className="max-w-[85%] rounded-r2 bg-violet-50 px-3.5 py-2 text-[14px] leading-6 text-vgray-900">{turn.text}</p>
                  ) : (
                    /*
                     * An earlier reply is context, not the answer. Rendered in full it stacked
                     * wall on wall — two long paragraphs reading as one — so it is clamped to
                     * two lines and opens on click. Only the current reply stays expanded.
                     */
                    <div className="min-w-0 max-w-[68ch]">
                      <details className="group">
                        <summary className="cursor-pointer list-none text-[13.5px] leading-6 text-vgray-500 transition-colors hover:text-vgray-700 [&::-webkit-details-marker]:hidden">
                          <span className="group-open:hidden" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                            {turn.text}
                          </span>
                          <span className="hidden group-open:inline">{turn.text}</span>
                        </summary>
                        {turn.question && index < priorTurns.length - 1 && (
                          <p className="mt-1 text-[13px] leading-5 text-violet-500">{turn.question}</p>
                        )}
                      </details>
                      {turn.executionReceipt && (
                        <div className="mt-2">
                          <ExecutionStepper
                            steps={receiptStepperSteps(turn.executionReceipt)}
                            currentStepIndex={Math.max(0, turn.executionReceipt.steps.findIndex((step) => step.status !== "settled"))}
                            network={turn.executionReceipt.network}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}

          {loading && (
            <p role="status" aria-live="polite" className="flex items-center gap-2 text-[13px] text-violet-500">
              <Loader2 size={15} className="shrink-0 animate-spin" aria-hidden="true" />
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
            * While the next turn is running, `result` is still the PREVIOUS turn's — the
            * hook keeps it deliberately so the column does not go blank. Rendering it here
            * put the last reply on screen twice: clamped in the thread above, and again in
            * full BELOW the question just asked, where it reads as the answer to it. The
            * thread already carries it, so during a run the answer area stays empty and the
            * spinner is the only thing under the new question.
            */}
          {result && !(loading && !workflow) && (
            <article aria-label="Copilot reply" className={`space-y-5${priorTurns.length ? " border-t border-vgray-100 pt-5" : ""}`}>
              {/* The reply, then what was understood — the one line the user needs, not a list of reads. */}
              <div className="max-w-[68ch]">
                {answerDocument && <AnswerView answer={answerDocument} />}
                {clock && <p className="mt-1 text-[12px] tabular-nums text-vgray-400">{clock}</p>}
              </div>

              {result.understanding && (
                <section className="space-y-2">
                  <SectionTitle>Understood as</SectionTitle>
                  <p className="text-[14px] leading-6 text-vgray-800">{result.understanding.objective}</p>
                  {(result.understanding.constraints.length > 0 || stance) && (
                    <ul className="flex flex-wrap gap-1.5" aria-label="Constraints">
                      {result.understanding.constraints.filter((constraint) => constraint.trim().toLowerCase() !== stance?.toLowerCase()).map((constraint, index) => (
                        <li key={index} className="rounded-full border border-violet-100 bg-violet-50 px-2.5 py-1 text-[12px] text-violet-500">{constraint}</li>
                      ))}
                      {stance && <li className="rounded-full border border-vgray-100 px-2.5 py-1 text-[12px] text-vgray-500">{stance}</li>}
                    </ul>
                  )}
                </section>
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
                Options, computed rather than suggested. The non-borrowing choice is shown
                beside the leveraged one on purpose — permission to borrow is not an
                instruction to borrow — and a ruled-out shape states why.
              */}
              {!!result.candidates && (result.candidates.feasible.length > 0 || result.candidates.rejected.length > 0) && (
                <section className="space-y-2.5">
                  <SectionTitle>{result.candidates.feasible.length === 1 ? "Option" : "Options"}</SectionTitle>
                  {result.candidates.feasible.map((candidate, index) => {
                    const rate = rateOf(candidate);
                    return (
                      <div
                        key={candidate.id}
                        className="rounded-xl border px-4 py-3.5"
                        style={{ borderColor: index === 0 ? "var(--cp-violet-soft-border)" : "var(--cp-g100)" }}
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                          <p className="min-w-0 break-words text-[15px] leading-6 text-vgray-900">{candidate.label}</p>
                          {rate && <p className="shrink-0 text-[14px] font-semibold tabular-nums text-violet-500">{rate}</p>}
                        </div>
                        <dl className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] leading-5 text-vgray-500">
                          <div className="flex gap-1.5"><dt>Amount</dt><dd className="tabular-nums text-vgray-800">{money(candidate.amountUsd)}</dd></div>
                          <div className="flex gap-1.5">
                            <dt>Health factor after</dt>
                            <dd className="tabular-nums text-vgray-800">{candidate.finalHealthFactor ? Number(candidate.finalHealthFactor).toFixed(2) : "unchanged"}</dd>
                          </div>
                        </dl>
                        {/* A composed plan shows its legs in order — every amount here was sized in code. */}
                        {!!candidate.steps?.length && (
                          <ol className="mt-2.5 space-y-1 text-[13px] leading-5 text-vgray-800" data-testid="plan-steps">
                            {candidate.steps.map((step, stepIndex) => (
                              <li key={step.id} className="flex gap-2.5">
                                <span className="w-4 shrink-0 text-right tabular-nums text-vgray-400">{stepIndex + 1}</span>
                                <span className="min-w-0 break-words">{step.label}</span>
                              </li>
                            ))}
                          </ol>
                        )}
                        {candidate.rationale && <p className="mt-2.5 max-w-[68ch] text-[13px] leading-5 text-vgray-600">{candidate.rationale}</p>}
                        {candidate.simulation && (
                          <p className="mt-1.5 max-w-[68ch] text-[12.5px] leading-5 text-vgray-500" data-testid="plan-simulation">{candidate.simulation.summary}</p>
                        )}
                        {index === 0 && candidate.decision?.reason && <p className="mt-2 max-w-[68ch] text-[13px] leading-5 text-vgray-700">{candidate.decision.reason}</p>}
                        {onPropose && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button type="button" onClick={() => onPropose(candidate.id)} disabled={workflowLoading || planInFlight} className={BTN_PRIMARY}>
                              Prepare this plan
                            </button>
                            {index === 0 && candidate.decision?.runnerUpId && (
                              <button type="button" onClick={() => onPropose(candidate.decision!.runnerUpId!)} disabled={workflowLoading || planInFlight} className={BTN_QUIET}>
                                Use the other option
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {result.candidates.rejected.length > 0 && (
                    <ul className="space-y-1.5" aria-label="Ruled out">
                      {result.candidates.rejected.map((entry, index) => (
                        <li key={`${entry.asset}-${index}`} className="rounded-xl border border-dashed border-vgray-100 px-4 py-3 text-[13px] leading-5 text-vgray-500">
                          <span className="text-vgray-800">Ruled out: {entry.label}.</span> {entry.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                  <details className="text-[12.5px] leading-5 text-vgray-500">
                    <summary className="cursor-pointer select-none text-vgray-500 hover:text-vgray-800">How these figures are made</summary>
                    <p className="mt-1 max-w-[68ch]">
                      Every amount comes from a live read of your wallet, your position and the markets, cut to the token&apos;s on-chain precision.
                      Health factors are projected at your stated floor, before fees and price movement. Rates are the ones read, not a projected return.
                    </p>
                  </details>
                </section>
              )}

              {/* Between a click and its result the user must see the state, not a frozen card. */}
              {(workflowLoading || awaitingLedger) && (
                <p role="status" aria-live="polite" className="flex items-center gap-2 text-[13px] text-violet-500" data-testid="workflow-progress">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-violet-500" aria-hidden="true" />
                  {!workflow
                    ? "Preparing the plan: sizing every step from the sealed reads"
                    : !workflowLoading && awaitingLedger
                      ? `Step ${currentStep} of ${workflow.steps.length} is on its way to the ledger; checking at every ledger close`
                      : workflow.status === "proposed" || workflow.status === "validating"
                        ? "Checking funds, prices and projected health before anything is submitted"
                        : workflow.status === "awaiting_signature"
                          ? "Waiting for your wallet signature"
                          : `Running step ${currentStep} of ${workflow.steps.length}`}
                </p>
              )}

              {workflow?.status === "proposed" && workflow.swap && onApprove && (
                <SwapReviewCard workflow={workflow} wallet={wallet} busy={!!workflowLoading}
                  autoSign={autoSign} onConfirm={onApprove} onCancel={onCancelPlan} />
              )}
              {workflow?.status === "proposed" && workflow.steps.some((step) => step.op === "swap") && !workflow.swap && (
                <section role="alert" className="rounded-xl border border-imperial-500/30 bg-surface p-4 text-[13px] text-imperial-600">
                  The swap terms could not be reviewed. Ask copilot to prepare a new swap quote.
                  {onCancelPlan && <button type="button" onClick={onCancelPlan} className="ml-2 underline">Cancel plan</button>}
                </section>
              )}
              {workflow && !(workflow.status === "proposed" && workflow.steps.some((step) => step.op === "swap")) && (
                <section className="rounded-xl border border-violet-100 px-4 py-3.5">
                  <SectionTitle>
                    {workflow.status === "proposed" || workflow.status === "validating"
                      ? "Plan for approval"
                      : workflow.status === "blocked" || workflow.status === "cancelled"
                        ? "Not executed"
                        : workflow.status === "completed" ? "Done" : "Running"}
                  </SectionTitle>
                  <p className="mt-1.5 text-[15px] leading-6 text-vgray-900">{workflow.objective}</p>
                  <p className="mt-1 max-w-[68ch] text-[13px] leading-5 text-vgray-500">{workflow.message}</p>
                  {workflow.status === "proposed" || workflow.status === "blocked" ? (
                    <ol className="mt-3 space-y-1.5">
                      {workflow.steps.map((step, stepIndex) => (
                        <li key={step.id} className="flex gap-2.5 text-[13px] leading-5 text-vgray-800">
                          <span className="w-4 shrink-0 text-right tabular-nums text-vgray-400">{stepIndex + 1}</span>
                          <span className="min-w-0 break-words">
                            {step.label}
                            <span className="tabular-nums text-vgray-500"> ({step.amount} {step.asset})</span>
                            {step.sizing?.basis === "derived_max_at_floor" && (
                              <span className="text-vgray-500"> — may re-size down to ${Number(step.sizing.minAmountUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <div className="mt-3">
                      <ExecutionStepper steps={workflow.steps.map(toStepperStep)} currentStepIndex={Math.max(0, workflow.steps.findIndex((step) => step.status !== "settled"))} network={result.scope.network} />
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {workflow.status === "proposed" && onApprove && (
                      <button type="button" onClick={onApprove} disabled={workflowLoading} className={BTN_PRIMARY}>Approve and run</button>
                    )}
                    {workflow.status === "awaiting_signature" && onSign && (
                      <button type="button" onClick={onSign} disabled={workflowLoading} className={BTN_PRIMARY}>Sign in wallet</button>
                    )}
                    {["running", "approved"].includes(workflow.status) && onResume && (
                      <button type="button" disabled={workflowLoading} onClick={onResume} className={BTN_QUIET}>Check progress</button>
                    )}
                    {["proposed", "approved", "awaiting_signature"].includes(workflow.status) && onCancelPlan && (
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

              {result.question && (
                <section className="rounded-xl border border-violet-100 bg-violet-50 px-4 py-3.5">
                  <SectionTitle>{result.candidates?.feasible.length ? "Open point" : "Needs your answer"}</SectionTitle>
                  <p className="mt-1.5 whitespace-pre-wrap break-words text-[14px] leading-6 text-vgray-900">{result.question}</p>
                  <p className="mt-1.5 text-[12.5px] leading-5 text-vgray-500">
                    {result.candidates?.feasible.length ? "The options above stand. Reply below to change them." : "Reply below to continue."}
                  </p>
                </section>
              )}

              {result.warnings.length > 0 && (
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

          {/* "New chat" lives in the page header now — one control, not one per card. */}
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
