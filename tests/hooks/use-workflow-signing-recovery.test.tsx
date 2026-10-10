// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowView } from "@/lib/copilot/workflow/types";
vi.mock("@/lib/copilot/copilot-request", () => ({ copilotRequestHeaders: async () => ({}) }));
vi.mock("@/contexts/ledger-subscriber", () => ({ useLedgerTick: () => ({ tick: 0 }) }));
import { useWorkflow } from "@/hooks/use-workflow";
const ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const WALLET = "wallet";
function view(id = ID, xdr = "old"): WorkflowView {
  return { id, status: "awaiting_signature", revision: 1, digest: "approved", objective: "deposit", message: "",
    steps: [{ id: "step", status: "awaiting_signature", unsignedXdr: xdr }] } as WorkflowView;
}
function reply(value: unknown) { return new Response(JSON.stringify(value), { status: 200 }); }
beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
describe("workflow return and signing recovery", () => {
  it("restores the exact chat's workflow without approving or signing it", async () => {
    const fetch = vi.fn(async (url: string) => { void url; return reply(view(OTHER)); }); vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useWorkflow(WALLET));
    await act(async () => { await result.current.restore(OTHER); });
    expect(result.current.view?.id).toBe(OTHER); expect(result.current.restored).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][0]).toContain(OTHER);
  });
  it("refreshes before returning a signable envelope and retains restored protection", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => reply(view(ID, init?.method === "POST" ? "fresh" : "old")));
    vi.stubGlobal("fetch", fetch); localStorage.setItem(`vanna-workflow:${WALLET}`, ID);
    const { result } = renderHook(() => useWorkflow(WALLET));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    let prepared: WorkflowView | null = null;
    await act(async () => { prepared = await result.current.prepareSign(); });
    expect(prepared!.steps[0].unsignedXdr).toBe("fresh"); expect(result.current.restored).toBe(true);
    expect(fetch.mock.calls[1][0]).toContain("prepare-sign");
    expect(fetch.mock.calls.every(([url]) => !url.includes("submit") && !url.includes("advance"))).toBe(true);
  });
  it("retains the card and exposes a recoverable connection error without retrying the POST", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") throw new TypeError("Failed to fetch");
      return reply(view());
    }); vi.stubGlobal("fetch", fetch); localStorage.setItem(`vanna-workflow:${WALLET}`, ID);
    const { result } = renderHook(() => useWorkflow(WALLET));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    await act(async () => { await result.current.prepareSign(); });
    expect(result.current.view?.id).toBe(ID); expect(result.current.error).toContain("plan is saved");
    expect(result.current.loading).toBe(false); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("discards a late preparation result after leaving the chat", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? new Promise<Response>(done => { resolve = done; }) : reply(view())));
    localStorage.setItem(`vanna-workflow:${WALLET}`, ID);
    const { result } = renderHook(() => useWorkflow(WALLET));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    let pending!: Promise<WorkflowView | null>;
    act(() => { pending = result.current.prepareSign(); });
    await waitFor(() => expect(resolve).toBeDefined());
    act(() => result.current.reset());
    await act(async () => { resolve(reply(view(ID, "fresh"))); expect(await pending).toBeNull(); });
    expect(result.current.view).toBeNull();
  });
  it("does not submit an old wallet callback into another chat's workflow", async () => {
    const fetch = vi.fn(async () => reply(view(OTHER))); vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useWorkflow(WALLET));
    await act(async () => { await result.current.restore(OTHER); });
    await act(async () => { await result.current.confirm("late-signature", ID); });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("reconciles returning online through a read without issuing a write", async () => {
    const fetch = vi.fn(async (url: string) => { void url; return reply(view()); }); vi.stubGlobal("fetch", fetch);
    localStorage.setItem(`vanna-workflow:${WALLET}`, ID);
    const { result } = renderHook(() => useWorkflow(WALLET));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[1][0]).toBe(`/api/copilot/workflow/${ID}`);
  });
});
