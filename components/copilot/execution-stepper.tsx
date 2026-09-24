"use client";

import { Check, Loader2, X } from "lucide-react";

export interface StepperStep {
  id: string;
  label: string;
  op: string;
  asset: string;
  amount: string;
  status: "pending" | "claiming" | "signing" | "submitting" | "settled" | "failed";
  txHash?: string;
  ledger?: number;
  error?: string;
}

export interface ExecutionStepperProps {
  steps: StepperStep[];
  currentStepIndex: number;
  network?: string;
  autoApprove?: boolean;
  onRetry?: (stepIndex: number) => void;
  /** A step waits for the wallet (auto-approve off): the button sits on that step's row. */
  onSign?: () => void;
  /** Ends the run after the step in flight. Hidden once the run is over. */
  onStop?: () => void;
  busy?: boolean;
}

const IN_FLIGHT: ReadonlySet<StepperStep["status"]> = new Set(["claiming", "signing", "submitting"]);

/**
 * The execution card (mockup boards 1–4: running, completed, signature needed, stopped).
 *
 * One card that advances in place. The header says where the run is, the bar has one
 * segment per step, and each row carries its own receipt — the tx link and the ledger it
 * settled in — so nothing about a finished step has to be looked up elsewhere. Colours are
 * the copilot's tokens, so light and dark follow `.cp-root` with no per-theme markup.
 */
