"use client";

import toast from "react-hot-toast";
import { useTxProgressStore } from "@/store/tx-progress-store";

/**
 * Shared drop-in replacement for the old bottom-left
 * `toast.loading(...)` / `toast.success(...)` / `toast.error(...)` trio that
 * every multi-step on-chain flow (leverage-assets-tab, one-click-strategy,
 * position-detail, transfer-collateral, useMutationToast) used to define
 * locally under the names showStep/showStepSuccess/showStepError.
 *
 * `showTxStep` opens/updates the centered TransactionProgressModal instead of
 * a loading toast, so a step message like "Step 2/4: Borrowing 10.00 XLM..."
 * renders as a real progress bar. `showTxSuccess`/`showTxError` close that
 * modal and surface the final result as a normal (bottom-right) toast — the
 * modal never renders a completed/failed state itself, matching the
 * submit-then-toast pattern the UI redesign asked for.
 */
export function showTxStep(message: string): void {
  // Every new step needs its own wallet approval first — reset to "signing"
  // (no forward progress shown) even if the previous step had already
  // reached "confirming". See markTxSubmitted's doc comment for why the two
  // phases are visually different.
  useTxProgressStore.getState().set({ isOpen: true, message, phase: "signing", submittedAt: null });
}

/**
 * Call the instant a wallet returns a signed transaction (right after
 * `signTransaction(...)` resolves), before `sendTransaction`. Until this
 * fires, the modal is purely waiting on the USER (there is no "progress" to
 * animate — the wallet popup's timing is entirely up to them, so faking
 * forward motion during that wait was misleading, matching the "isn't this
 * just blinking, not real progress" complaint). Once called, the modal
 * switches to animating progress against elapsed wall-clock time, since
 * we're now waiting on the NETWORK — a bounded, genuinely "in progress" wait.
 */
export function markTxSubmitted(): void {
  useTxProgressStore.getState().set({ phase: "confirming", submittedAt: Date.now() });
}

export function showTxSuccess(message: string): void {
  // Briefly force the bar to its full width before closing, instead of
  // vanishing mid-fill (the asymptotic "confirming" curve never actually
  // reaches 100% on its own — see the modal's doc comment) — the bar should
  // visibly finish, THEN the popup goes away, not disappear at ~90%.
  useTxProgressStore.getState().set({ forceComplete: true });
  setTimeout(() => {
    useTxProgressStore.getState().set({ isOpen: false, phase: "signing", submittedAt: null, forceComplete: false });
    toast.success(message);
  }, 350);
}

export function showTxError(message: string): void {
  useTxProgressStore.getState().set({ isOpen: false, phase: "signing", submittedAt: null });
  toast.error(message);
}
