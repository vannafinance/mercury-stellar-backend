import createNewStore from "@/zustand/index";

// Drives the app-wide TransactionProgressModal (components/ui/transaction-progress-modal.tsx).
// Kept as its own tiny store (not folded into margin-account-info-store) since
// it's used by flows well outside margin — one-click Lite mode, Earn
// supply/withdraw — anything driving a multi-step on-chain flow via
// lib/tx-progress.ts's showTxStep/showTxSuccess/showTxError.

export interface TxProgressState {
  isOpen: boolean;
  /** Current step's message, e.g. "Step 2/4: Borrowing 10.00 XLM..." or a plain sentence with no step prefix. */
  message: string;
  /**
   * 'signing' — waiting on the user's wallet popup; nothing is submitted yet,
   * so the modal shows no forward progress (there's genuinely none to show).
   * 'confirming' — the wallet returned a signed tx and it's now in flight to
   * the network; the modal animates progress from here, driven by
   * `submittedAt`. Reset to 'signing' on every new `showTxStep` call, since
   * each step needs its own wallet approval first.
   */
  phase: "signing" | "confirming";
  /** `Date.now()` when `phase` last became "confirming" — null while "signing". */
  submittedAt: number | null;
  /** True for a brief window after success, forcing the bar to render at
   * 100% before the modal closes — see lib/tx-progress.ts's showTxSuccess. */
  forceComplete: boolean;
}

const initialState: TxProgressState = {
  isOpen: false,
  message: "",
  phase: "signing",
  submittedAt: null,
  forceComplete: false,
};

export const useTxProgressStore = createNewStore(initialState, {
  name: "tx-progress-store",
});
