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
  // Wallets we've already shown the first-visit notice for (do not re-toast).
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
 * First visit for this wallet: mark seen and leave auto-approve OFF.
 * Returns true if this was the first time (caller may show an optional tip),
 * false if we've already onboarded this wallet.
 *
 * Safety default: user must explicitly enable auto-approve in the wallet menu.
 */
export function markSeenAndDefaultOff(address: string): boolean {
  if (!address) return false;
  const s = useCopilotSettingsStore.getState();
  if (s.seenByWallet[address]) return false;
  s.set({
    seenByWallet: { [address]: true },
    // Explicit OFF — do not auto-enable session signing on first connect.
    autoApproveByWallet: { [address]: false },
  });
  return true;
}

/** @deprecated Use markSeenAndDefaultOff — auto-approve now defaults OFF. */
export function markSeenAndDefaultOn(address: string): boolean {
  return markSeenAndDefaultOff(address);
}
