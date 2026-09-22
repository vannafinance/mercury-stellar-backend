"use client";

import { createContext, useContext } from "react";
import { useInvestigation } from "@/hooks/use-investigation";
import { useUserStore } from "@/store/user";

/**
 * Who owns an investigation that is still running.
 *
 * `useInvestigation` keeps the in-flight request in an `AbortController` ref and tears it
 * down in an effect cleanup. That cleanup is correct — a run must not outlive the wallet it
 * was scoped to, and a replaced or cancelled run must stop. What was wrong is *where the
 * hook lived*: it was called from `CopilotWorkspace`, which unmounts the moment the user
 * navigates to any other route. Leaving /copilot therefore ran the cleanup, aborted the
 * fetch to /api/copilot/investigate, and cancelled the server request with it. The run did
 * not merely stop being displayed; it died, and coming back showed nothing.
 *
 * The fix is ownership, not an exception. The hook is mounted here, in the root layout's
 * provider stack, which persists across every client-side navigation. Navigating away no
 * longer unmounts anything, so no cleanup runs and the run continues; returning to /copilot
 * re-reads the same live state, progress included. The cleanup still fires for the three
 * cases it was written for — the wallet genuinely changes, the tab unloads, or the user
 * cancels — and every abort inside `run`, `cancel`, `newChat` and `open` is untouched.
 *
 * Mounted inside `AppPrivyProvider` because the request headers read the Privy access token
 * through the wallet adapter, which that provider registers. For a signed-out visitor the
 * hook's restore effect returns immediately on a null wallet, so this costs nothing until
 * someone actually connects.
 */
type Investigation = ReturnType<typeof useInvestigation>;

const InvestigationContext = createContext<Investigation | null>(null);

export function InvestigationProvider({ children }: { children: React.ReactNode }) {
  const address = useUserStore((s) => s.address);
  const investigation = useInvestigation(address);
  return (
    <InvestigationContext.Provider value={investigation}>
      {children}
    </InvestigationContext.Provider>
  );
}

/**
 * The live investigation for the connected wallet. Throws rather than silently handing back
 * a detached instance: a second `useInvestigation` call would create a second run with its
 * own controller, which is the bug this provider exists to remove.
 */
export function useLiveInvestigation(): Investigation {
  const value = useContext(InvestigationContext);
  if (!value) {
    throw new Error("useLiveInvestigation must be used inside <InvestigationProvider>");
  }
  return value;
}
