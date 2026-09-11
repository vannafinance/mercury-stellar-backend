"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { copilotRequestHeaders } from "@/lib/copilot/copilot-request";
import { consumeResearchStream } from "@/lib/copilot/investigation/stream";
import type { InvestigationProgress } from "@/lib/copilot/investigation/types";
import type { ResearchView } from "@/lib/copilot/investigation/view";
import {
  type ThreadTurn,
  shouldContinueInvestigation,
  readStoredThread,
  writeStoredThread,
  clearStoredThread,
} from "@/lib/copilot/investigation/thread";

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
    progress: InvestigationProgress | null; error: string | null; turns: ThreadTurn[];
  }>({ wallet, loading: false, prompt: "", result: null, progress: null, error: null, turns: [] });
  const abort = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const continuation = useRef<string | null>(null);
  /**
   * Bounded chat window sent with every turn so a refinement like "make it 1.4"
   * still has context when no question is open. Distinct from `continuation`, which
   * only chains a reply onto an unresolved investigation.
   */
  const transcript = useRef<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const lastResult = useRef<ResearchView | null>(null);
  const activeWallet = useRef(wallet);
  activeWallet.current = wallet;

  const applyBlank = useCallback((owner: string | null) => {
    continuation.current = null;
    lastResult.current = null;
    transcript.current = [];
    setState({
      wallet: owner, loading: false, prompt: "", result: null, progress: null, error: null, turns: [],
    });
  }, []);

  const reset = useCallback(() => {
    abort.current?.abort();
    sequence.current += 1;
    clearStoredThread(activeWallet.current);
    applyBlank(activeWallet.current);
  }, [applyBlank]);
  useEffect(() => {
    abort.current?.abort();
    sequence.current += 1;
    const stored = wallet ? readStoredThread(wallet) : null;
    if (stored?.turns.length) {
      continuation.current = stored.continuation;
      lastResult.current = stored.result;
      transcript.current = stored.turns.map((turn) => ({ role: turn.role, text: turn.text }));
      const lastUser = [...stored.turns].reverse().find((turn) => turn.role === "user");
      setState({
        wallet, loading: false, prompt: lastUser?.text ?? "", result: stored.result,
        progress: null, error: null, turns: stored.turns,
      });
      return () => { abort.current?.abort(); sequence.current += 1; };
    }
    applyBlank(wallet);
    if (!wallet) return () => { abort.current?.abort(); sequence.current += 1; };
    const restore = new AbortController();
    void (async () => {
      try {
        const headers = await requestHeaders(AbortSignal.any([restore.signal, AbortSignal.timeout(8_000)]));
        if (restore.signal.aborted || activeWallet.current !== wallet) return;
        const response = await fetch("/api/copilot/session", { headers, signal: restore.signal, cache: "no-store" });
        if (!response.ok || restore.signal.aborted || activeWallet.current !== wallet) return;
        const remote = await response.json() as { turns?: ThreadTurn[]; continuation?: string | null; result?: ResearchView | null };
        if (!Array.isArray(remote.turns) || !remote.turns.length) return;
        continuation.current = remote.continuation ?? null;
        lastResult.current = remote.result ?? null;
        transcript.current = remote.turns.map((turn) => ({ role: turn.role, text: turn.text }));
        writeStoredThread(wallet, {
          wallet, continuation: remote.continuation ?? null, turns: remote.turns, result: remote.result ?? null,
        });
        const lastUser = [...remote.turns].reverse().find((turn) => turn.role === "user");
        setState({
          wallet, loading: false, prompt: lastUser?.text ?? "", result: remote.result ?? null,
          progress: null, error: null, turns: remote.turns,
        });
      } catch { /* sessionStorage remains the live thread; a closed tab is the documented loss */ }
    })();
    return () => { restore.abort(); abort.current?.abort(); sequence.current += 1; };
  }, [wallet, applyBlank]);
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
    const followUp = shouldContinueInvestigation(prompt, lastResult.current) ? continuation.current : null;
    const session = continuation.current;
    const history = transcript.current.slice(-8);
    setState((previous) => ({
      wallet: owner, loading: true, prompt: followUp ? previous.prompt || prompt : prompt,
      result: previous.result,
      turns: [...previous.turns, { role: "user" as const, text: prompt }].slice(-16),
      progress: { kind: "scope", label: "Preparing your session" }, error: null,
    }));
    let received = false;
    let streamError = false;
    let settled = false;
    const settle = (patch: { error?: string | null } = {}) => {
      if (sequence.current !== id || activeWallet.current !== owner) return;
      settled = true;
      setState((previous) => ({ ...previous, loading: false, progress: null, ...patch }));
    };
    try {
      const headers = await requestHeaders(AbortSignal.any([combined, AbortSignal.timeout(10_000)]));
      if (sequence.current !== id || activeWallet.current !== owner) return;
      if (combined.aborted) {
        settle({ error: "The investigation ran out of time before it could finish. Nothing was executed — please try again." });
        return;
      }
      const response = await fetch("/api/copilot/investigate", {
        method: "POST", headers, signal: combined,
        body: JSON.stringify({
          message: prompt, wallet: owner, continuation: followUp, session, history,
        }),
      });
      await consumeResearchStream(response, (event) => {
        if (!current()) return;
        if (event.type === "result") {
          received = true;
          continuation.current = event.result.continuation;
          lastResult.current = event.result;
          const next: Array<{ role: "user" | "assistant"; text: string }> = [
            ...transcript.current,
            { role: "user", text: prompt },
            { role: "assistant", text: event.result.message },
          ];
          transcript.current = next.slice(-8);
          setState((previous) => {
            const priorTurns: ThreadTurn[] = previous.turns.some((turn, index) =>
              turn.role === "user" && turn.text === prompt && index === previous.turns.length - 1)
              ? previous.turns
              : [...previous.turns, { role: "user" as const, text: prompt }];
            const turns: ThreadTurn[] = [
              ...priorTurns,
              { role: "assistant" as const, text: event.result.message, question: event.result.question },
            ].slice(-16);
            writeStoredThread(owner, {
              wallet: owner ?? "",
              continuation: event.result.continuation,
              turns, result: event.result,
            });
            return { ...previous, result: event.result, turns, progress: null, loading: false };
          });
        } else if (event.type === "error") {
          streamError = true;
          if (event.code === "context_expired" || event.code === "context_full") {
            continuation.current = null;
            lastResult.current = lastResult.current;
            clearStoredThread(owner);
            writeStoredThread(owner, {
              wallet: owner ?? "",
              continuation: null,
              turns: transcript.current.slice(-16).map((turn) => ({
                role: turn.role, text: turn.text,
              })),
              result: null,
            });
          }
          setState((previous) => ({
            ...previous,
            error: event.message,
            progress: null,
          }));
        } else setState((previous) => ({ ...previous, progress: event.event }));
      });
      if (current() && !received && !streamError) {
        settle({ error: "The investigation finished without an answer. Please try again." });
      }
    } catch (error) {
      if (received || streamError) {
        settle();
        return;
      }
      settle({
        error: combined.aborted
          ? "The investigation ran out of time before it could finish. Nothing was executed — please try again."
          : error instanceof Error ? error.message : "Investigation failed. Please try again.",
      });
    } finally {
      clearTimeout(timer);
      if (!settled && sequence.current === id && activeWallet.current === owner) {
        setState((previous) => ({ ...previous, loading: false, progress: null }));
      }
    }
  }, [wallet]);

  // Do not expose the previous wallet's state during the render before its effect resets.
  const visible = state.wallet === wallet ? state : { ...state, loading: false, prompt: "", result: null, progress: null, error: null, turns: [] };
  return { ...visible, run, cancel, reset };
}
