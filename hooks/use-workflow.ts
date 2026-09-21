"use client";

import { useCallback, useState, useEffect, useRef } from "react";
import { copilotRequestHeaders } from "@/lib/copilot/copilot-request";
import type { WorkflowView } from "@/lib/copilot/workflow/types";
import { withClientDeadline } from "@/lib/copilot/client-deadline";
import { useLedgerTick } from "@/contexts/ledger-subscriber";

async function postJson(url: string, body: unknown, signal: AbortSignal): Promise<WorkflowView> {
  signal.throwIfAborted();
  const headers = await withClientDeadline(copilotRequestHeaders(), AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
  signal.throwIfAborted();
  const response = await fetch(url, { method: "POST", headers, signal, body: JSON.stringify(body) });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
      ? payload.message : "This plan could not be prepared. Please try again.";
    throw new Error(message);
  }
  return payload as WorkflowView;
}

function running(view: WorkflowView): boolean {
  return view.status === "approved" || view.status === "running";
}

/** Ledgers close about every five seconds; a waiting plan is re-checked far less often than that. */
const RECHECK_MIN_MS = 30_000;

/** A step whose transaction is on its way to a ledger: waiting on the chain, not on a person. */
export function inFlight(view: WorkflowView): boolean {
  return view.steps.some(s => ["submitted", "invoking", "submitting"].includes(s.status));
}

