/**
 * The wallet the user last CHOSE, kept across page loads.
 *
 * Wallet state is memory-only (`store/user.ts`), so after a reload nothing remembered whether the user had logged out,
 * or which wallet they picked. Two things followed (26 Oct, live, local and deployed):
 *
 *  - Disconnect, then hard-reload: the Freighter extension is already authorised for the site, so the passive check
 *    connected it again.
 *  - Log in with Privy (a full-page Google redirect back to the app): the passive Freighter check ran before Privy had
 *    finished, set the active wallet to Freighter, and the Privy bridge then refused to replace what it took for an
 *    explicitly selected external wallet, so Privy never took over.
 *
 * Only an explicit action writes this: a click on Connect (Privy or Freighter) or on Disconnect. The passive check never does,
 * so a Freighter that was merely authorised is not a choice. Never throws: storage can be blocked or full.
 */
export type WalletChoice = "privy" | "freighter" | "none";

export const WALLET_CHOICE_KEY = "vanna:wallet-choice";

export function readWalletChoice(): WalletChoice | null {
  try {
    const value = typeof localStorage === "undefined" ? null : localStorage.getItem(WALLET_CHOICE_KEY);
    return value === "privy" || value === "freighter" || value === "none" ? value : null;
  } catch {
    return null;
  }
}

export function writeWalletChoice(choice: WalletChoice): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(WALLET_CHOICE_KEY, choice);
  } catch {
    /* the choice still holds for this page load through the store */
  }
}
