// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { WorkflowView } from "@/lib/copilot/workflow/types";

/**
 * 24 Oct, live: opening another chat while a plan was running called `reset`, which aborted the loop that issues the next
 * step. A transaction already on its way landed, and nothing after it was sent until the chat was opened again. A run that is
 * under way now keeps going without the screen, and the screen shows nothing of it.
 */
const mocks = vi.hoisted(() => ({ headers: vi.fn(async () => ({ "content-type": "application/json" })) }));
vi.mock("@/lib/copilot/copilot-request", () => ({ copilotRequestHeaders: mocks.headers }));
vi.mock("@/lib/copilot/client-deadline", () => ({ withClientDeadline: async (h: Promise<Record<string, string>>) => h }));
vi.mock("@/contexts/ledger-subscriber", () => ({ useLedgerTick: () => ({ tick: 0, latestLedger: 0 }) }));

import { useWorkflow } from "@/hooks/use-workflow";

const WALLET = "GDW3B2BVO3MUBPIYWZQA6ZGIOHD73CNZITY5YKVD5KOOHMZ72REVVJ52";
const ID = "f1581834-94be-4517-b3d9-1dae3730e8d1";
const view = (status: WorkflowView["status"], steps: string[]): WorkflowView => ({
  id: ID, status, revision: 1, digest: "d", objective: "Two steps", message: "",
  steps: steps.map((state, index) => ({ id: `s${index + 1}`, label: `Step ${index + 1}`, op: "deposit_collateral", asset: "XLM", amount: "1", status: state,
    ...(state === "pending" ? {} : { txHash: `h${index}` }) })),
} as unknown as WorkflowView);

beforeEach(() => { localStorage.setItem(`vanna-workflow:${WALLET}`, ID); });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe("useWorkflow - a run under way keeps going when its chat is left", () => {
  it("goes on asking the server until the plan completes, and never repaints the screen", async () => {
    const script = [
      view("running", ["submitted", "pending"]),          // restored on mount
      view("running", ["settled", "submitted"]),          // first background look: step 2 issued
      view("completed", ["settled", "settled"]),          // second: done
    ];
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const next = script.shift();
      if (!next) throw new Error(`unscripted ${url}`);
      return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const { result } = renderHook(() => useWorkflow(WALLET));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(result.current.view?.steps[0].status).toBe("submitted");
    act(() => { result.current.reset(); });
    expect(result.current.view).toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, 6_500)); });
    expect(calls.filter((call) => call.startsWith("POST") && call.endsWith("/advance"))).toHaveLength(2);
    expect(script).toHaveLength(0);
    expect(result.current.view).toBeNull();
  }, 20_000);
  it("does not abort an approval that is still in flight when the chat is left, then carries the run on", async () => {
    let releaseApprove!: () => void;
    const approvedGate = new Promise<void>((resolve) => { releaseApprove = resolve; });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/approve")) {
        await approvedGate;
        if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
        return new Response(JSON.stringify(view("approved", ["pending", "pending"])), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/advance")) return new Response(JSON.stringify(view("completed", ["settled", "settled"])), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(view("proposed", ["pending", "pending"])), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const { result } = renderHook(() => useWorkflow(WALLET));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(result.current.view?.status).toBe("proposed");
    let approving!: Promise<boolean>;
    await act(async () => { approving = result.current.approve(); await new Promise((r) => setTimeout(r, 20)); });
    act(() => { result.current.reset(); });
    await act(async () => { releaseApprove(); await approving; await new Promise((r) => setTimeout(r, 50)); });
    expect(calls.some((call) => call.endsWith("/advance"))).toBe(true);
    expect(result.current.view).toBeNull();
  });
});