export function useWorkflow(wallet: string | null = null) {
  /**
   * `restored` marks a journal this page read back rather than one it just produced.
   * Auto-approve and auto-sign issue transactions, and a card rehydrated on mount is not
   * the user pressing anything — so they wait for a real action on a restored plan while
   * the ledger loop, which only looks submitted hashes up, carries on.
   */
  const [state, setState] = useState<{
    view: WorkflowView | null; loading: boolean; error: string | null; restored: boolean;
  }>({ view: null, loading: false, error: null, restored: false });
  /**
   * Why a waiting plan was withdrawn, pinned to the exact revision it was judged against,
   * so a newly prepared plan is never shown carrying the old one's reason.
   */
  const [withdrawn, setWithdrawn] = useState<{ id: string; revision: number; reason: string } | null>(null);
  /**
   * The pool's current answer for a waiting swap, from the same re-quote the write runs.
   * Informational: it tells the reader what approving now would settle at. What actually
   * gets signed is still decided at write time, by that same function.
   */
  const [liveQuote, setLiveQuote] = useState<{ id: string; revision: number; minOut: string; note: string } | null>(null);
  const storageKey = wallet ? `vanna-workflow:${wallet}` : null;
  const active = useRef<AbortController | null>(null);
  const viewRef = useRef<WorkflowView | null>(null);
  viewRef.current = state.view;
  const loadingRef = useRef(false);
  loadingRef.current = state.loading;
  const { tick } = useLedgerTick();
  useEffect(() => {
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setState({ view: null, loading: false, error: null, restored: false });
    let id: string | null = null;
    try { id = storageKey ? localStorage.getItem(storageKey) : null; } catch { /* storage unavailable */ }
    if (id && /^[a-f0-9-]{36}$/.test(id)) void (async () => {
      try {
        const headers = await copilotRequestHeaders();
        const response = await fetch(`/api/copilot/workflow/${id}`, { headers, signal: controller.signal, cache: "no-store" });
        if (!response.ok) return;
        const view = await response.json() as WorkflowView;
        if (!controller.signal.aborted) setState({ view, loading: false, error: null, restored: true });
      } catch { /* user can start a fresh investigation */ }
    })();
    return () => controller.abort();
  }, [storageKey]);
  useEffect(() => {
    if (!storageKey || !state.view) return;
    try { localStorage.setItem(storageKey, state.view.id); } catch { /* server remains authoritative */ }
  }, [storageKey, state.view]);

  const runUntilPaused = useCallback(async (initial: WorkflowView, signal: AbortSignal) => {
    let view = initial;
    for (let step = 0; step < 8 && running(view); step++) {
      view = await postJson(`/api/copilot/workflow/${view.id}/advance`, {}, signal);
      const advanced = view;
      if (!signal.aborted) setState((previous) => ({ ...previous, view: advanced, loading: true, error: null }));
      if (inFlight(view)) break;
    }
    return view;
  }, []);

  /**
   * A submitted step settles when a ledger closes, not when a person clicks. The run pauses
   * on it above; here every ledger close asks the server once more — `advance` on such a step
   * only looks its hash up, it never issues anything — and once the ledger has answered the
   * run carries on to the next step by itself. 13 Sep: both steps of the first redeem →
   * deposit had succeeded on chain while the card still said "Broadcasting…", because the
   * only thing that ever asked again was the "Check progress" button.
   */
  useEffect(() => {
    const view = viewRef.current;
    if (tick === 0 || !view || loadingRef.current || !running(view) || !inFlight(view)) return;
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setState(previous => ({ ...previous, loading: true, error: null }));
    void (async () => {
      try {
        const next = await runUntilPaused(view, AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]));
        if (!controller.signal.aborted && active.current === controller) setState((previous) => ({ ...previous, view: next, loading: false, error: null }));
      } catch {
        // The next ledger close asks again; the button remains as the manual path.
        if (active.current === controller) setState(previous => ({ ...previous, loading: false }));
      }
    })();
  }, [tick, runUntilPaused]);

  /** Answers whether a plan was prepared, so a caller holding a one-shot claim can release it. */
  /**
   * A plan sized at one moment waits for a person, and the world moves while it waits.
   * Approve re-reads funds, prices and projected health — but only at the click, which is
   * too late to be information. So the same check runs against the card while it waits,
   * at most once per `RECHECK_MIN_MS` of ledger closes and never for a hidden tab, and a
   * plan that no longer holds is withdrawn with the server's reason rather than left
   * looking executable. A check that cannot be made says nothing: Approve still decides.
   */
  const lastRecheck = useRef(0);
  useEffect(() => {
    const view = viewRef.current;
    if (tick === 0 || !view || loadingRef.current || view.status !== "proposed") return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (Date.now() - lastRecheck.current < RECHECK_MIN_MS) return;
    lastRecheck.current = Date.now();
    // Its own controller: a background check must never abort an approval in flight.
    const controller = new AbortController();
    void (async () => {
      try {
        const headers = await withClientDeadline(copilotRequestHeaders(), AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]));
        const response = await fetch(`/api/copilot/workflow/${view.id}/recheck`, {
          method: "POST", headers, signal: controller.signal, cache: "no-store",
        });
        if (!response.ok || controller.signal.aborted) return;
        const outcome = await response.json() as {
          fresh?: boolean; reason?: string; quote?: { minOut: string; note: string };
        };
        if (controller.signal.aborted) return;
        if (outcome.fresh === false && outcome.reason) {
          setWithdrawn({ id: view.id, revision: view.revision, reason: outcome.reason });
          return;
        }
        setLiveQuote(outcome.quote
          ? { id: view.id, revision: view.revision, ...outcome.quote }
          : null);
      } catch { /* the next ledger close asks again; Approve re-checks for real */ }
    })();
    return () => controller.abort();
  }, [tick]);

  const propose = useCallback(async (continuation: string, candidateId: string): Promise<boolean> => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const timer = setTimeout(() => controller.abort(), 90_000);
    setState({ view: null, loading: true, error: null, restored: false });
    try {
      const view = await postJson("/api/copilot/workflow/propose", { continuation, candidateId }, controller.signal);
      if (!controller.signal.aborted && active.current === controller) setState({ view, loading: false, error: null, restored: false });
      return true;
    } catch (error) {
      if (active.current !== controller) return false;
      setState({
        view: null, loading: false, restored: false,
        error: controller.signal.aborted ? "Preparing the plan timed out. Please try again."
          : error instanceof Error ? error.message : "A plan could not be prepared. Please try again.",
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }, []);

  /** Answers whether the approval went through, so an armed session releases a failed claim. */
  const approve = useCallback(async (): Promise<boolean> => {
    const current = viewRef.current;
    if (!current || state.loading) return false;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const timer = setTimeout(() => controller.abort(), 180_000);
    setState((previous) => ({ ...previous, loading: true, error: null, restored: false }));
    try {
      const approved = await postJson(`/api/copilot/workflow/${current.id}/approve`, {
        revision: current.revision, digest: current.digest,
      }, controller.signal);
      const view = await runUntilPaused(approved, controller.signal);
      if (!controller.signal.aborted && active.current === controller) setState({ view, loading: false, error: null, restored: false });
      return true;
    } catch (error) {
      if (active.current !== controller) return false;
      setState((previous) => ({
        ...previous, loading: false,
        error: controller.signal.aborted ? "Approval timed out. Please try again."
          : error instanceof Error ? error.message : "This plan could not be approved. Please try again.",
      }));
      return false;
    } finally {
      clearTimeout(timer);
    }
  }, [state.view, state.loading, runUntilPaused]);

  const confirm = useCallback(async (signedXdr: string) => {
    const current = state.view;
    if (!current || state.loading) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const timer = setTimeout(() => controller.abort(), 180_000);
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const confirmed = await postJson(`/api/copilot/workflow/${current.id}/submit`, { signedXdr }, controller.signal);
      const view = await runUntilPaused(confirmed, controller.signal);
      if (!controller.signal.aborted && active.current === controller) setState({ view, loading: false, error: null, restored: false });
    } catch (error) {
      if (active.current !== controller) return;
      setState((previous) => ({
        ...previous, loading: false,
        error: controller.signal.aborted ? "Confirmation timed out. Please try again."
          : error instanceof Error ? error.message : "This transaction could not be confirmed. Please try again.",
      }));
    } finally {
      clearTimeout(timer);
    }
  }, [state.view, state.loading, runUntilPaused]);

  const resume = useCallback(async () => {
    if (!state.view || state.loading) return;
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setState(previous => ({ ...previous, loading: true, error: null }));
    try {
      const view = await runUntilPaused(state.view, AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]));
      if (!controller.signal.aborted && active.current === controller) setState({ view, loading: false, error: null, restored: false });
    } catch { setState(previous => ({ ...previous, loading: false, error: "The plan could not be refreshed. Its approved steps remain recorded." })); }
  }, [state.view, state.loading, runUntilPaused]);
  const reset = useCallback(() => {
    active.current?.abort();
    if (storageKey) try { localStorage.removeItem(storageKey); } catch { /* storage unavailable */ }
    setState({ view: null, loading: false, error: null, restored: false });
  }, [storageKey]);
  const cancelPlan = useCallback(async () => {
    if (!state.view || state.loading) return;
    const controller = new AbortController(); active.current?.abort(); active.current = controller;
    setState(previous => ({ ...previous, loading: true, error: null }));
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
      const headers = await withClientDeadline(copilotRequestHeaders(), signal);
      const response = await fetch(`/api/copilot/workflow/${state.view.id}`, { method: "DELETE", headers, signal });
      if (!response.ok) throw new Error("The plan has an in-flight transaction or could not be cancelled. Check its progress first.");
      const view = await response.json() as WorkflowView;
      if (!controller.signal.aborted) setState({ view, loading: false, error: null, restored: false });
    } catch (error) {
      if (active.current === controller) setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : "Cancellation failed." }));
    }
  }, [state.view, state.loading]);
  /** Only the plan actually on screen can be the withdrawn one, or carry its live quote. */
  const onScreen = (pinned: { id: string; revision: number } | null) =>
    !!pinned && !!state.view && pinned.id === state.view.id
    && pinned.revision === state.view.revision && state.view.status === "proposed";
  const stale = onScreen(withdrawn) ? withdrawn!.reason : null;
  const quote = onScreen(liveQuote) && !stale
    ? { minOut: liveQuote!.minOut, note: liveQuote!.note }
    : null;
  return { ...state, stale, quote, propose, approve, confirm, resume, cancelPlan, reset };
}
