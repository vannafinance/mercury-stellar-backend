"use client";

import { Check, ChevronRight, ExternalLink, Loader2, XCircle } from "lucide-react";

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
  autoApprove?: boolean;
  onRetry?: (stepIndex: number) => void;
}

export function ExecutionStepper({
  steps,
  currentStepIndex,
  autoApprove = false,
  onRetry,
}: ExecutionStepperProps) {
  return (
    <div
      role="region"
      aria-label="Workflow execution progress"
      className="space-y-2.5 rounded-xl border border-vgray-100 bg-surface p-4 text-vgray-900 shadow-sm dark:border-slate-800 dark:bg-[#14151d] dark:text-slate-100"
    >
      <div className="mb-2 flex items-center justify-between border-b border-vgray-100 pb-2 dark:border-slate-800">
        <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-vgray-500 dark:text-slate-400">
          Execution Progress
        </span>
        <span className="font-mono text-[11px] text-violet-500 dark:text-violet-400">
          {autoApprove ? "Autonomous (Privy Session)" : "Step-by-Step Approval"}
        </span>
      </div>

      <div className="space-y-2">
        {steps.map((step, idx) => {
          const isCurrent = idx === currentStepIndex;
          const isSettled = step.status === "settled";
          const isFailed = step.status === "failed";
          const isInFlight = step.status === "signing" || step.status === "submitting" || step.status === "claiming";

          return (
            <div
              key={step.id || idx}
              className={`flex items-center justify-between rounded-lg border p-3 transition-colors ${
                isSettled
                  ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/40 dark:bg-emerald-950/20"
                  : isFailed
                    ? "border-red-200 bg-red-50/50 dark:border-red-900/40 dark:bg-red-950/20"
                    : isCurrent && isInFlight
                      ? "border-violet-300 bg-violet-50/50 dark:border-violet-800/60 dark:bg-violet-950/20"
                      : "border-vgray-100 bg-vgray-50/40 opacity-70 dark:border-slate-800/60 dark:bg-slate-950/40"
              }`}
            >
              <div className="flex items-center gap-3">
                {/* Step status icon */}
                <div
                  className={`flex h-6 w-6 items-center justify-center rounded-full font-mono text-[11px] font-bold ${
                    isSettled
                      ? "bg-emerald-500 text-white"
                      : isFailed
                        ? "bg-red-500 text-white"
                        : isInFlight
                          ? "bg-violet-500 text-white"
                          : "bg-vgray-200 text-vgray-600 dark:bg-slate-800 dark:text-slate-400"
                  }`}
                >
                  {isSettled ? (
                    <Check size={13} />
                  ) : isFailed ? (
                    <XCircle size={13} />
                  ) : isInFlight ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    idx + 1
                  )}
                </div>

                {/* Step label & detail */}
                <div>
                  <h5 className="text-[13px] font-semibold text-vgray-800 dark:text-slate-200">
                    {step.label || `${step.op} ${step.amount} ${step.asset}`}
                  </h5>
                  <div className="flex items-center gap-2 font-mono text-[10.5px] text-vgray-500 dark:text-slate-400">
                    {step.txHash ? (
                      <a
                        href={`https://stellar.expert/explorer/testnet/tx/${step.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-violet-500 underline hover:text-violet-600 dark:text-violet-400"
                      >
                        <span>tx {step.txHash.slice(0, 8)}…</span>
                        <ExternalLink size={10} />
                      </a>
                    ) : (
                      <span>{step.amount} {step.asset}</span>
                    )}
                    {step.ledger && (
                      <span>· ledger #{step.ledger}</span>
                    )}
                    {step.error && (
                      <span className="text-red-500 dark:text-red-400">· {step.error}</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Status text badge */}
              <div className="text-right font-mono text-[11px]">
                {isSettled && <span className="font-semibold text-emerald-600 dark:text-emerald-400">Settled</span>}
                {step.status === "signing" && <span className="font-semibold text-violet-500 dark:text-violet-400">Signing…</span>}
                {step.status === "submitting" && <span className="font-semibold text-violet-500 dark:text-violet-400">Broadcasting…</span>}
                {step.status === "claiming" && <span className="font-semibold text-violet-500 dark:text-violet-400">Pre-flight…</span>}
                {step.status === "pending" && <span className="text-vgray-400 dark:text-slate-500">Queued</span>}
                {isFailed && onRetry && (
                  <button
                    type="button"
                    onClick={() => onRetry(idx)}
                    className="font-bold text-red-500 underline hover:text-red-600 dark:text-red-400"
                  >
                    Retry
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
