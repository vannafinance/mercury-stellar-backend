// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ResearchView } from "@/lib/copilot/investigation/view";
import type { WorkflowView } from "@/lib/copilot/workflow/types";

/**
 * Coming back to /copilot must show the last turn, not run it again.
 *
 * The live failure: a finished prompt ran a second time whenever the user left the page
 * and returned. The investigation lives in the root layout (so a run survives leaving
 * /copilot) and the journal id lives in localStorage, but the guards that said "this step
 * already went out" were `useRef`s inside `CopilotWorkspace`, which unmounts on every
 * navigation. Guard and data had different lifetimes, so a fresh guard met a finished turn
 * and re-posted `originalRequest`.
 *
 * Two things are pinned here, because the workspace effects read both:
 *  - where a view came from — a turn this page ran (`live`) versus one read back
 *    (`restored`), for the investigation and for the journal;
 *  - that a claim to dispatch is granted once per subject and survives a remount, and is
 *    handed back when the dispatch did not happen.
 */

const mocks = vi.hoisted(() => ({
  headers: vi.fn(async () => ({ "content-type": "application/json", "x-privy-token": "test-token" })),
  consume: vi.fn(),
}));

vi.mock("@/lib/copilot/copilot-request", () => ({ copilotRequestHeaders: mocks.headers }));
vi.mock("@/lib/copilot/investigation/stream", () => ({ consumeResearchStream: mocks.consume }));
vi.mock("@/lib/copilot/client-deadline", () => ({ withClientDeadline: async (h: Promise<Record<string, string>>) => h }));
vi.mock("@/contexts/ledger-subscriber", () => ({ useLedgerTick: () => ({ tick: 0, latestLedger: 0 }) }));

import { useInvestigation } from "@/hooks/use-investigation";
import { useWorkflow } from "@/hooks/use-workflow";
import { claimDispatch, releaseDispatch, forgetDispatchClaims } from "@/lib/copilot/dispatch-once";
import { threadStorageKey } from "@/lib/copilot/investigation/thread";

const WALLET = "GDW3B2BVO3MUBPIYWZQA6ZGIOHD73CNZITY5YKVD5KOOHMZ72REVVJ52";
const JOURNAL = "f1581834-94be-4517-b3d9-1dae3730e8d1";

/** A finished turn that asks the page to carry it on: it nominates a plan and a write. */
function researched(over: Partial<ResearchView> = {}): ResearchView {
  return {
    status: "researched", message: "collected", originalRequest: "withdraw all funds", refinements: [],
    understanding: null, question: null, facts: [], checks: [], warnings: [],
    scope: { wallet: WALLET, smartAccount: null, network: "testnet" },
    continuation: "r1.token", executionAllowed: true,
    proposalCandidateId: "blend.withdraw.XLM",
    ...over,
  } as ResearchView;
}

function journal(status: WorkflowView["status"] = "proposed"): WorkflowView {
  return {
    id: JOURNAL, status, revision: 1, digest: "d", objective: "Withdraw XLM from Blend", message: "",
    steps: [{ id: "s1", label: "Withdraw", op: "blend_withdraw", asset: "XLM", amount: "872.17", status: "pending" }],
  } as unknown as WorkflowView;
}

function streamed(result: ResearchView) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body: {} } as unknown as Response)));
  mocks.consume.mockImplementation(async (_res: unknown, emit: (event: unknown) => void) => {
    emit({ type: "result", result });
  });
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => { forgetDispatchClaims(); });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

