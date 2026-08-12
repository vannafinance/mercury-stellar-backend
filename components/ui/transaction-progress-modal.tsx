"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useTheme } from "@/contexts/theme-context";
import { useTxProgressStore } from "@/store/tx-progress-store";

// Most step messages across the codebase already follow "Step X/Y: <what's
// happening>" (leverage-assets-tab, one-click-strategy, position-detail) —
// parsed here to drive a real progress bar instead of an indeterminate one.
const STEP_PATTERN = /^Step\s+(\d+)\s*\/\s*(\d+)\s*:\s*(.*)$/i;

/**
 * App-wide "transaction in progress" overlay, mounted once at the root
 * layout (see app/layout.tsx) — replaces the old bottom-left
 * toast.loading(...) used for every multi-step on-chain flow (deposit,
 * borrow, repay, transfer collateral, one-click Lite mode). Flows drive it
 * via lib/tx-progress.ts's showTxStep; this component only reads the store,
 * it never calls into a specific flow.
 *
 * By design this never shows a completed/failed state itself — showTxSuccess
 * /showTxError close it and hand off to a normal (bottom-right) toast, so the
 * overlay's whole lifecycle is just "something is in flight right now".
 * Dismissing it (the X button) only hides the overlay; the underlying signed
 * transaction is already submitted and keeps running regardless.
 */
export function TransactionProgressModal() {
  const { isDark } = useTheme();
  const isOpen = useTxProgressStore((s) => s.isOpen);
  const message = useTxProgressStore((s) => s.message);

  const stepMatch = message.match(STEP_PATTERN);
  const stepIndex = stepMatch ? parseInt(stepMatch[1], 10) : null;
  const stepTotal = stepMatch ? parseInt(stepMatch[2], 10) : null;
  const title = stepMatch ? stepMatch[3] : message;
  const progressPct =
    stepIndex != null && stepTotal
      ? Math.min(100, (stepIndex / stepTotal) * 100)
      : null;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4"
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 16 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 16 }}
            transition={{ type: "spring", damping: 28, stiffness: 320 }}
            className={`w-full max-w-[360px] rounded-2xl shadow-2xl overflow-hidden relative ${
              isDark ? "bg-[#171717] border border-[#2A2A2A]" : "bg-white border border-[#E8E8E8]"
            }`}
          >
            <button
              type="button"
              onClick={() => useTxProgressStore.getState().set({ isOpen: false })}
              aria-label="Dismiss"
              className={`absolute top-4 right-4 w-8 h-8 rounded-full flex items-center justify-center transition-colors cursor-pointer ${
                isDark ? "bg-[#242424] hover:bg-[#2E2E2E] text-[#999]" : "bg-[#F2F2F2] hover:bg-[#E8E8E8] text-[#777]"
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>

            <div className="flex flex-col items-center text-center px-8 pt-11 pb-8">
              <div className="w-16 h-16 mb-6">
                <svg viewBox="0 0 48 48" className="w-16 h-16 animate-spin" style={{ animationDuration: "1.1s" }}>
                  <circle cx="24" cy="24" r="20" fill="none" stroke={isDark ? "#2A2A2A" : "#EFEAFB"} strokeWidth="4" />
                  <circle
                    cx="24"
                    cy="24"
                    r="20"
                    fill="none"
                    stroke="#703AE6"
                    strokeWidth="4"
                    strokeLinecap="round"
                    strokeDasharray="94"
                    strokeDashoffset="66"
                  />
                </svg>
              </div>

              {stepIndex != null && stepTotal != null && (
                <p className={`text-[11px] font-bold uppercase tracking-wide mb-2 ${isDark ? "text-[#B794F6]" : "text-[#703AE6]"}`}>
                  Step {stepIndex} of {stepTotal}
                </p>
              )}

              <h3 className={`text-[16px] font-bold leading-snug mb-1.5 ${isDark ? "text-white" : "text-[#1A1A1A]"}`}>
                {title}
              </h3>
              <p className={`text-[12px] mb-6 ${isDark ? "text-[#888]" : "text-[#888]"}`}>
                This may take a few moments
              </p>

              <div className={`w-full h-1.5 rounded-full overflow-hidden ${isDark ? "bg-[#2A2A2A]" : "bg-[#F0F0F0]"}`}>
                {progressPct != null ? (
                  <motion.div
                    className="h-full rounded-full bg-linear-to-r from-[#703AE6] to-[#9B6BFF]"
                    initial={{ width: 0 }}
                    animate={{ width: `${progressPct}%` }}
                    transition={{ duration: 0.4, ease: "easeOut" }}
                  />
                ) : (
                  <motion.div
                    className="h-full w-1/3 rounded-full bg-linear-to-r from-[#703AE6] to-[#9B6BFF]"
                    animate={{ x: ["-100%", "220%"] }}
                    transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
                  />
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
