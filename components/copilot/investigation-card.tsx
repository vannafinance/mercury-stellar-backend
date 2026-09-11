"use client";

import { useEffect, useState } from "react";
import { ChevronRight, CircleAlert, Loader2, Search } from "lucide-react";
import type { ResearchView } from "@/lib/copilot/investigation/view";
import type { InvestigationProgress } from "@/lib/copilot/investigation/types";
import type { WorkflowView } from "@/lib/copilot/workflow/types";
import type { ThreadTurn } from "@/lib/copilot/investigation/thread";
import { ExecutionStepper, type StepperStep } from "@/components/copilot/execution-stepper";
import { formatElapsedMs, formatRunClock } from "@/lib/copilot/investigation/duration";

export interface InvestigationCardProps {
  prompt: string;
  result: ResearchView | null;
  progress: InvestigationProgress | null;
  loading: boolean;
  error: string | null;
  turns?: ThreadTurn[];
  onReset: () => void;
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

type Borrowing = NonNullable<ResearchView["understanding"]>["borrowing"];
const BORROWING: Record<Borrowing, string | null> = {
  unspecified: null,
  allowed: "Borrowing allowed, not required",
  required: "Borrowing required",
  forbidden: "No new borrowing",
};

export function InvestigationCard({
  prompt, result: researchResult, progress, loading, error, turns = [], onReset, onContinue, continueLabel,
  onPropose, workflow, workflowError, workflowLoading, onApprove, onSign, onResume, onCancelPlan,
}: InvestigationCardProps) {
  const result: ResearchView | null = researchResult ?? (workflow ? {
    status: "researched", message: "Restored your recorded plan.", originalRequest: workflow.objective, refinements: [],
    understanding: null, question: null, facts: [], checks: [], warnings: [], continuation: "", executionAllowed: false,
    scope: { wallet: null, smartAccount: null, network: "testnet" },
  } : null);
  const progressLabel = !progress ? "Starting the investigation"
    : progress.kind === "scope" ? progress.label
      : progress.kind === "reviewing" ? "Working out what to check next…"
        : progress.kind === "reading" ? `Reading ${progress.label}…`
          : `${progress.label}: ${progress.status === "ok" ? "read complete" : "unavailable"}`;

  const stance = result?.understanding ? BORROWING[result.understanding.borrowing] : null;
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (!loading) return;
    const startedAt = Date.now();
    setElapsedSec(0);
    const id = setInterval(() => setElapsedSec(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [loading]);
  const serverClock = result?.elapsedMs != null ? formatElapsedMs(result.elapsedMs) : null;
  const deviceClock = elapsedSec > 0 ? formatRunClock(elapsedSec) : null;

  return (
    /*
     * A SECTION of the console card, not a card of its own. The turn is one continuous
     * piece of work — intent, reads, options, plan — and framing the reads separately made
     * the user re-anchor mid-thought. The console owns the border; this owns the content.
     */
    <div aria-label="Copilot investigation" className="cp-console__section min-w-0">
      {!prompt && !result && !error ? (
        <div>
          <Search size={20} className="mb-3 text-violet-500" />
          <p className="text-h7 text-vgray-900">Understand your options before taking action.</p>
          <p className="mt-2 text-[14px] leading-6 text-vgray-500">
            Describe your goal above. I will check your position and the live markets first, then build the plan.
          </p>
        </div>
      ) : (
        <>
          {turns.length > 0 && (
            <ol className="mb-4 space-y-3" aria-label="Investigation thread">
              {turns.map((turn, index) => (
                <li key={`${turn.role}-${index}`} className="min-w-0">
                  {turn.role === "user" ? (
                    <p className="text-[13px] leading-6 text-vgray-500">
                      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-vgray-400">You · </span>
                      {turn.text}
                    </p>
                  ) : (
                    <div>
                      <p className="text-[14px] leading-6 text-vgray-700">{turn.text}</p>
                      {turn.question && index < turns.length - 1 && (
                        <p className="mt-1.5 text-[13px] leading-5 text-violet-500">{turn.question}</p>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
          {turns.length > 0 && (
            <p className="mb-3 text-[11px] leading-5 text-vgray-400">
              This thread is kept in this browser tab. Closing the tab loses the conversation and any in-flight plan that has not been approved.
            </p>
          )}
          {loading && (
            <p role="status" aria-live="polite" className="flex items-center gap-2 text-[13px] text-violet-500">
              <Loader2 size={15} className="shrink-0 animate-spin" />
              {progressLabel}{deviceClock ? ` · ${deviceClock}` : ""}
            </p>
          )}
          {error && (
            <p role="alert" className="flex items-start gap-2 text-[14px] leading-6 text-vgray-700">
              <CircleAlert size={17} className="mt-1 shrink-0 text-imperial-500" />
              {error}
            </p>
          )}

          {result && (
            <>
              {/*
                The headline is what the copilot UNDERSTOOD, not a list of what it read.
                Every figure it gathered used to be printed here — four wallet balances, a
                rates table, oracle prices, raw 28-decimal strings and both account
                addresses — which buried the one line the user needed and read as a data
                dump rather than an answer. Reads belong in the trace below.
              */}
              {result.understanding ? (
                <>
                  <p className="text-[16.5px] leading-6 text-vgray-900">{result.understanding.objective}</p>
                  {(result.understanding.constraints.length > 0 || stance) && (
                    <ul className="mt-2.5 flex flex-wrap gap-2">
                      {result.understanding.constraints.map((constraint, index) => (
                        <li
                          key={index}
                          className="rounded-full border border-violet-100 bg-violet-50 px-2.5 py-1 text-[12px] text-violet-500"
                        >
                          {constraint}
                        </li>
                      ))}
                      {stance && (
                        <li className="rounded-full border border-vgray-100 px-2.5 py-1 text-[12px] text-vgray-500">
                          {stance}
                        </li>
                      )}
                    </ul>
                  )}
                </>
              ) : null}
              {(!turns.length || turns[turns.length - 1]?.text !== result.message) && (
                <p className="mt-3 text-[14px] leading-6 text-vgray-700">{result.message}</p>
              )}
              {(serverClock || (!loading && deviceClock)) && (
                <p className="mt-1.5 font-mono text-[12px] tabular-nums text-vgray-400">
                  {serverClock ? `Checked in ${serverClock}` : `Checked in ${deviceClock}`}
                  {serverClock && !loading && deviceClock ? ` · ${deviceClock} this device` : ""}
                </p>
              )}

              {/* The one computed number worth the headline: real headroom at their floor. */}
              {result.capacity && (
                <div className="mt-4 rounded-xl border border-vgray-100 px-4 py-3.5">
                  <p className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-vgray-400">
                    Headroom at your {result.capacity.floor} floor
                  </p>
                  <p className="mt-1 font-mono text-[21px] tabular-nums text-violet-500">
                    {money(result.capacity.maxBorrowUsd)}
                  </p>
                  <p className="mt-1.5 text-[12px] leading-5 text-vgray-500">
                    Calculated from {money(result.capacity.grossCollateralUsd)} collateral against{" "}
                    {money(result.capacity.debtUsd)} debt. Borrowing counts toward both, so this is the exact
                    amount that leaves your health factor at {result.capacity.floor}.
                  </p>
                </div>
              )}

              {/*
                Ranked options, computed rather than suggested. The non-borrowing choice is
                shown alongside the leveraged one on purpose — permission to borrow is not
                an instruction to borrow — and a rejected shape states WHY, so "no option"
                never reads as "nothing was considered".
              */}
              {!!result.candidates && (result.candidates.feasible.length > 0 || result.candidates.rejected.length > 0) && (
                <div className="mt-5">
                  <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-vgray-400">Options</p>
                  <div className="mt-2.5 space-y-2.5">
                    {result.candidates.feasible.map((candidate, index) => (
                      <div
                        key={candidate.id}
                        className="rounded-xl border px-4 py-3.5"
                        style={{
                          borderColor: index === 0 ? "var(--cp-violet-soft-border)" : "var(--cp-g100)",
                        }}
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                          <p className="min-w-0 break-words text-[14px] leading-6 text-vgray-900">
                            {candidate.label}
                          </p>
                          <p className="shrink-0 font-mono text-[15px] tabular-nums text-violet-500">
                            {candidate.netAprPct === null
                              ? `${Number(candidate.supplyAprPct).toFixed(2)}% APR`
                              : `+${Number(candidate.netAprPct).toFixed(2)}% net APR`}
                          </p>
                        </div>
                        <p className="mt-1.5 font-mono text-[12px] tabular-nums text-vgray-500">
                          {money(candidate.amountUsd)}
                          {candidate.finalHealthFactor
                            ? ` · health factor ${Number(candidate.finalHealthFactor).toFixed(2)} after`
                            : " · no change to health factor"}
                        </p>
                        {index === 0 && candidate.decision?.reason && (
                          <p className="mt-2 text-[13px] leading-5 text-vgray-700">{candidate.decision.reason}</p>
                        )}
                        {onPropose && (
                          <button
                            type="button"
                            onClick={() => onPropose(candidate.id)}
                            disabled={workflowLoading || !!workflow}
                            className="mt-3 rounded-lg bg-gradient px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50"
                          >
                            Prepare this plan
                          </button>
                        )}
                        {index === 0 && candidate.decision?.runnerUpId && onPropose && (
                          <button
                            type="button"
                            onClick={() => onPropose(candidate.decision!.runnerUpId!)}
                            disabled={workflowLoading}
                            className="mt-2 ml-2 rounded-lg border border-violet-100 px-3 py-1.5 text-[12px] font-semibold text-violet-500 disabled:opacity-50"
                          >
                            Switch →
                          </button>
                        )}
                      </div>
                    ))}
                    {result.candidates.rejected.map((entry, index) => (
                      <div key={`${entry.asset}-${index}`} className="rounded-xl border border-vgray-100 px-4 py-3">
                        <p className="text-[13px] leading-5 text-vgray-500">
                          <span className="text-vgray-700">Ruled out — {entry.label}.</span> {entry.reason}
                        </p>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2.5 text-[12px] leading-5 text-vgray-500">
                    Sizes are calculated from your position at your stated floor, before fees and price
                    movement. Rates are the ones read above, not a projected return.
                  </p>
                </div>
              )}

              {workflow && (
                <div className="mt-5 rounded-xl border border-violet-100 px-4 py-3.5">
                  <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-violet-500">
                    {workflow.status === "proposed" || workflow.status === "validating"
                      ? "Plan for approval"
                      : workflow.status === "blocked" || workflow.status === "cancelled"
                        ? "Not executed"
                        : "Execution"}
                  </p>
                  <p className="mt-2 text-[14px] leading-6 text-vgray-900">{workflow.objective}</p>
                  <p className="mt-1.5 text-[12px] leading-5 text-vgray-500">{workflow.message}</p>
                  {workflow.status === "proposed" || workflow.status === "blocked" ? (
                    <ol className="mt-3 space-y-2">
                      {workflow.steps.map((step) => (
                        <li key={step.id} className="font-mono text-[12px] tabular-nums text-vgray-700">
                          {step.label} · {step.amount} {step.asset}
                          {step.sizing?.basis === "derived_max_at_floor"
                            ? ` · may re-size down to $${Number(step.sizing.minAmountUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                            : ""}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <div className="mt-3">
                      <ExecutionStepper
                        steps={workflow.steps.map(toStepperStep)}
                        currentStepIndex={Math.max(0, workflow.steps.findIndex((step) => step.status !== "settled"))}
                      />
                    </div>
                  )}
                  {["running", "approved"].includes(workflow.status) && onResume && (
                    <button type="button" disabled={workflowLoading} onClick={onResume}
                      className="mt-3 rounded-lg border border-vgray-100 px-3 py-2 text-[13px] text-violet-500">
                      Check progress / continue
                    </button>
                  )}
                  {["proposed", "approved", "awaiting_signature"].includes(workflow.status) && onCancelPlan && (
                    <button type="button" disabled={workflowLoading} onClick={onCancelPlan}
                      className="mt-3 ml-2 rounded-lg border border-vgray-100 px-3 py-2 text-[13px] text-vgray-500">Cancel remaining steps</button>
                  )}
                  {workflow.status === "proposed" && onApprove && (
                    <button
                      type="button"
                      onClick={onApprove}
                      disabled={workflowLoading}
                      className="mt-3 rounded-lg bg-gradient px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
                    >
                      Approve and run
                    </button>
                  )}
                  {workflow.status === "awaiting_signature" && onSign && (
                    <button
                      type="button"
                      onClick={onSign}
                      disabled={workflowLoading}
                      className="mt-3 rounded-lg bg-gradient px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
                    >
                      Sign in wallet
                    </button>
                  )}
                </div>
              )}
              {workflowError && (
                <p role="alert" className="mt-3 flex items-start gap-2 text-[14px] leading-6 text-vgray-700">
                  <CircleAlert size={17} className="mt-1 shrink-0 text-imperial-500" />
                  {workflowError}
                </p>
              )}
              {result.question && (
                <div className="mt-4 rounded-xl border border-violet-100 bg-violet-50 px-4 py-3.5">
                  <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-violet-500">
                    Answer below to continue
                  </p>
                  <p className="mt-2 whitespace-pre-wrap break-words text-[14px] leading-6 text-vgray-900">
                    {result.question}
                  </p>
                </div>
              )}

              {result.warnings.length > 0 && (
                <ul className="mt-4 space-y-1.5 text-[12px] leading-5 text-vgray-500">
                  {result.warnings.map((warning, index) => (
                    <li key={index} className="flex gap-2">
                      <CircleAlert size={13} className="mt-0.5 shrink-0" />
                      {warning}
                    </li>
                  ))}
                </ul>
              )}

              {/*
                The "What I checked · N reads" trace is gone. It was build detail: a list of
                capability names and raw values that told the user nothing they could act on,
                and it was the last thing on the card so it read as the conclusion. The
                figures that matter are stated above with their qualifiers; a read log belongs
                in the session log, which already keeps one.
              */}

            </>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            {/*
              Always offered once an investigation finishes. A remaining question refines
              the plan; it does not block it — stopping here is what made the surface look
              like it had no action at all. The plan card still stages for signature.
            */}
            {!loading && onContinue && result && (
              <button
                type="button"
                onClick={onContinue}
                className="flex items-center gap-1.5 rounded-lg bg-gradient px-4 py-2 text-[13px] font-semibold text-white"
              >
                {continueLabel ?? "Continue"} <ChevronRight size={14} />
              </button>
            )}
            {!loading && (
              <button
                type="button"
                onClick={onReset}
                className="rounded-lg border border-vgray-100 px-3.5 py-2 text-[12px] text-vgray-700 transition-colors hover:border-violet-400"
              >
                Start over
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