describe("an investigation says whether the page ran it or read it back", () => {
  it("marks a streamed answer live, so the chain it nominated may proceed", async () => {
    streamed(researched());
    const { result } = renderHook(() => useInvestigation(WALLET));
    await act(async () => { await result.current.run("withdraw all funds"); });
    expect(result.current.result?.proposalCandidateId).toBe("blend.withdraw.XLM");
    expect(result.current.resultOrigin).toBe("live");
  });

  it("marks a thread rehydrated on mount restored, so nothing re-fires from it", async () => {
    sessionStorage.setItem(threadStorageKey(WALLET), JSON.stringify({
      wallet: WALLET, continuation: "r1.token", conversationId: null,
      turns: [{ role: "user", text: "withdraw all funds" }, { role: "assistant", text: "collected" }],
      result: researched({ pendingWrite: { op: "create_account" } }),
    }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 } as unknown as Response)));
    const { result } = renderHook(() => useInvestigation(WALLET));
    await flush();
    // A reload starts a new chat (owner, 25 Sep): nothing is on screen, so nothing can re-fire …
    expect(result.current.result).toBeNull();
    expect(result.current.turns).toHaveLength(0);
    // … and the chat, reopened from History, is a record, not a turn to run again.
    const archived = result.current.conversations.find((c) => c.title === "withdraw all funds");
    await act(async () => { await result.current.open(archived!.id); });
    expect(result.current.result?.originalRequest).toBe("withdraw all funds");
    expect(result.current.turns).toHaveLength(2);
    expect(result.current.resultOrigin).toBe("restored");
  });
});

describe("a journal says whether the page prepared it or read it back", () => {
  it("marks a journal restored from storage, so auto-approve waits for the person", async () => {
    localStorage.setItem(`vanna-workflow:${WALLET}`, JOURNAL);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(journal()), { status: 200 })));
    const { result } = renderHook(() => useWorkflow(WALLET));
    await flush();
    expect(result.current.view?.id).toBe(JOURNAL);
    expect(result.current.restored).toBe(true);
  });

  it("clears restored once the person prepares a plan, and reports that it landed", async () => {
    localStorage.setItem(`vanna-workflow:${WALLET}`, JOURNAL);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(journal()), { status: 200 })));
    const { result } = renderHook(() => useWorkflow(WALLET));
    await flush();
    expect(result.current.restored).toBe(true);

    let prepared: boolean | undefined;
    await act(async () => { prepared = await result.current.propose("r1.token", "blend.withdraw.XLM"); });
    expect(prepared).toBe(true);
    expect(result.current.restored).toBe(false);
  });

  it("reports a plan that could not be prepared, so a one-shot claim can be released", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "no" }), { status: 500 })));
    const { result } = renderHook(() => useWorkflow(WALLET));
    await flush();
    let prepared: boolean | undefined;
    await act(async () => { prepared = await result.current.propose("r1.token", "blend.withdraw.XLM"); });
    expect(prepared).toBe(false);
    expect(result.current.error).toBeTruthy();
  });
});

describe("a chain step is claimed once per subject, not once per mount", () => {
  it("grants the claim once and refuses it after the guard's component is gone", () => {
    const key = `write:r1.token:create_account`;
    expect(claimDispatch(WALLET, key)).toBe(true);
    expect(claimDispatch(WALLET, key)).toBe(false);
    // Navigating away and back drops every ref the page held; the claim is not one of them.
    forgetDispatchClaims();
    expect(claimDispatch(WALLET, key)).toBe(false);
  });

  it("survives a reload, where the thread is rehydrated and would otherwise replay", () => {
    expect(claimDispatch(WALLET, "propose:r1.token:blend.withdraw.XLM")).toBe(true);
    const persisted = localStorage.getItem(`vanna-copilot-dispatched:${WALLET}`);
    expect(persisted).toContain("propose:r1.token:blend.withdraw.XLM");
  });

  it("hands the claim back when the dispatch did not happen", () => {
    expect(claimDispatch(WALLET, "approve:j1:1")).toBe(true);
    releaseDispatch(WALLET, "approve:j1:1");
    expect(claimDispatch(WALLET, "approve:j1:1")).toBe(true);
  });

  it("keeps one wallet's claims out of another's", () => {
    expect(claimDispatch(WALLET, "sign:j1:s1")).toBe(true);
    expect(claimDispatch("GOTHERWALLET", "sign:j1:s1")).toBe(true);
  });

  it("still dedupes within the page load when storage is unavailable", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    try {
      expect(claimDispatch(WALLET, "write:r2.token:create_account")).toBe(true);
      expect(claimDispatch(WALLET, "write:r2.token:create_account")).toBe(false);
    } finally {
      setItem.mockRestore();
      getItem.mockRestore();
    }
  });
});
