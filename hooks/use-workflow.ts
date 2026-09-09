"use client";

import { useCallback, useState, useEffect, useRef } from "react";
import { copilotRequestHeaders } from "@/lib/copilot/copilot-request";
import type { WorkflowView } from "@/lib/copilot/workflow/types";
import { withClientDeadline } from "@/lib/copilot/client-deadline";

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

export function useWorkflow(wallet: string | null = null) {
  const [state, setState] = useState<{
    view: WorkflowView | null; loading: boolean; error: string | null;
  }>({ view: null, loading: false, error: null });
  const storageKey = wallet ? `vanna-workflow:${wallet}` : null;
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setState({ view: null, loading: false, error: null });
    let id: string | null = null;
    try { id = storageKey ? localStorage.getItem(storageKey) : null; } catch { /* storage unavailable */ }
    if (id && /^[a-f0-9-]{36}$/.test(id)) void (async () => {
      try {
        const headers = await copilotRequestHeaders();
        const response = await fetch(`/api/copilot/workflow/${id}`, { headers, signal: controller.signal, cache: "no-store" });
        if (!response.ok) return;
        const view = await response.json() as WorkflowView;
        if (!controller.signal.aborted) setState({ view, loading: false, error: null });
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
      if (!signal.aborted) setState({ view, loading: true, error: null });
      if (view.steps.some(s => ["submitted", "invoking", "submitting"].includes(s.status))) break;
    }
    return view;
  }, []);

  const propose = useCallback(async (continuation: string, candidateId: string) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const timer = setTimeout(() => controller.abort(), 90_000);
    setState({ view: null, loading: true, error: null });
    try {
      const view = await postJson("/api/copilot/workflow/propose", { continuation, candidateId }, controller.signal);
      if (!controller.signal.aborted && active.current === controller) setState({ view, loading: false, error: null });
    } catch (error) {
      if (active.current !== controller) return;
      setState({
        view: null, loading: false,
        error: controller.signal.aborted ? "Preparing the plan timed out. Please try again."
          : error instanceof Error ? error.message : "A plan could not be prepared. Please try again.",
      });
    } finally {
      clearTimeout(timer);
    }
  }, []);

  const approve = useCallback(async () => {
    const current = state.view;
    if (!current || state.loading) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const timer = setTimeout(() => controller.abort(), 180_000);
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const approved = await postJson(`/api/copilot/workflow/${current.id}/approve`, {
        revision: current.revision, digest: current.digest,
      }, controller.signal);
      const view = await runUntilPaused(approved, controller.signal);
      if (!controller.signal.aborted && active.current === controller) setState({ view, loading: false, error: null });
    } catch (error) {
      if (active.current !== controller) return;
      setState((previous) => ({
        ...previous, loading: false,
        error: controller.signal.aborted ? "Approval timed out. Please try again."
          : error instanceof Error ? error.message : "This plan could not be approved. Please try again.",
      }));
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
      if (!controller.signal.aborted && active.current === controller) setState({ view, loading: false, error: null });
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
      if (!controller.signal.aborted && active.current === controller) setState({ view, loading: false, error: null });
    } catch { setState(previous => ({ ...previous, loading: false, error: "The plan could not be refreshed. Its approved steps remain recorded." })); }
  }, [state.view, state.loading, runUntilPaused]);
  const reset = useCallback(() => {
    active.current?.abort();
    if (storageKey) try { localStorage.removeItem(storageKey); } catch { /* storage unavailable */ }
    setState({ view: null, loading: false, error: null });
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
      if (!controller.signal.aborted) setState({ view, loading: false, error: null });
    } catch (error) {
      if (active.current === controller) setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : "Cancellation failed." }));
    }
  }, [state.view, state.loading]);
  return { ...state, propose, approve, confirm, resume, cancelPlan, reset };
}
