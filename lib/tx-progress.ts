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
  useTxProgressStore.getState().set({ isOpen: true, message });
}

export function showTxSuccess(message: string): void {
  useTxProgressStore.getState().set({ isOpen: false });
  toast.success(message);
}

export function showTxError(message: string): void {
  useTxProgressStore.getState().set({ isOpen: false });
  toast.error(message);
}
