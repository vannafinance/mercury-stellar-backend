"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { copilotRequestHeaders } from "@/lib/copilot/copilot-request";
import { consumeResearchStream } from "@/lib/copilot/investigation/stream";
import type { InvestigationProgress } from "@/lib/copilot/investigation/types";
import type { ResearchView } from "@/lib/copilot/investigation/view";
import type { ExecutionReceiptSnapshot } from "@/lib/copilot/execution-receipt";
import {
  type ConversationSummary,
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

interface SessionPayload {
  conversations?: ConversationSummary[];
  activeId?: string | null;
  turns?: ThreadTurn[];
  continuation?: string | null;
  result?: ResearchView | null;
}

interface ConversationPayload {
  id: string;
  turns: ThreadTurn[];
  continuation: string | null;
  result: ResearchView | null;
}

/** The list is only ever sorted by last activity, newest first. */
function sortedByActivity(items: readonly ConversationSummary[]): ConversationSummary[] {
  return [...items].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * One conversation at a time on screen; every conversation the signed-in user has had,
 * kept by the server, listed beside it. The live thread is mirrored into sessionStorage so
 * a reload paints instantly; the server copy is what "open" and a fresh tab read.
 */
export function useInvestigation(wallet: string | null) {
  const [state, setState] = useState<{
    wallet: string | null; loading: boolean; prompt: string; result: ResearchView | null;
    progress: InvestigationProgress | null; error: string | null; turns: ThreadTurn[];
    conversationId: string | null;
  }>({ wallet, loading: false, prompt: "", result: null, progress: null, error: null, turns: [], conversationId: null });
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const abort = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const continuation = useRef<string | null>(null);
  const conversationId = useRef<string | null>(null);
  /**
   * Bounded chat window sent with every turn so a refinement like "make it 1.4"
   * still has context when no question is open. Distinct from `continuation`, which
   * only chains a reply onto an unresolved investigation.
   */
  const transcript = useRef<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const lastResult = useRef<ResearchView | null>(null);
  const activeWallet = useRef(wallet);
  activeWallet.current = wallet;

  /**
   * The list always comes from the server. The client used to append a summary it built
   * itself — its own clock and its own truncated title — so ordering and titles could
   * disagree with what a reload showed. One source, fetched after a turn lands.
   */
  const refreshConversations = useCallback(async (owner: string | null) => {
    if (!owner) return;
    try {
      const headers = await requestHeaders(AbortSignal.timeout(8_000));
      const response = await fetch("/api/copilot/session", { headers, cache: "no-store" });
      if (!response.ok || activeWallet.current !== owner) return;
      const remote = await response.json() as SessionPayload;
      if (Array.isArray(remote.conversations)) setConversations(sortedByActivity(remote.conversations));
    } catch { /* the list refreshes on the next turn or the next load */ }
  }, []);

  const applyBlank = useCallback((owner: string | null) => {
    continuation.current = null;
    conversationId.current = null;
    lastResult.current = null;
    transcript.current = [];
    setState({
      wallet: owner, loading: false, prompt: "", result: null, progress: null, error: null, turns: [], conversationId: null,
    });
  }, []);

  /** Paint a thread — from storage, the session payload or an opened conversation. */
  const applyThread = useCallback((owner: string | null, thread: { turns: ThreadTurn[]; continuation: string | null; result: ResearchView | null; conversationId: string | null }) => {
    continuation.current = thread.continuation;
    conversationId.current = thread.conversationId;
    lastResult.current = thread.result;
    transcript.current = thread.turns.map((turn) => ({ role: turn.role, text: turn.text }));
    const lastUser = [...thread.turns].reverse().find((turn) => turn.role === "user");
    setState({
      wallet: owner, loading: false, prompt: lastUser?.text ?? "", result: thread.result,
      progress: null, error: null, turns: thread.turns, conversationId: thread.conversationId,
    });
  }, []);

  /**
   * The wallet comes from a store that can report `null` for a render or two while it
   * reconnects. Treating that as "wallet changed" aborted the in-flight investigation and
   * wiped the thread — the user saw "ran out of time" eleven seconds into a healthy run
   * (13 Sep). A change TO a wallet is acted on at once; a change to nothing waits briefly
   * for the same wallet to come back, and only then resets.
   */
  const settledWallet = useRef(wallet);
  const [effectiveWallet, setEffectiveWallet] = useState(wallet);
  useEffect(() => {
    if (wallet !== null || settledWallet.current === null) {
      settledWallet.current = wallet;
      setEffectiveWallet(wallet);
      return;
    }
    const timer = setTimeout(() => { settledWallet.current = null; setEffectiveWallet(null); }, 1_500);
    return () => clearTimeout(timer);
  }, [wallet]);

  useEffect(() => {
    const wallet = effectiveWallet;
    abort.current?.abort();
    sequence.current += 1;
    setConversations([]);
    const stored = wallet ? readStoredThread(wallet) : null;
    if (stored?.turns.length) {
      applyThread(wallet, { turns: stored.turns, continuation: stored.continuation, result: stored.result, conversationId: stored.conversationId ?? null });
    } else {
      applyBlank(wallet);
    }
    if (!wallet) return () => { abort.current?.abort(); sequence.current += 1; };
    // The server holds the list and, when this tab has nothing, the open conversation.
    const restore = new AbortController();
    void (async () => {
      try {
        const headers = await requestHeaders(AbortSignal.any([restore.signal, AbortSignal.timeout(8_000)]));
        if (restore.signal.aborted || activeWallet.current !== wallet) return;
        const response = await fetch("/api/copilot/session", { headers, signal: restore.signal, cache: "no-store" });
        if (!response.ok || restore.signal.aborted || activeWallet.current !== wallet) return;
        const remote = await response.json() as SessionPayload;
        if (Array.isArray(remote.conversations)) setConversations(sortedByActivity(remote.conversations));
        if (stored?.turns.length) return;
        if (!Array.isArray(remote.turns) || !remote.turns.length) return;
        const thread = {
          turns: remote.turns, continuation: remote.continuation ?? null, result: remote.result ?? null,
          conversationId: remote.activeId ?? null,
        };
        writeStoredThread(wallet, { wallet, ...thread });
        applyThread(wallet, thread);
      } catch { /* sessionStorage remains the live thread; the list appears on the next load */ }
    })();
    return () => { restore.abort(); abort.current?.abort(); sequence.current += 1; };
  }, [effectiveWallet, applyBlank, applyThread]);

  const cancel = useCallback(() => {
    abort.current?.abort();
    sequence.current += 1;
    setState((previous) => ({ ...previous, loading: false, progress: null, error: "Investigation cancelled. No transactions were requested." }));
  }, []);

  /** Start a new chat: the screen clears; the conversation stays in the list; nothing is created until the first turn. */
  const newChat = useCallback(() => {
    abort.current?.abort();
    sequence.current += 1;
    const owner = activeWallet.current;
    clearStoredThread(owner);
    applyBlank(owner);
    if (!owner) return;
    void (async () => {
      try {
        const headers = await requestHeaders(AbortSignal.timeout(8_000));
        await fetch("/api/copilot/session", { method: "DELETE", headers, cache: "no-store" });
      } catch { /* the pointer clears on the next turn anyway */ }
    })();
  }, [applyBlank]);

  /** Open a conversation from the list. */
  const open = useCallback(async (id: string) => {
    const owner = activeWallet.current;
    if (!owner || id === conversationId.current) return;
    abort.current?.abort();
    sequence.current += 1;
    try {
      const headers = await requestHeaders(AbortSignal.timeout(8_000));
      const response = await fetch(`/api/copilot/session/${encodeURIComponent(id)}`, { headers, cache: "no-store" });
      if (!response.ok || activeWallet.current !== owner) return;
      const conversation = await response.json() as ConversationPayload;
      const thread = { turns: conversation.turns, continuation: conversation.continuation, result: conversation.result, conversationId: conversation.id };
      writeStoredThread(owner, { wallet: owner, ...thread });
      applyThread(owner, thread);
    } catch {
      setState((previous) => ({ ...previous, error: "That conversation could not be opened. Try again." }));
    }
  }, [applyThread]);

  /** Delete a conversation. If it is the one on screen, the screen clears. */
  const remove = useCallback(async (id: string) => {
    const owner = activeWallet.current;
    if (!owner) return;
    setConversations((items) => items.filter((item) => item.id !== id));
    if (id === conversationId.current) {
      abort.current?.abort();
      sequence.current += 1;
      clearStoredThread(owner);
      applyBlank(owner);
    }
    try {
      const headers = await requestHeaders(AbortSignal.timeout(8_000));
      await fetch(`/api/copilot/session/${encodeURIComponent(id)}`, { method: "DELETE", headers, cache: "no-store" });
    } catch { /* it is gone from the list; the server copy goes on the next successful delete or expiry */ }
  }, [applyBlank]);

  /** Persist a journal snapshot on the assistant turn that owns that workflow. */
  const updateExecutionReceipt = useCallback(async (receipt: ExecutionReceiptSnapshot): Promise<boolean> => {
    const owner = activeWallet.current;
    const id = conversationId.current;
    if (!owner || !id) return false;
    try {
      const headers = await requestHeaders(AbortSignal.timeout(8_000));
      const response = await fetch(`/api/copilot/session/${encodeURIComponent(id)}`, {
        method: "PATCH", headers, cache: "no-store", body: JSON.stringify({ executionReceipt: receipt }),
      });
      if (!response.ok || activeWallet.current !== owner || conversationId.current !== id) return false;
      setState((previous) => {
        const reversed = [...previous.turns].map((turn, index) => ({ turn, index })).reverse();
        const matching = reversed.find(({ turn }) =>
          turn.role === "assistant" && turn.executionReceipt?.workflowId === receipt.workflowId);
        const index = matching?.index ?? reversed.find(({ turn }) =>
          turn.role === "assistant" && !turn.executionReceipt)?.index;
        if (index == null) return previous;
        const turns = [...previous.turns];
        turns[index] = { ...turns[index], executionReceipt: receipt };
        writeStoredThread(owner, {
          wallet: owner, continuation: continuation.current, turns,
          result: lastResult.current, conversationId: id,
        });
        return { ...previous, turns };
      });
      void refreshConversations(owner);
      return true;
    } catch { return false; }
  }, [refreshConversations]);

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
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 120_000);
    /**
     * Two different things end a run early and they must not share a sentence: the
     * deadline (time really ran out) and an abort (this request was replaced, cancelled,
     * or the wallet changed under it). The second is not a failure to retry blindly.
     */
    const abortedCopy = () => timedOut
      ? "The investigation ran out of time before it could finish. Nothing was executed — please try again."
      : "This investigation was cancelled or replaced before it finished. Nothing was executed — run it again.";
    const followUp = shouldContinueInvestigation(prompt, lastResult.current) ? continuation.current : null;
    const session = continuation.current;
    const history = transcript.current.slice(-8);
    const startedIn = conversationId.current;
    setState((previous) => ({
      wallet: owner, loading: true, prompt: followUp ? previous.prompt || prompt : prompt,
      result: previous.result,
      turns: [...previous.turns, { role: "user" as const, text: prompt }].slice(-16),
      progress: { kind: "scope", label: "Preparing your session" }, error: null,
      conversationId: previous.conversationId,
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
        settle({ error: abortedCopy() });
        return;
      }
      // Three follow-up prompts on 13 Sep sat on "Preparing your session" until the deadline with
      // nothing reaching the server. The label must say which half stalled: the sign-in token
      // (above) or the request itself (below).
      setState((previous) => (sequence.current === id ? { ...previous, progress: { kind: "scope", label: "Sending your request" } } : previous));
      const response = await fetch("/api/copilot/investigate", {
        method: "POST", headers, signal: combined,
        body: JSON.stringify({
          message: prompt, wallet: owner, continuation: followUp, session, history,
          ...(startedIn ? { conversationId: startedIn } : {}),
        }),
      });
      await consumeResearchStream(response, (event) => {
        if (!current()) return;
        if (event.type === "result") {
          received = true;
          continuation.current = event.result.continuation;
          lastResult.current = event.result;
          const landedIn = event.conversationId ?? startedIn;
          conversationId.current = landedIn;
          const next: Array<{ role: "user" | "assistant"; text: string }> = [
            ...transcript.current,
            { role: "user", text: prompt },
            { role: "assistant", text: event.result.message },
          ];
          transcript.current = next.slice(-8);
          // The server has just recorded this turn; ask it what the list looks like now.
          if (landedIn) void refreshConversations(owner);
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
              turns, result: event.result, conversationId: landedIn,
            });
            return { ...previous, result: event.result, turns, progress: null, loading: false, conversationId: landedIn };
          });
        } else if (event.type === "error") {
          streamError = true;
          if (event.code === "context_expired" || event.code === "context_full") {
            continuation.current = null;
            clearStoredThread(owner);
            writeStoredThread(owner, {
              wallet: owner ?? "",
              continuation: null,
              turns: transcript.current.slice(-16).map((turn) => ({
                role: turn.role, text: turn.text,
              })),
              result: null,
              conversationId: conversationId.current,
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
          ? abortedCopy()
          : error instanceof Error ? error.message : "Investigation failed. Please try again.",
      });
    } finally {
      clearTimeout(timer);
      if (!settled && sequence.current === id && activeWallet.current === owner) {
        setState((previous) => ({ ...previous, loading: false, progress: null }));
      }
    }
  }, [wallet, refreshConversations]);

  // Do not expose the previous wallet's state during the render before its effect resets.
  const visible = state.wallet === wallet ? state : { ...state, loading: false, prompt: "", result: null, progress: null, error: null, turns: [], conversationId: null };
  /** `reset` keeps its name for the workspace: it is "new chat" now, not "wipe the thread". */
  return { ...visible, conversations, run, cancel, reset: newChat, newChat, open, remove, updateExecutionReceipt };
}
