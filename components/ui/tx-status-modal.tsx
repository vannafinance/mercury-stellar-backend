"use client";

import { Modal } from "@/components/ui/modal";
import { useTheme } from "@/contexts/theme-context";

/**
 * Live transaction-progress modal — spinner while pending, check/X on
 * settle, with a `message` that callers update between on-chain steps (e.g.
 * "Step 1/2: Depositing 10 XLM...", then "Step 2/2: Borrowing 10 XLM...").
 * Extracted from the Lite one-click flow (`components/lite-mode/one-click-strategy.tsx`)
 * so every multi-step margin operation (deposit+borrow, dual borrow, repay,
 * transfer) can show the same live progress instead of a static "Processing..."
 * button with no visibility into which step failed.
 */
export interface TxModalState {
  open: boolean;
  status: "pending" | "success" | "error";
  title: string;
  message: string;
  txHash?: string;
}

export const INITIAL_TX_MODAL_STATE: TxModalState = {
  open: false,
  status: "pending",
  title: "",
  message: "",
};

interface TxStatusModalProps {
  state: TxModalState;
  onClose: () => void;
}

export const TxStatusModal = ({ state, onClose }: TxStatusModalProps) => {
  const { isDark } = useTheme();
  const headingText = isDark ? "text-white" : "text-[#111111]";
  const labelText = isDark ? "text-[#919191]" : "text-[#76737B]";
  const mutedText = isDark ? "text-[#595959]" : "text-[#A9A9A9]";

  return (
    <Modal open={state.open} onClose={() => state.status !== "pending" && onClose()}>
      <div className={`w-[340px] sm:w-[400px] rounded-[20px] p-6 flex flex-col gap-5 ${isDark ? "bg-[#1A1A1A] border border-[#2C2C2C]" : "bg-white border border-[#E5E7EB]"}`}>
        <div className="flex items-center justify-center pt-2">
          {state.status === "pending" && (
            <div className="w-14 h-14 rounded-full border-4 border-[#703AE6]/30 border-t-[#703AE6] animate-spin" />
          )}
          {state.status === "success" && (
            <div className="w-14 h-14 rounded-full bg-[#10B981]/15 flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          )}
          {state.status === "error" && (
            <div className="w-14 h-14 rounded-full bg-[#FC5457]/15 flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#FC5457" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </div>
          )}
        </div>
        <div className="text-center">
          <h3 className={`text-[16px] font-bold mb-1.5 ${headingText}`}>{state.title}</h3>
          <p className={`text-[13px] leading-[20px] ${labelText}`}>{state.message}</p>
          {state.txHash && (
            <p className={`text-[11px] mt-2 font-mono ${mutedText}`}>
              {state.txHash.slice(0, 8)}...{state.txHash.slice(-8)}
            </p>
          )}
        </div>
        {state.status !== "pending" && (
          <button
            type="button"
            onClick={onClose}
            className="w-full text-white text-[14px] font-semibold py-3 rounded-[12px] hover:opacity-90 transition-opacity"
            style={{ background: "linear-gradient(135deg, #703AE6 0%, #FF007A 100%)" }}
          >
            Close
          </button>
        )}
      </div>
    </Modal>
  );
};
