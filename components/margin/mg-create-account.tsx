"use client";

/**
 * "Create your Margin Account" — the two dialogues the Margin page has always shown (restored from
 * the pre-V3 leverage tab): 1) what a margin account is, 2) the borrow agreement with its checkbox
 * and Sign. Signing runs AccountManager `create_account` (store `createMarginAccount`, which drives the
 * transaction-progress modal and its toasts). After creation the account is rediscovered and the
 * per-wallet snapshot refetched, so the page leaves the pre-creation state.
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import { Dialogue } from "@/components/ui/dialogue";
import { useMarginAccountInfoStore, createMarginAccount, checkUserMarginAccount } from "@/store/margin-account-info-store";
import { ACCOUNT_SNAPSHOT_KEY } from "@/hooks/use-account-snapshot";

/** The agreement's sections, word for word as before. */
const TERMS: { line: string; points: string[] }[] = [
  {
    line: "Collateral Requirement",
    points: ["All borrowed positions must remain fully collateralized.", "If collateral value falls below the liquidation threshold, your position may be liquidated."],
  },
  {
    line: "Borrow Limits & Leverage",
    points: ["You may only borrow assets up to the maximum Loan-to-Value (LTV) allowed.", "Leverage is enabled only when collateral value supports it."],
  },
  {
    line: "Interest & Fees",
    points: ["Interest rates are variable and accrue in real time.", "Additional protocol fees may apply for borrowing or liquidation events."],
  },
  {
    line: "Liquidation Risk",
    points: [
      "Market volatility can reduce collateral value.",
      "If your position health factor drops below safe limits, collateral may be partially or fully liquidated without prior notice.",
    ],
  },
  {
    line: "User Responsibility",
    points: ["You are responsible for monitoring your positions, balances, and risks.", "VANNA is a non-custodial protocol; all actions are initiated by your wallet."],
  },
  {
    line: "No Guarantee of Returns",
    points: ["Using borrowed assets in trading, farming, or external protocols involves risk.", "VANNA does not guarantee profits or protection against losses."],
  },
];

/** Backdrop + spring-in card, as the original dialogues animated. */
function DialogueShell({ maxWidth, onClose, children }: { maxWidth: number; onClose: () => void; children: React.ReactNode }) {
  return (
    <motion.div
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-[#45454566] p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
      onClick={onClose}
    >
      <motion.div
        className="w-full"
        style={{ maxWidth }}
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 20 }}
        transition={{ duration: 0.3 }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

/** Two steps, as before: what a margin account is, then the agreement + Sign. */
export function CreateAccountModal({ address, onClose }: { address: string; onClose: () => void }) {
  const qc = useQueryClient();
  const creating = useMarginAccountInfoStore((s) => s.isCreatingAccount);
  const [step, setStep] = useState<"intro" | "sign">("intro");

  const sign = async () => {
    if (creating) return;
    try {
      // createMarginAccount (store) already drives the progress modal and the final toast.
      const created = await createMarginAccount(address);
      if (created) {
        await checkUserMarginAccount(address);
        // The snapshot was read before the account existed — refetch it.
        qc.invalidateQueries({ queryKey: [...ACCOUNT_SNAPSHOT_KEY, address] });
        onClose();
      }
    } catch (error) {
      console.error("Failed to create margin account:", error);
    }
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {step === "intro" ? (
        <DialogueShell key="intro" maxWidth={380} onClose={onClose}>
          <Dialogue
            buttonOnClick={() => {
              // An interrupted earlier attempt can leave the flag set; reset it on entering the next step.
              useMarginAccountInfoStore.getState().set({ isCreatingAccount: false });
              setStep("sign");
            }}
            buttonText="Create Your Account"
            content={[
              { line: "Connect your wallet to get started." },
              { line: "Confirm your Margin Account — we will generate a unique address for you." },
              { line: "Make a deposit to activate borrowing." },
            ]}
            heading="Create Margin Account"
            onClose={onClose}
          />
        </DialogueShell>
      ) : (
        <DialogueShell key="sign" maxWidth={480} onClose={onClose}>
          <Dialogue
            description="Before you proceed, please review and accept the terms of borrowing on VANNA. This agreement ensures you understand the risks, responsibilities, and conditions associated with using the platform."
            buttonOnClick={() => void sign()}
            buttonText={creating ? "Creating Account..." : "Sign Agreement"}
            content={TERMS}
            heading="Review and Sign Agreement"
            checkboxContent="I have read and agree to the VANNA Borrow Agreement."
            onClose={onClose}
          />
        </DialogueShell>
      )}
    </AnimatePresence>,
    document.body,
  );
}
