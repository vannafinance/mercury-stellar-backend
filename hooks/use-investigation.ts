"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { copilotRequestHeaders } from "@/lib/copilot/copilot-request";
import { consumeResearchStream } from "@/lib/copilot/investigation/stream";
import type { InvestigationProgress } from "@/lib/copilot/investigation/types";
import type { ResearchView } from "@/lib/copilot/investigation/view";

async function requestHeaders(signal: AbortSignal) {
  let stop: () => void = () => {};
  try {
    return await Promise.race([
      copilotRequestHeaders(),
      new Promise<never>((_, reject) => {
        stop = () => reject(new Error("Your sign-in session did not respond. Reconnect and try again."));
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
      }),
    ]);
  } finally { signal.removeEventListener("abort", stop); }
}

export function useInvestigation(wallet: string | null) {
  const [state, setState] = useState<{
    wallet: string | null; loading: boolean; prompt: string; result: ResearchView | null;
    progress: InvestigationProgress | null; error: string | null;
  }>({ wallet, loading: false, prompt: "", result: null, progress: null, error: null });
  const abort = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const continuation = useRef<string | null>(null);
  /**
   * Only a reply to an open question continues the prior investigation.
   *
   * Sending the continuation unconditionally made every new goal a refinement of the
   * previous one: asking "price of XLM" and then a full strategy goal recorded
   * "price of XLM" as `originalRequest`, showed the real goal as a follow-up, and left
   * the model preserving the stale objective — which the research prompt explicitly
   * instructs it to do. A fresh goal has to start its own investigation.
   */
  const awaitingAnswer = useRef(false);
  const activeWallet = useRef(wallet);
  activeWallet.current = wallet;

  const reset = useCallback(() => {
    abort.current?.abort();
    sequence.current += 1;
    continuation.current = null;
    awaitingAnswer.current = false;
    setState({ wallet: activeWallet.current, loading: false, prompt: "", result: null, progress: null, error: null });
  }, []);
  useEffect(() => { reset(); return () => { abort.current?.abort(); sequence.current += 1; }; }, [wallet, reset]);
  const cancel = useCallback(() => {
    abort.current?.abort();
    sequence.current += 1;
    setState((previous) => ({ ...previous, loading: false, progress: null, error: "Investigation cancelled. No transactions were requested." }));
  }, []);
  const run = useCallback(async (message: string, signal?: AbortSignal) => {
    const prompt = message.trim();
    if (!prompt) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const id = ++sequence.current;
    const owner = wallet;
    const current = () => sequence.current === id && activeWallet.current === owner && !combined.aborted;
    // Above the route's 75s guarantee: the server should always answer first, so this
    // is a backstop for a dead connection rather than the normal end of a slow run.
    // The composer keeps a 130s outer deadline so this 120s timer is the one that fires.
    const timer = setTimeout(() => controller.abort(), 120_000);
    const followUp = awaitingAnswer.current ? continuation.current : null;
    if (!followUp) continuation.current = null;
    setState({ wallet: owner, loading: true, prompt, result: null, progress: null, error: null });
    let received = false;
    let streamError = false;
    try {
      const headers = await requestHeaders(AbortSignal.any([combined, AbortSignal.timeout(10_000)]));
      if (!current()) return;
      const response = await fetch("/api/copilot/investigate", {
        method: "POST", headers, signal: combined,
        body: JSON.stringify({ message: prompt, wallet: owner, continuation: followUp }),
      });
      await consumeResearchStream(response, (event) => {
        if (!current()) return;
        if (event.type === "result") {
          received = true;
          continuation.current = event.result.continuation;
          awaitingAnswer.current = event.result.question !== null || event.result.understanding?.intent === "strategy";
          setState((previous) => ({ ...previous, result: event.result, progress: null }));
        } else if (event.type === "error") {
          streamError = true;
          if (event.code === "context_expired" || event.code === "context_full") {
            continuation.current = null;
            awaitingAnswer.current = false;
          }
          setState((previous) => ({ ...previous, error: event.message, progress: null }));
        } else setState((previous) => ({ ...previous, progress: event.event }));
      });
      if (current() && !received && !streamError) {
        setState((previous) => ({
          ...previous,
          error: "The investigation finished without an answer. Please try again.",
          progress: null,
        }));
      }
    } catch (error) {
      if (sequence.current === id && activeWallet.current === owner) setState((previous) => ({
        ...previous, error: combined.aborted ? "The investigation timed out. Please try again."
          : error instanceof Error ? error.message : "Investigation failed. Please try again.",
      }));
    } finally {
      clearTimeout(timer);
      if (sequence.current === id && activeWallet.current === owner) setState((previous) => ({ ...previous, loading: false, progress: null }));
    }
  }, [wallet]);

  // Do not expose the previous wallet's state during the render before its effect resets.
  const visible = state.wallet === wallet ? state : { ...state, loading: false, prompt: "", result: null, progress: null, error: null };
  return { ...visible, run, cancel, reset };
}
