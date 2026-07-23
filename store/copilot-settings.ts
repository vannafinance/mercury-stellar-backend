import createNewStore from "@/zustand/index";

// Copilot per-wallet settings.
//
// `autoApprove` = "session signing" toggle. When ON, the copilot executes a
// (single-leg, risk-allowed) write immediately after the preview WITHOUT the
// manual "Approve & sign" click — a frictionless session the user grants. When
// OFF, every write requires the explicit approval step. Privy embedded wallets
// only (Freighter always prompts via its extension, so the toggle is hidden for
// it). Keyed by wallet address so each wallet keeps its own switch. Persisted so
// the choice survives reloads.

export interface CopilotSettings {
  autoApproveByWallet: Record<string, boolean>;
  // Wallets we've already defaulted-on + shown the benefit for (first sign-in).
  seenByWallet: Record<string, boolean>;
}

const initialState: CopilotSettings = {
  autoApproveByWallet: {},
  seenByWallet: {},
};

export const useCopilotSettingsStore = createNewStore(initialState, {
  name: "copilot-settings",
  devTools: true,
  persist: { name: "copilot-settings", version: 1 },
});

/** Non-reactive read — is auto-approve ON for this wallet? */
export function isAutoApprove(address?: string | null): boolean {
  if (!address) return false;
  return !!useCopilotSettingsStore.getState().autoApproveByWallet[address];
}

/** Set the toggle for a wallet. */
export function setAutoApprove(address: string, value: boolean): void {
  useCopilotSettingsStore.getState().set({ autoApproveByWallet: { [address]: value } });
}

/**
 * First sign-in for this wallet: default the toggle ON and mark it seen.
 * Returns true if this was the first time (so the caller can show the benefit),
 * false if we've already onboarded this wallet.
 */
export function markSeenAndDefaultOn(address: string): boolean {
  if (!address) return false;
  const s = useCopilotSettingsStore.getState();
  if (s.seenByWallet[address]) return false;
  s.set({
    seenByWallet: { [address]: true },
    autoApproveByWallet: { [address]: true },
  });
  return true;
}
