// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { WorkflowView } from "@/lib/copilot/workflow/types";

/**
 * A submitted step settles when a ledger closes, not when a person clicks.
 *
 * ## The live failure this pins
 *
 * 13 Sep, signed in, "use my AqUSDC sitting in Earn as collateral": the redeem was on
 * chain at 10:15:57 (ledger 4654194) and the deposit at 10:19:37 — and the card said
 * "Broadcasting…" through both, because after `submit` the hook asked the server exactly
 * once, immediately, before the ledger had closed, then waited for "Check progress".
 * Acceptance: with no click at all, a ledger close moves a submitted step on and the run
 * continues to the next step; a ledger close while a click is being served does nothing.
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

function view(status: WorkflowView["status"], steps: Array<{ status: string; txHash?: string }>): WorkflowView {
  return {
    id: ID, status, revision: 1, digest: "d",
    objective: "Redeem Earn AQUSDC and Deposit as Collateral", message: "",
    steps: steps.map((step, index) => ({
      id: `s${index + 1}`, label: index === 0 ? "Redeem" : "Deposit", op: index === 0 ? "redeem" : "deposit_collateral",
      asset: "AQUSDC", amount: "1", status: step.status, ...(step.txHash ? { txHash: step.txHash } : {}),
    })),
  } as unknown as WorkflowView;
}

/** The server, scripted: each call consumes the next view. The hook's restore-on-mount GET comes first. */
function server(script: WorkflowView[]) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const next = script.shift();
    if (!next) throw new Error(`unscripted call ${url}`);
    return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => { localStorage.setItem(`vanna-workflow:${WALLET}`, ID); });
afterEach(() => { vi.unstubAllGlobals(); mocks.tick.value = 0; localStorage.clear(); });

describe("useWorkflow — a submitted step is re-asked about at every ledger close", () => {
  it("settles step 1 and runs step 2 with no click, one ask per ledger close", async () => {
    const calls = server([
      // Restored on mount: paused on the submitted redeem, exactly where `confirm` leaves it.
      view("running", [{ status: "submitted", txHash: "e5e75d39" }, { status: "pending" }]),
      // First ledger close: the lookup finds the redeem; step 2 is built, auto-signed, submitted.
      view("running", [{ status: "settled", txHash: "e5e75d39" }, { status: "submitted", txHash: "86f5bc5c" }]),
      // Second ledger close: the deposit is found; the plan is complete.
      view("completed", [{ status: "settled", txHash: "e5e75d39" }, { status: "settled", txHash: "86f5bc5c" }]),
    ]);
    const { result, rerender } = renderHook(() => useWorkflow(WALLET));
    await flush();
    expect(result.current.view?.steps[0].status).toBe("submitted");
    expect(calls).toEqual([`GET /api/copilot/workflow/${ID}`]);

    mocks.tick.value = 1; rerender(); await flush();
    expect(calls).toEqual([`GET /api/copilot/workflow/${ID}`, `POST /api/copilot/workflow/${ID}/advance`]);
    expect(result.current.view?.steps.map((s) => s.status)).toEqual(["settled", "submitted"]);
    expect(result.current.loading).toBe(false);

    mocks.tick.value = 2; rerender(); await flush();
    expect(calls.filter((c) => c.endsWith("/advance"))).toHaveLength(2);
    expect(result.current.view?.status).toBe("completed");
    expect(result.current.error).toBeNull();
  });

  it("does not ask while a click is already being served, and not at all once nothing is in flight", async () => {
    const calls = server([
      view("running", [{ status: "submitted", txHash: "e5e75d39" }, { status: "pending" }]),
      // The one advance: the redeem settled and the deposit now needs the wallet's signature.
      view("awaiting_signature", [{ status: "settled", txHash: "e5e75d39" }, { status: "awaiting_signature" }]),
    ]);
    const { result, rerender } = renderHook(() => useWorkflow(WALLET));
    await flush();

    // A click is in progress: the server has not answered it yet.
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementationOnce(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      await pending;
      return new Response(JSON.stringify(view("awaiting_signature", [{ status: "settled", txHash: "e5e75d39" }, { status: "awaiting_signature" }])), { status: 200 });
    });
    await act(async () => { void result.current.resume(); });
    expect(result.current.loading).toBe(true);
    mocks.tick.value = 1; rerender(); await flush();
    // The ledger closed while the click was outstanding: no second request.
    expect(calls.filter((c) => c.endsWith("/advance"))).toHaveLength(1);
    await act(async () => { release(); await pending; }); await flush();
    expect(result.current.view?.status).toBe("awaiting_signature");

    // Nothing is on its way to a ledger now: further ledger closes ask nothing.
    mocks.tick.value = 2; rerender(); await flush();
    mocks.tick.value = 3; rerender(); await flush();
    expect(calls.filter((c) => c.endsWith("/advance"))).toHaveLength(1);
  });
});
