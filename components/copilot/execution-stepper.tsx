"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";

export interface StepperStep {
  id: string;
  label: string;
  op: string;
  asset: string;
  amount: string;
  status: "pending" | "claiming" | "signing" | "submitting" | "settled" | "failed" | "uncertain";
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
  /** The user cancelled the remaining steps: the header says so rather than "Executing". */
  cancelled?: boolean;
}

/** Settled steps fill and pop one after another, so a finished run still reads in order. */
const STAGGER_MS = 140;

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
  cancelled = false,
}: ExecutionStepperProps) {
  const total = steps.length;
  const freshIds = useFreshlySettled(steps);
  const settled = steps.filter((step) => step.status === "settled").length;
  const failedIndex = steps.findIndex((step) => step.status === "failed");
  /** A step whose transaction may or may not have landed: the run is halted until someone checks. */
  const uncertainIndex = steps.findIndex((step) => step.status === "uncertain");
  const complete = total > 0 && settled === total;
  const stopped = failedIndex !== -1 || uncertainIndex !== -1 || cancelled;
  // A step handed back to the wallet needs it even under auto-approve: the signer refused that
  // one (a cap, a lapsed session), and `onSign` is supplied exactly when the run waits on it.
  const walletCanSign = !autoApprove || Boolean(onSign);
  const awaitingWallet = walletCanSign && steps.some((step) => step.status === "signing");
  const explorer = network === "mainnet" || network === "public" ? "public" : "testnet";
  const nextIndex = stopped ? -1 : steps.findIndex((step, index) => index > currentStepIndex && step.status === "pending");

  const headline = complete ? "Completed"
    : failedIndex !== -1 ? `Stopped at step ${failedIndex + 1}`
      : uncertainIndex !== -1 ? `Check step ${uncertainIndex + 1}`
      : cancelled ? "Cancelled"
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
            <span className="cp-exec-pop flex h-4 w-4 items-center justify-center rounded-full bg-[var(--cp-emerald)] text-white" aria-hidden="true"
              style={{ animationDelay: `${total * STAGGER_MS}ms` }}>
              <Check size={11} strokeWidth={3} />
            </span>
          )}
          <span className="text-[15px] font-semibold">{headline}</span>
          {subline && <span className="text-[13px] text-vgray-400">{subline}</span>}
        </div>
        <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.max(1, total)}, minmax(0, 1fr))` }} aria-hidden="true">
          {steps.map((step, index) => (
            <div key={step.id || index} className="h-1 overflow-hidden rounded-full bg-[var(--bar-track)]">
              {step.status === "settled" && (
                <div className="cp-exec-fill h-full w-full rounded-full bg-[var(--cp-emerald)]" style={{ animationDelay: `${index * STAGGER_MS}ms` }} />
              )}
              {step.status === "failed" && <div className="h-full w-full rounded-full bg-[var(--cp-danger-fg)]" />}
              {step.status === "uncertain" && <div className="h-full w-full rounded-full bg-[var(--cp-amber)]" />}
              {IN_FLIGHT.has(step.status) && <div className="cp-exec-live h-full w-full rounded-full" />}
            </div>
          ))}
        </div>
      </div>

      <ol className="flex flex-col">
        {steps.map((step, index) => {
          const label = step.label || `${step.op} ${step.amount} ${step.asset}`;
          const isSettled = step.status === "settled";
          const isFailed = step.status === "failed";
          const isUncertain = step.status === "uncertain";
          const isInFlight = IN_FLIGHT.has(step.status);
          const waitsHere = step.status === "signing" && walletCanSign;
          const last = index === steps.length - 1;
          return (
            <li key={step.id || index} className={`flex gap-3.5 py-3 ${last ? "" : "border-b border-vgray-50"}`}>
              <StepMark status={step.status} delayMs={index * STAGGER_MS} fresh={freshIds.has(step.id || String(index))} waitsForWallet={waitsHere} />
              <div className="flex min-w-0 grow flex-col gap-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className={`text-[14px] leading-5 ${isSettled || isInFlight || isFailed || isUncertain ? "font-semibold text-vgray-900" : "font-medium text-vgray-400"}`}>
                    {label}
                  </span>
                  {step.status === "pending" && (
                    <span className="shrink-0 text-[12px] text-vgray-300">
                      {stopped ? "Not submitted" : index === nextIndex ? "Next" : ""}
                    </span>
                  )}
                  {isFailed && <span className="shrink-0 text-[12px] font-semibold text-[var(--cp-danger-fg)]">Not sent</span>}
                  {isUncertain && <span className="shrink-0 text-[12px] font-semibold text-[var(--cp-warn-fg)]">Outcome unknown</span>}
                </div>

                {isSettled && (
                  <div className="cp-exec-rise flex flex-wrap gap-x-2.5 gap-y-0.5 font-mono text-[11.5px] text-vgray-400" style={{ animationDelay: `${index * STAGGER_MS}ms` }}>
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
                  <p role="status" aria-live="polite" className="cp-exec-breathe font-mono text-[11.5px] text-violet-500">
                    {step.status === "claiming" ? "Checking it before it is sent…"
                      : step.status === "signing" ? "Signing…"
                        : "Waiting for the ledger to close…"}
                    <ElapsedSeconds />
                  </p>
                )}

                {waitsHere && (
                  <div className="mt-1 flex flex-wrap items-center gap-3">
                    {onSign && (
                      <button type="button" onClick={onSign} disabled={busy}
                        className="min-h-9 rounded-lg bg-[image:var(--cp-gradient)] px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50">
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

                {/* No Retry: resubmitting a transaction that may already have landed could run it twice. */}
                {isUncertain && (
                  <p className="text-[12.5px] leading-5 text-vgray-500">
                    {step.txHash ? (
                      <>It is not known whether this landed. <a href={`https://stellar.expert/explorer/${explorer}/tx/${step.txHash}`} target="_blank" rel="noreferrer" className="text-violet-500 hover:text-violet-600">Check it on the explorer ↗</a> before trying again.</>
                    ) : "It is not known whether this landed. Check your wallet's recent transactions before trying again."}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {onStop && !complete && !stopped && (
        <div className="flex justify-end">
          <button type="button" onClick={onStop} disabled={busy}
            className="min-h-9 rounded-lg border border-vgray-200 bg-surface px-3.5 py-2 text-[13px] font-semibold text-vgray-700 hover:bg-vgray-50 disabled:opacity-50">
            {autoApprove ? "Stop after this step" : "Cancel remaining steps"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Ids of the steps that settled while this card was on screen. Those get the ring-then-tick
 * finish; a step that was already settled when the card mounted (a restored run) keeps the
 * staggered pop. Purely a view of the status prop: nothing is stored or sent.
 */
function useFreshlySettled(steps: StepperStep[]): ReadonlySet<string> {
  const statusOf = () => Object.fromEntries(steps.map((step, index) => [step.id || String(index), step.status])) as Record<string, StepperStep["status"]>;
  const [track, setTrack] = useState(() => ({ statuses: statusOf(), fresh: [] as string[] }));
  const statuses = statusOf();
  const newlySettled = Object.keys(statuses).filter((id) => statuses[id] === "settled" && track.statuses[id] !== undefined && track.statuses[id] !== "settled" && !track.fresh.includes(id));
  if (newlySettled.length > 0 || Object.keys(statuses).some((id) => statuses[id] !== track.statuses[id])) {
    setTrack({ statuses, fresh: [...track.fresh, ...newlySettled] });
  }
  return new Set([...track.fresh, ...newlySettled]);
}

/** Whole seconds since this line appeared, shown once there is one to show: proof the step is still moving. */
function ElapsedSeconds() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return seconds > 0 ? <span className="ml-2 text-vgray-400">{seconds}s</span> : null;
}

const SVG_PROPS = { fill: "none", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

/**
 * One mark per state, no disc behind it: a card sliding into a wallet means the step is waiting
 * for you; a spinning arc means a transaction is in flight; a ring that closes and a tick that
 * draws means it settled; an X that draws means it did not go.
 */
function StepMark({ status, delayMs, fresh, waitsForWallet }: { status: StepperStep["status"]; delayMs: number; fresh: boolean; waitsForWallet: boolean }) {
  const box = "mt-px flex h-[22px] w-[22px] shrink-0 items-center justify-center";
  if (status === "settled") {
    return (
      <span aria-label="Settled" className={`${box} text-[var(--cp-emerald)]`}>
        <svg width="22" height="22" viewBox="0 0 24 24" {...SVG_PROPS} stroke="currentColor" className={fresh ? "" : "cp-exec-pop"} style={fresh ? undefined : { animationDelay: `${delayMs}ms` }}>
          {fresh && <circle className="cp-exec-ring" cx="12" cy="12" r="9" strokeWidth="2" />}
          <path className={fresh ? "cp-exec-tick cp-exec-tick-after" : "cp-exec-tick"} strokeWidth={fresh ? 2.4 : 2.6} d={fresh ? "M17 9.5 10.6 16l-3.4-3.4" : "M20 6 9 17l-5-5"} style={fresh ? undefined : { animationDelay: `${delayMs + 60}ms` }} />
        </svg>
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span aria-label="Failed" className={`${box} text-[var(--cp-danger-fg)]`}>
        <svg width="22" height="22" viewBox="0 0 24 24" {...SVG_PROPS} stroke="currentColor">
          <path className="cp-exec-cross" strokeWidth="2.6" d="M18 6 6 18M6 6l12 12" />
        </svg>
      </span>
    );
  }
  if (status === "uncertain") {
    return <span className="mt-px flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-[var(--cp-warn-bg)] text-[12px] font-semibold text-[var(--cp-warn-fg)]" aria-label="Outcome unknown">?</span>;
  }
  if (IN_FLIGHT.has(status) && waitsForWallet) {
    return (
      <span aria-label="Waiting for your wallet" className={`${box} text-violet-500`}>
        <svg width="22" height="22" viewBox="0 0 24 24" {...SVG_PROPS} stroke="currentColor" strokeWidth="1.8">
          <rect className="cp-exec-wallet-card" x="7.5" y="3" width="9" height="7" rx="1.4" />
          <path d="M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z" fill="var(--surface)" />
          <path d="M20 13h-3a1.8 1.8 0 0 0 0 3.6h3" />
          <circle cx="17.2" cy="14.8" r=".7" fill="currentColor" stroke="none" />
        </svg>
      </span>
    );
  }
  if (IN_FLIGHT.has(status)) {
    return (
      <span aria-label="In progress" className={`${box} text-violet-500`}>
        <svg width="22" height="22" viewBox="0 0 24 24" {...SVG_PROPS} strokeWidth="2.4" className="animate-spin">
          <circle cx="12" cy="12" r="9" stroke="var(--bar-track)" />
          <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" />
        </svg>
      </span>
    );
  }
  return <span className="mt-px h-[22px] w-[22px] shrink-0 rounded-full border-2 border-dashed border-vgray-200" aria-label="Not started" />;
}
