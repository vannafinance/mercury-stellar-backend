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
}

const initialState: TxProgressState = {
  isOpen: false,
  message: "",
};

export const useTxProgressStore = createNewStore(initialState, {
  name: "tx-progress-store",
});
