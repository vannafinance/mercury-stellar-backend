"use client";

import { Check, ChevronRight, Loader2, ShieldCheck, XCircle } from "lucide-react";

export interface StepApprovalCardProps {
  stepIndex: number;
  totalSteps: number;
  op: string;
  label: string;
  asset: string;
  amount: string;
  tool?: string;
  args?: Record<string, unknown>;
  projectedHf?: string | null;
  signing?: boolean;
  settled?: boolean;
  error?: string | null;
  onSign: () => void;
  onSkip?: () => void;
  onAbort?: () => void;
}

const BTN_GRADIENT = "bg-[linear-gradient(135deg,#ff6b6e_0%,#8557ef_100%)] text-white hover:opacity-95 active:opacity-100 transition-opacity shadow-sm";

export function StepApprovalCard({
  stepIndex,
  totalSteps,
  op,
  label,
  asset,
  amount,
  tool,
  args,
  projectedHf,
  signing = false,
  settled = false,
  error = null,
  onSign,
  onSkip,
  onAbort,
}: StepApprovalCardProps) {
  return (
    <div
      role="region"
      aria-label={`Step ${stepIndex} approval`}
      className="rounded-xl border border-violet-500/50 bg-surface p-4 text-vgray-900 shadow-md dark:border-violet-500/40 dark:bg-[#14151d] dark:text-slate-100"
      style={{ borderLeft: "3px solid #8b5cf6" }}
    >
      {/* Header */}
      <div className="mb-3 flex items-center justify-between border-b border-vgray-100 pb-2.5 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-violet-500 dark:text-violet-400">
            {settled ? "Step Complete" : "Action Approval Required"}
          </span>
        </div>
        <span className="font-mono text-[11px] text-vgray-500 dark:text-slate-400">
          Step {stepIndex} of {totalSteps}
        </span>
      </div>

      {/* Main Step Detail */}
      <div className="mb-3">
        <h4 className="text-[14px] font-semibold leading-snug text-vgray-900 dark:text-slate-100">
          {label || `${op.replaceAll("_", " ")} ${amount} ${asset}`}
        </h4>
        <p className="mt-0.5 font-mono text-[12px] text-vgray-500 dark:text-slate-400">
          Amount: <span className="font-bold text-vgray-800 dark:text-slate-200">{amount} {asset}</span>
          {projectedHf && (
            <span className="ml-2.5 border-l border-vgray-200 pl-2.5 dark:border-slate-700">
              Projected HF: <span className="font-bold text-violet-500 dark:text-violet-400">{projectedHf}</span>
            </span>
          )}
        </p>
      </div>

      {/* Tool Call Envelope Preview */}
      {(tool || args) && (
        <div className="mb-3.5 rounded-lg border border-vgray-100 bg-vgray-50 p-2.5 font-mono text-[11px] text-vgray-600 dark:border-slate-800/80 dark:bg-slate-950/60 dark:text-slate-400">
          {tool && (
            <div className="flex items-center justify-between">
              <span className="text-vgray-400 dark:text-slate-500">Tool / Contract:</span>
              <span className="font-semibold text-vgray-700 dark:text-slate-300">{tool}</span>
            </div>
          )}
          {args && (
            <div className="mt-1 flex items-start justify-between">
              <span className="text-vgray-400 dark:text-slate-500">Parameters:</span>
              <span className="text-right text-vgray-700 dark:text-slate-300">
                {Object.entries(args).map(([k, v]) => `${k}=${String(v)}`).join(", ")}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-2.5 text-[12px] text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          <XCircle size={14} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex items-center justify-between pt-1">
        {onAbort ? (
          <button
            type="button"
            onClick={onAbort}
            disabled={signing}
            className="text-[12px] font-medium text-vgray-400 transition-colors hover:text-red-500 disabled:opacity-50 dark:text-slate-500 dark:hover:text-red-400"
          >
            Abort plan
          </button>
        ) : <div />}

        <div className="flex items-center gap-2">
          {onSkip && !settled && (
            <button
              type="button"
              onClick={onSkip}
              disabled={signing}
              className="rounded-lg border border-vgray-200 px-3 py-1.5 text-[12px] font-medium text-vgray-600 transition-colors hover:bg-vgray-100 disabled:opacity-50 dark:border-slate-800 dark:text-slate-400 dark:hover:bg-slate-900"
            >
              Skip leg
            </button>
          )}

          {settled ? (
            <div className="flex items-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-1.5 text-[12px] font-bold text-emerald-600 dark:text-emerald-400">
              <Check size={14} />
              <span>Confirmed on-chain</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={onSign}
              disabled={signing}
              className={`flex items-center gap-1.5 rounded-lg px-4 py-2 text-[12.5px] font-bold ${BTN_GRADIENT} disabled:opacity-60`}
            >
              {signing ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  <span>Signing in wallet…</span>
                </>
              ) : (
                <>
                  <span>Sign &amp; Execute Step {stepIndex}</span>
                  <ChevronRight size={13} />
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
