// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { WorkflowView } from "@/lib/copilot/workflow/types";

/**
 * A plan that waits must stay true, or say that it no longer is.
 *
 * Amounts are sized from reads taken at one moment and then sit on the card until someone
 * clicks Approve. Approve re-reads funds, prices and projected health — but only at the
 * click, so until then a plan whose price has moved looks exactly like one that still
 * holds. What is pinned here: while a proposal waits, ledger closes drive the same check
 * against the server, a plan that fails it is withdrawn with the server's own reason, and
 * a plan that passes is left alone. A check that cannot be made withdraws nothing.
 */

const mocks = vi.hoisted(() => ({
  headers: vi.fn(async () => ({ "content-type": "application/json" })),
  tick: { value: 0 },
}));
vi.mock("@/lib/copilot/copilot-request", () => ({ copilotRequestHeaders: mocks.headers }));
vi.mock("@/lib/copilot/client-deadline", () => ({ withClientDeadline: async (h: Promise<Record<string, string>>) => h }));
vi.mock("@/contexts/ledger-subscriber", () => ({ useLedgerTick: () => ({ tick: mocks.tick.value, latestLedger: 0 }) }));

import { useWorkflow } from "@/hooks/use-workflow";

const WALLET = "GDW3B2BVO3MUBPIYWZQA6ZGIOHD73CNZITY5YKVD5KOOHMZ72REVVJ52";
const ID = "f1581834-94be-4517-b3d9-1dae3730e8d1";

function view(status: WorkflowView["status"], revision = 1): WorkflowView {
  return {
    id: ID, status, revision, digest: "d", objective: "Supply 100 XLM to Blend", message: "",
    steps: [{ id: "s1", label: "Supply", op: "blend_supply", asset: "XLM", amount: "100", status: "pending" }],
  } as unknown as WorkflowView;
}

/** The server, scripted: the restore GET first, then whatever each later call is handed. */
function server(script: Array<{ body: unknown; status?: number }>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const next = script.shift();
    if (!next) throw new Error(`unscripted call ${url}`);
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => { localStorage.setItem(`vanna-workflow:${WALLET}`, ID); });
afterEach(() => { vi.unstubAllGlobals(); mocks.tick.value = 0; localStorage.clear(); });

describe("useWorkflow — a waiting plan is re-checked at the ledger, not only at Approve", () => {
  it("withdraws the plan with the server's reason when it no longer holds", async () => {
    const calls = server([
      { body: view("proposed") },
      { body: { fresh: false, reason: "There is not enough XLM in the wallet for the approved step." } },
    ]);
    const { result, rerender } = renderHook(() => useWorkflow(WALLET));
    await flush();
    expect(result.current.view?.status).toBe("proposed");
    expect(result.current.stale).toBeNull();

    mocks.tick.value = 1; rerender(); await flush();
    expect(calls).toContain(`POST /api/copilot/workflow/${ID}/recheck`);
    expect(result.current.stale).toBe("There is not enough XLM in the wallet for the approved step.");
  });

  it("leaves a plan that still holds alone", async () => {
    server([{ body: view("proposed") }, { body: { fresh: true } }]);
    const { result, rerender } = renderHook(() => useWorkflow(WALLET));
    await flush();
    mocks.tick.value = 1; rerender(); await flush();
    expect(result.current.stale).toBeNull();
  });

  it("withdraws nothing when the check itself could not be made", async () => {
    server([{ body: view("proposed") }, { body: { message: "no" }, status: 500 }]);
    const { result, rerender } = renderHook(() => useWorkflow(WALLET));
    await flush();
    mocks.tick.value = 1; rerender(); await flush();
    expect(result.current.stale).toBeNull();
  });

  it("does not re-check a plan that is no longer waiting for a person", async () => {
    const calls = server([{ body: view("approved") }]);
    const { result, rerender } = renderHook(() => useWorkflow(WALLET));
    await flush();
    mocks.tick.value = 1; rerender(); await flush();
    expect(result.current.view?.status).toBe("approved");
    expect(calls).toEqual([`GET /api/copilot/workflow/${ID}`]);
  });

  it("does not carry one plan's withdrawal onto the next plan prepared", async () => {
    server([
      { body: view("proposed") },
      { body: { fresh: false, reason: "The oracle price for this asset is too old to size a plan." } },
      { body: view("proposed", 2) },
    ]);
    const { result, rerender } = renderHook(() => useWorkflow(WALLET));
    await flush();
    mocks.tick.value = 1; rerender(); await flush();
    expect(result.current.stale).toBeTruthy();

    await act(async () => { await result.current.propose("r1.token", "blend.supply.XLM"); });
    expect(result.current.view?.revision).toBe(2);
    expect(result.current.stale).toBeNull();
  });
});
