"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One composer. EVERY prompt is investigated first, then acted on.
 *
 * This used to ask the server to pick one handler — investigate XOR action — which meant a
 * concrete instruction skipped investigation entirely and executed against whatever the
 * keyword path inferred, while a strategy request could never reach the executor. Both
 * halves were wrong: understanding the account is what makes an action safe, so a write
 * should be the CONSEQUENCE of an investigation, not an alternative to one.
 *
 * `onAction` is therefore no longer a routing branch. It is the follow-on step the caller
 * invokes once the investigation has produced an understanding worth acting on, so nothing
 * here can execute on its own.
 */
export const ENTRY_DEADLINE_MS = 130_000;

export function useCopilotEntry(options: {
  wallet: string | null;
  onInvestigate: (message: string, signal: AbortSignal) => Promise<unknown>;
}) {
  const { wallet, onInvestigate } = options;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const cancel = useCallback(() => { active.current?.abort(); active.current = null; setLoading(false); }, []);
  /**
   * A wallet change must cancel the previous wallet's run. An unmount must not.
   *
   * This effect used to return `cancel` as its cleanup, which conflated the two: React runs
   * an effect cleanup on unmount as well as before a re-run, so navigating away from
   * /copilot aborted the controller whose signal is handed to `onInvestigate`, and the
   * investigation died mid-flight. The user came back to a prompt that had simply stopped.
   *
   * The controller exists for the deadline below and for an explicit cancel, and neither of
   * those is "this component went off screen". So the wallet is compared against the one
   * the in-flight run belongs to and cancelled only on a real change; nothing is torn down
   * on unmount, and the awaiting closure carries the run to completion against the
   * investigation state, which is owned by the root layout rather than by this page.
   */
  const ownerWallet = useRef(wallet);
  useEffect(() => {
    if (ownerWallet.current === wallet) return;
    ownerWallet.current = wallet;
    cancel();
    setError(null);
  }, [wallet, cancel]);
  const run = useCallback(async (text: string) => {
    const message = text.trim();
    if (!message) return;
    // A new prompt supersedes the in-flight one. Dropping it silently left
    // `active` set forever after a hung turn, so every later prompt vanished.
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const timer = setTimeout(() => controller.abort(), ENTRY_DEADLINE_MS);
    const current = () => active.current === controller && !controller.signal.aborted;
    setLoading(true); setError(null);
    try {
      await onInvestigate(message, controller.signal);
      if (!current()) return;
    } catch (cause) {
      if (active.current === controller) setError(controller.signal.aborted ? "Copilot timed out. Please try again."
        : cause instanceof Error ? cause.message : "Copilot is unavailable.");
    } finally {
      clearTimeout(timer);
      if (active.current === controller) { active.current = null; setLoading(false); }
    }
  }, [onInvestigate]);
  return { run, cancel, loading, error };
}
