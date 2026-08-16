"use client";

import { useEffect, useState } from "react";
import { useTxProgressStore } from "@/store/tx-progress-store";

// Kept identical to TransactionProgressModal's own constants — both read
// this same shared fraction so the modal's bar and the background toast's
// progress ring (shown after the modal is dismissed) never diverge.
const STEP_PATTERN = /^Step\s+(\d+)\s*\/\s*(\d+)\s*:\s*(.*)$/i;
const TIME_CONSTANT_MS = 6000;
const ASYMPTOTE = 0.94;

/**
 * 0..1 fraction of the whole multi-step tx flow completed so far, driven by
 * `useTxProgressStore` (message step prefix, phase, submittedAt,
 * forceComplete). See TransactionProgressModal's doc comment for why the
 * "confirming" phase animates on an asymptotic curve rather than jumping to
 * 100% — the same reasoning applies here.
 */
export function useTxProgressFraction(): number {
  const message = useTxProgressStore((s) => s.message);
  const phase = useTxProgressStore((s) => s.phase);
  const submittedAt = useTxProgressStore((s) => s.submittedAt);
  const forceComplete = useTxProgressStore((s) => s.forceComplete);

  // Re-renders on an interval only while actually animating (mirrors the
  // modal's own tick effect) — otherwise idle while "signing" or done.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (phase !== "confirming" || forceComplete) return;
    const id = setInterval(() => forceTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, [phase, forceComplete]);

  const stepMatch = message.match(STEP_PATTERN);
  const stepIndex = stepMatch ? parseInt(stepMatch[1], 10) : 1;
  const stepTotal = stepMatch ? parseInt(stepMatch[2], 10) : 1;

  const baseFraction = (stepIndex - 1) / stepTotal;
  const sliceSize = 1 / stepTotal;
  let withinStepFraction = 0;
  if (forceComplete) {
    withinStepFraction = 1;
  } else if (phase === "confirming" && submittedAt != null) {
    const elapsed = Date.now() - submittedAt;
    withinStepFraction = ASYMPTOTE * (1 - Math.exp(-elapsed / TIME_CONSTANT_MS));
  }
  return Math.min(1, baseFraction + sliceSize * withinStepFraction);
}
