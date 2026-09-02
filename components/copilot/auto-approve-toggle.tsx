"use client";

// Wallet-menu row: "Copilot auto-approve" on/off switch (Privy only).
//
// Styled to match the navbar dropdown's Dark Mode row. Shows only for Privy
// wallets (Freighter always prompts via its extension, so a session toggle
// can't apply). On a wallet's FIRST sign-in the toggle defaults ON and a
// one-time toast explains the benefit. State is per wallet address, persisted.

import { useEffect } from "react";
import toast from "react-hot-toast";
import { useTheme } from "@/contexts/theme-context";
import { useUserStore } from "@/store/user";
import {
  useCopilotSettingsStore,
  setAutoApprove,
  markSeenAndDefaultOff,
} from "@/store/copilot-settings";

export function CopilotAutoApproveToggle() {
  const { isDark } = useTheme();
  const address = useUserStore((s) => s.address);
  const walletKind = useUserStore((s) => s.walletKind);
  const on = useCopilotSettingsStore((s) => (address ? !!s.autoApproveByWallet[address] : false));

  // First sign-in for this Privy wallet → default OFF; one-time tip that they can enable.
  useEffect(() => {
    if (walletKind !== "privy" || !address) return;
    const firstTime = markSeenAndDefaultOff(address);
    if (firstTime) {
      toast(
        "Copilot auto-approve is off — each action needs your approval. Turn it on in this menu for hands-free runs.",
        { duration: 6000 },
      );
    }
  }, [walletKind, address]);

  // Privy only.
  if (walletKind !== "privy" || !address) return null;

  return (
    <button
      onClick={() => setAutoApprove(address, !on)}
      className={`w-full flex items-center gap-3 px-3 py-[10px] rounded-[10px] cursor-pointer transition-colors ${
        isDark ? "text-[#C0C0C0] hover:bg-[#1E1E1E]" : "text-[#3A3A3A] hover:bg-[#F5F5F5]"
      }`}
      type="button"
    >
      <div
        className={`w-8 h-8 rounded-[8px] flex items-center justify-center shrink-0 ${
          isDark ? "bg-[#242424]" : "bg-[#F0F0F0]"
        }`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path
            d="M9 12l2 2 4-4"
            stroke={on ? "#703AE6" : "#A0A0A0"}
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="12" r="9" stroke={on ? "#703AE6" : "#A0A0A0"} strokeWidth="1.5" />
        </svg>
      </div>
      <div className="flex-1 text-left">
        <p className="text-[13px] font-semibold leading-tight">Copilot auto-approve</p>
        <p className={`text-[11px] mt-0.5 ${isDark ? "text-[#666]" : "text-[#999]"}`}>
          {on ? "On · actions run without signing" : "Off · sign each action"}
        </p>
      </div>
      <div
        role="switch"
        aria-checked={on}
        className={`relative w-9 h-5 rounded-full transition-colors duration-200 shrink-0 ${
          on ? "bg-[#703AE6]" : "bg-[#D1D5DB]"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${
            on ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </div>
    </button>
  );
}

export default CopilotAutoApproveToggle;
