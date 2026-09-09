"use client";

import { ChevronRight, Sparkles } from "lucide-react";
import type { Candidate, CandidateSet } from "@/lib/copilot/investigation/candidates";

export interface StrategyOptionsGridProps {
  candidates: CandidateSet;
  selectedCandidateId?: string | null;
  onSelectCandidate: (candidate: Candidate) => void;
}

const money = (value: string) =>
  `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function StrategyOptionsGrid({
  candidates,
  selectedCandidateId,
  onSelectCandidate,
}: StrategyOptionsGridProps) {
  if (!candidates.feasible.length && !candidates.rejected.length) return null;

  return (
    <div className="mt-3.5 space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-vgray-500 dark:text-slate-400">
          Options
        </span>
        <span className="text-[11px] text-vgray-400 dark:text-slate-500">
          Ranked by net carry
        </span>
      </div>

      {/* Feasible strategy cards */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {candidates.feasible.map((candidate, idx) => {
          const isSelected = selectedCandidateId === candidate.id;
          const isTopCarry = idx === 0 && candidate.borrows;

          return (
            <div
              key={candidate.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelectCandidate(candidate)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelectCandidate(candidate); }}
              className={`relative flex flex-col justify-between rounded-xl border p-3.5 text-left transition-all cursor-pointer ${
                isSelected
                  ? "border-violet-500 bg-violet-50/40 shadow-sm dark:border-violet-500 dark:bg-violet-950/30"
                  : isTopCarry
                    ? "border-violet-300 bg-surface hover:border-violet-400 hover:shadow-sm dark:border-violet-800/60 dark:bg-slate-900/40 dark:hover:border-violet-700"
                    : "border-vgray-100 bg-surface hover:border-vgray-200 hover:shadow-sm dark:border-slate-800 dark:bg-slate-900/20 dark:hover:border-slate-700"
              }`}
              style={{ borderLeft: isTopCarry ? "3px solid #8b5cf6" : undefined }}
            >
              <div>
                {/* Header tags */}
                <div className="mb-2 flex items-center justify-between">
                  <span
                    className={`rounded font-mono text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 ${
                      candidate.borrows
                        ? "bg-violet-100 text-violet-700 dark:bg-violet-950/80 dark:text-violet-300 dark:border dark:border-violet-800/50"
                        : "bg-vgray-100 text-vgray-700 dark:bg-slate-800 dark:text-slate-300"
                    }`}
                  >
                    {isTopCarry ? "Top Yield ★" : candidate.borrows ? "Leveraged" : "No Borrowing"}
                  </span>
                  <span className="font-mono text-[12px] font-bold text-emerald-600 dark:text-emerald-400">
                    {candidate.netAprPct ? `+${candidate.netAprPct}% net APR` : `+${candidate.supplyAprPct}% supply`}
                  </span>
                </div>

                {/* Candidate Label */}
                <h4 className="text-[13px] font-semibold leading-snug text-vgray-900 dark:text-slate-100">
                  {candidate.label}
                </h4>

                {/* Amount & HF */}
                <p className="mt-1 font-mono text-[11px] text-vgray-500 dark:text-slate-400">
                  {money(candidate.amountUsd)}
                  {candidate.finalHealthFactor && (
                    <span> · health factor {candidate.finalHealthFactor} after</span>
                  )}
                </p>
              </div>

              {/* Action link */}
              <div className="mt-3 flex items-center justify-end border-t border-vgray-100 pt-2 text-[11.5px] font-semibold text-violet-600 dark:border-slate-800/60 dark:text-violet-400">
                <span className="flex items-center gap-1">
                  <span>Select strategy</span>
                  <ChevronRight size={13} />
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Ruled-out shapes accordion */}
      {candidates.rejected.length > 0 && (
        <details className="mt-2 rounded-xl border border-vgray-100 bg-vgray-50/50 p-2.5 dark:border-slate-800/80 dark:bg-slate-950/40">
          <summary className="cursor-pointer font-mono text-[11px] text-vgray-500 hover:text-vgray-700 dark:text-slate-400 dark:hover:text-slate-300 select-none">
            {candidates.rejected.length} {candidates.rejected.length === 1 ? "strategy" : "strategies"} ruled out
          </summary>
          <div className="mt-2 space-y-1.5 border-t border-vgray-100 pt-2 text-[11.5px] dark:border-slate-800/80">
            {candidates.rejected.map((r, i) => (
              <div key={i} className="flex items-start gap-2 text-vgray-600 dark:text-slate-400">
                <span className="font-mono text-red-500">✕</span>
                <span>
                  <strong className="text-vgray-800 dark:text-slate-200">Ruled out — {r.label}:</strong> {r.reason}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