export function ExecutionStepper({
  steps,
  currentStepIndex,
  network = "testnet",
  autoApprove = false,
  onRetry,
  onSign,
  onStop,
  busy = false,
}: ExecutionStepperProps) {
  const total = steps.length;
  const settled = steps.filter((step) => step.status === "settled").length;
  const failedIndex = steps.findIndex((step) => step.status === "failed");
  const complete = total > 0 && settled === total;
  const stopped = failedIndex !== -1;
  const awaitingWallet = !autoApprove && steps.some((step) => step.status === "signing");
  const explorer = network === "mainnet" || network === "public" ? "public" : "testnet";
  const nextIndex = stopped ? -1 : steps.findIndex((step, index) => index > currentStepIndex && step.status === "pending");

  const headline = complete ? "Completed"
    : stopped ? `Stopped at step ${failedIndex + 1}`
      : awaitingWallet ? "Your signature needed"
        : "Executing";
  const subline = complete ? null
    : stopped ? `${settled} of ${total} went through`
      : `Step ${Math.min(total, currentStepIndex + 1)} of ${total}`;

  return (
    <div
      role="region"
      aria-label="Workflow execution progress"
      className="flex flex-col gap-4 rounded-2xl border border-vgray-100 bg-surface px-5 py-5 text-vgray-900 sm:px-6"
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2.5">
          {complete && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--cp-emerald)] text-white" aria-hidden="true">
              <Check size={11} strokeWidth={3} />
            </span>
          )}
          <span className="text-[15px] font-semibold">{headline}</span>
          {subline && <span className="text-[13px] text-vgray-400">{subline}</span>}
        </div>
        <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.max(1, total)}, minmax(0, 1fr))` }} aria-hidden="true">
          {steps.map((step, index) => (
            <div
              key={step.id || index}
              className={`h-1 rounded-full ${
                step.status === "settled" ? "bg-[var(--cp-emerald)]"
                  : step.status === "failed" ? "bg-[var(--cp-danger-fg)]"
                    : IN_FLIGHT.has(step.status) ? "animate-pulse bg-[image:var(--cp-gradient)]"
                      : "bg-[var(--bar-track)]"
              }`}
            />
          ))}
        </div>
      </div>

      <ol className="flex flex-col">
        {steps.map((step, index) => {
          const label = step.label || `${step.op} ${step.amount} ${step.asset}`;
          const isSettled = step.status === "settled";
          const isFailed = step.status === "failed";
          const isInFlight = IN_FLIGHT.has(step.status);
          const waitsHere = step.status === "signing" && !autoApprove;
          const last = index === steps.length - 1;
          return (
            <li key={step.id || index} className={`flex gap-3.5 py-3 ${last ? "" : "border-b border-vgray-50"}`}>
              <StepMark status={step.status} />
              <div className="flex min-w-0 grow flex-col gap-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className={`text-[14px] leading-5 ${isSettled || isInFlight || isFailed ? "font-semibold text-vgray-900" : "font-medium text-vgray-400"}`}>
                    {label}
                  </span>
                  {step.status === "pending" && (
                    <span className="shrink-0 text-[12px] text-vgray-300">
                      {stopped ? "Not submitted" : index === nextIndex ? "Next" : ""}
                    </span>
                  )}
                  {isFailed && <span className="shrink-0 text-[12px] font-semibold text-[var(--cp-danger-fg)]">Not sent</span>}
                </div>

                {isSettled && (
                  <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 font-mono text-[11.5px] text-vgray-400">
                    {step.txHash && (
                      <a
                        href={`https://stellar.expert/explorer/${explorer}/tx/${step.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`tx ${step.txHash}`}
                        className="text-violet-500 hover:text-violet-600"
                      >
                        {step.txHash.length > 12 ? `${step.txHash.slice(0, 6)}…${step.txHash.slice(-3)}` : step.txHash} ↗
                      </a>
                    )}
                    {step.ledger != null && <span>Ledger {step.ledger.toLocaleString("en-US")}</span>}
                    <span className="text-[var(--cp-ok-fg)]">Settled</span>
                  </div>
                )}

                {isInFlight && !waitsHere && (
                  <p role="status" aria-live="polite" className="animate-pulse font-mono text-[11.5px] text-violet-500">
                    {step.status === "claiming" ? "Checking it before it is sent…"
                      : step.status === "signing" ? "Signing…"
                        : "Waiting for the ledger to close…"}
                  </p>
                )}

                {waitsHere && (
                  <div className="mt-1 flex flex-wrap items-center gap-3">
                    {onSign && (
                      <button type="button" onClick={onSign} disabled={busy}
                        className="rounded-lg bg-[image:var(--cp-gradient)] px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50">
                        Sign in wallet
                      </button>
                    )}
                    <span className="text-[12px] text-vgray-400">Your wallet will open to approve this one step.</span>
                  </div>
                )}

                {isFailed && (
                  <div className="flex flex-col gap-1.5">
                    {step.error && <p className="text-[12.5px] leading-5 text-vgray-500">{step.error}</p>}
                    {onRetry && (
                      <button type="button" onClick={() => onRetry(index)} className="self-start text-[12.5px] font-semibold text-violet-500 hover:text-violet-600">
                        Retry
                      </button>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[12px] text-vgray-400">
          {autoApprove ? "Signed within your auto-approve limits." : "Nothing is sent without your signature."}
        </span>
        {onStop && !complete && !stopped && (
          <button type="button" onClick={onStop} disabled={busy}
            className="rounded-lg border border-vgray-100 bg-transparent px-3.5 py-2 text-[13px] font-semibold text-vgray-700 disabled:opacity-50">
            {autoApprove ? "Stop after this step" : "Cancel remaining steps"}
          </button>
        )}
      </div>
    </div>
  );
}

function StepMark({ status }: { status: StepperStep["status"] }) {
  if (status === "settled") {
    return (
      <span className="mt-px flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-[var(--cp-ok-bg)] text-[var(--cp-ok-fg)]" aria-label="Settled">
        <Check size={13} strokeWidth={2.5} />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="mt-px flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-[var(--cp-danger-bg)] text-[var(--cp-danger-fg)]" aria-label="Failed">
        <X size={13} strokeWidth={2.5} />
      </span>
    );
  }
  if (IN_FLIGHT.has(status)) {
    return <Loader2 size={22} className="mt-px shrink-0 animate-spin text-violet-500" aria-label="In progress" />;
  }
  return <span className="mt-px h-[22px] w-[22px] shrink-0 rounded-full border-2 border-dashed border-vgray-200" aria-label="Not started" />;
}
