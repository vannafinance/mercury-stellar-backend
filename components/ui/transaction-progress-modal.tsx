"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useTheme } from "@/contexts/theme-context";
import { useTxProgressStore } from "@/store/tx-progress-store";
import { dismissTxProgressToBackground } from "@/lib/tx-progress";
import { useTxProgressFraction } from "@/hooks/use-tx-progress-fraction";

// Most step messages across the codebase already follow "Step X/Y: <what's
// happening>" (leverage-assets-tab, one-click-strategy, position-detail) —
// parsed here to know how many steps the WHOLE flow has, so each step only
// fills its own slice of the bar instead of restarting from 0 every time.
const STEP_PATTERN = /^Step\s+(\d+)\s*\/\s*(\d+)\s*:\s*(.*)$/i;

/**
 * App-wide "transaction in progress" overlay, mounted once at the root
 * layout (see app/layout.tsx) — replaces the old bottom-left
 * toast.loading(...) used for every multi-step on-chain flow (deposit,
 * borrow, repay, transfer collateral, one-click Lite mode). Flows drive it
 * via lib/tx-progress.ts's showTxStep/markTxSubmitted; this component only
 * reads the store, it never calls into a specific flow.
 *
 * The bar deliberately does NOT move while waiting on the wallet popup
 * (`phase: "signing"`) — that wait is entirely up to the user, so animating
 * "progress" during it would be fake motion with nothing behind it. Once a
 * step's tx is actually signed and submitted (`markTxSubmitted`,
 * `phase: "confirming"`), the bar climbs continuously toward that step's
 * slice of the whole bar, driven by real elapsed time. `showTxSuccess`
 * briefly forces the bar to 100% before closing, so it visibly finishes
 * instead of vanishing mid-fill.
 *
 * By design this never shows a completed/failed state itself beyond that
 * flash — showTxSuccess/showTxError close it and hand off to a normal
 * (bottom-right) toast. Dismissing it (the X button) hides the overlay but
 * hands off to a persistent bottom-right loading toast showing the same
 * step text (dismissTxProgressToBackground) — the underlying signed
 * transaction is already submitted and keeps running regardless, and this
 * way that isn't invisible. showTxSuccess/showTxError replace that toast in
 * place with the real result once the flow finishes.
 */
export function TransactionProgressModal() {
  const { isDark } = useTheme();
  const isOpen = useTxProgressStore((s) => s.isOpen);
  const message = useTxProgressStore((s) => s.message);
  const phase = useTxProgressStore((s) => s.phase);
  const forceComplete = useTxProgressStore((s) => s.forceComplete);

  const stepMatch = message.match(STEP_PATTERN);
  const stepIndex = stepMatch ? parseInt(stepMatch[1], 10) : 1;
  const stepTotal = stepMatch ? parseInt(stepMatch[2], 10) : 1;
  const title = stepMatch ? stepMatch[3] : message;

  // Same fraction the background toast's progress ring uses (see
  // dismissTxProgressToBackground) — single source of truth for the math so
  // the two never diverge.
  const progressPct = useTxProgressFraction() * 100;

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
              onClick={dismissTxProgressToBackground}
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

              {stepMatch && (
                <p className={`text-[11px] font-bold uppercase tracking-wide mb-2 ${isDark ? "text-[#B794F6]" : "text-[#703AE6]"}`}>
                  Step {stepIndex} of {stepTotal}
                </p>
              )}

              <h3 className={`text-[16px] font-bold leading-snug mb-1.5 ${isDark ? "text-white" : "text-[#1A1A1A]"}`}>
                {title}
              </h3>
              <p className={`text-[12px] mb-6 ${isDark ? "text-[#888]" : "text-[#888]"}`}>
                {phase === "signing" && !forceComplete
                  ? "Confirm in your wallet to continue"
                  : "This may take a few moments"}
              </p>

              <div className={`w-full h-1.5 rounded-full overflow-hidden ${isDark ? "bg-[#2A2A2A]" : "bg-[#F0F0F0]"}`}>
                <motion.div
                  className="h-full rounded-full bg-linear-to-r from-[#703AE6] to-[#9B6BFF]"
                  animate={{ width: `${progressPct}%` }}
                  transition={{ duration: forceComplete ? 0.25 : 0.3, ease: "easeOut" }}
                />
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
