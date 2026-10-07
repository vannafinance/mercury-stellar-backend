// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ResearchView } from "@/lib/copilot/investigation/view";
import { receiptKey, type WorkflowCompletionReply } from "@/lib/copilot/workflow-completion";

/**
 * Conversations: the server keeps every one a signed-in user has had; the hook lists them,
 * carries the open one's id on each turn so the server appends to it, starts a new chat
 * without creating anything, opens one from the list, and deletes one.
 */

const mocks = vi.hoisted(() => ({
  headers: vi.fn(async () => ({ authorization: "Bearer t", "x-privy-token": "test-token" })),
  consume: vi.fn(),
}));

vi.mock("@/lib/copilot/copilot-request", () => ({ copilotRequestHeaders: mocks.headers }));
vi.mock("@/lib/copilot/investigation/stream", () => ({ consumeResearchStream: mocks.consume }));

import { useInvestigation } from "@/hooks/use-investigation";

const WALLET = "GDW3B2BVO3MUBPIYWZQA6ZGIOHD73CNZITY5YKVD5KOOHMZ72REVVJ52";

function view(message: string, continuation = "r1.token"): ResearchView {
  return {
    status: "researched", message, originalRequest: message, refinements: [],
    understanding: null, question: null, facts: [], checks: [], warnings: [],
    scope: { wallet: WALLET, smartAccount: null, network: "testnet" },
    continuation, executionAllowed: false,
  };
}

const SUMMARIES = [
  { id: "c-older", title: "lend 1 XLM", createdAt: 1_000, updatedAt: 1_000 },
  { id: "c-newer", title: "repay 25% of my debt", createdAt: 2_000, updatedAt: 2_000 },
];

/** A fake server: the session list, one conversation to open, and investigate results with ids. */
function server(results: Array<{ result: ResearchView; conversationId?: string }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let turn = 0;
  // The server owns the list. A recorded turn changes what the next GET returns, which is
  // what the hook re-reads rather than assembling a summary of its own.
  const listed = [...SUMMARIES];
  const record = (id: string, title: string) => {
    const at = 3_000 + turn * 1_000;
    const existing = listed.findIndex((entry) => entry.id === id);
    if (existing >= 0) listed[existing] = { ...listed[existing], updatedAt: at };
    else listed.push({ id, title, createdAt: at, updatedAt: at });
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string; method?: string }) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
    if (url === "/api/copilot/session" && (init?.method ?? "GET") === "GET") {
      return { ok: true, json: async () => ({ conversations: [...listed], activeId: "c-newer", turns: [
        { role: "user", text: "repay 25% of my debt" }, { role: "assistant", text: "Repay …", question: null },
      ], continuation: "r-newer", result: view("Repay …", "r-newer") }) } as unknown as Response;
    }
    if (url === "/api/copilot/session/c-newer" && (init?.method ?? "GET") === "GET") {
      return { ok: true, json: async () => ({ id: "c-newer", turns: [
        { role: "user", text: "repay 25% of my debt" }, { role: "assistant", text: "Repay …", question: null },
      ], continuation: "r-newer", result: view("Repay …", "r-newer") }) } as unknown as Response;
    }
    if (url === "/api/copilot/session/c-older" && (init?.method ?? "GET") === "GET") {
      return { ok: true, json: async () => ({ id: "c-older", turns: [
        { role: "user", text: "lend 1 XLM" }, { role: "assistant", text: "Lend 1 XLM.", question: null },
      ], continuation: "r-older", result: view("Lend 1 XLM.", "r-older") }) } as unknown as Response;
    }
    if (url === "/api/copilot/investigate") return { ok: true, body: {} } as unknown as Response;
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }));
  mocks.consume.mockImplementation(async (_res: unknown, emit: (event: unknown) => void) => {
    const next = results[Math.min(turn++, results.length - 1)];
    if (next.conversationId) record(next.conversationId, next.result.message);
    emit({ type: "result", result: next.result, ...(next.conversationId ? { conversationId: next.conversationId } : {}) });
  });
  return calls;
}

beforeEach(() => {
  sessionStorage.clear();
  mocks.consume.mockReset();
});

describe("useInvestigation - conversations", () => {
  it("keeps the last selected chat when an older open request resolves late", async () => {
    server([]);
    const original = globalThis.fetch;
    const pending = new Map<string, (response: Response) => void>();
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/c-older") || url.endsWith("/c-newer")) return new Promise<Response>(resolve => pending.set(url, resolve));
      return original(url, init);
    }));
    const { result } = renderHook(() => useInvestigation(WALLET));
    await waitFor(() => expect(result.current.conversations.length).toBeGreaterThan(0));
    let older!: Promise<void>, newer!: Promise<void>;
    act(() => { older = result.current.open("c-older"); });
    await waitFor(() => expect(pending.has("/api/copilot/session/c-older")).toBe(true));
    act(() => { newer = result.current.open("c-newer"); });
    await waitFor(() => expect(pending.has("/api/copilot/session/c-newer")).toBe(true));
    await act(async () => {
      pending.get("/api/copilot/session/c-newer")!(new Response(JSON.stringify({ id: "c-newer", turns: [], continuation: null, result: null })));
      await newer;
      pending.get("/api/copilot/session/c-older")!(new Response(JSON.stringify({ id: "c-older", turns: [], continuation: null, result: null })));
      await older;
    });
    expect(result.current.conversationId).toBe("c-newer");
  });

  it("does not reopen a slow previous selection after the user selects the current chat again", async () => {
    server([]);
    const { result } = renderHook(() => useInvestigation(WALLET));
    await waitFor(() => expect(result.current.conversations.length).toBeGreaterThan(0));
    await act(async () => { await result.current.open("c-newer"); });
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    let older!: Promise<void>;
    act(() => { older = result.current.open("c-older"); });
    await waitFor(() => expect(resolve).toBeDefined());
    await act(async () => {
      await result.current.open("c-newer");
      resolve(new Response(JSON.stringify({ id: "c-older", turns: [], continuation: null, result: null })));
      await older;
    });
    expect(result.current.conversationId).toBe("c-newer");
  });
  it("does not strand the spinner when the open chat is re-selected during a reply", async () => {
    server([{ conversationId: "c-newer", result: view("Late answer") }]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const settle = mocks.consume.getMockImplementation()!;
    mocks.consume.mockImplementation(async (res: unknown, emit: (event: unknown) => void) => { await held; await settle(res, emit); });
    const { result } = renderHook(() => useInvestigation(WALLET));
    await waitFor(() => expect(result.current.conversations.length).toBeGreaterThan(0));
    await act(async () => { await result.current.open("c-newer"); });
    let reply!: Promise<void>;
    act(() => { reply = result.current.run("Another question"); });
    await waitFor(() => expect(result.current.loading).toBe(true));
    await act(async () => { await result.current.open("c-newer"); });
    expect(result.current.loading).toBe(true);
    await act(async () => { release(); await reply; });
    expect(result.current.loading).toBe(false);
    expect(result.current.turns.at(-1)?.text).toBe("Late answer");
  });
  it("delivers a late settled summary to its exact workflow turn and rejects conversation/wallet switches", async () => {
    server([{ conversationId: "c-newer", result: view("Latest answer") }]);
    const { result } = renderHook(() => useInvestigation(WALLET));
    await waitFor(() => expect(result.current.conversations.length).toBeGreaterThan(0));
    await act(async () => { await result.current.open("c-newer"); });
    const receipt = { workflowId: "run-owned", network: "testnet", status: "completed" as const,
      steps: [{ operation: "lend" as const, asset: "XLM", amount: "1", status: "settled" as const, txHash: "a".repeat(64), settledLedger: 123 }] };
    await act(async () => { await result.current.updateExecutionReceipt(receipt); });
    await act(async () => { await result.current.run("Another question"); });
    const reply: WorkflowCompletionReply = { message: "Settled supply", replyBlocks: [{ type: "paragraph", segments: [{ text: "Settled supply" }] }], receipt,
      completion: { workflowId: receipt.workflowId, receiptKey: receiptKey(receipt), generatedAt: 1, source: "model" } };
    act(() => result.current.updateWorkflowCompletion(reply, "c-newer", "other-wallet"));
    expect(result.current.turns[1].text).not.toBe(reply.message);
    act(() => result.current.updateWorkflowCompletion(reply, "c-newer", WALLET));
    expect(result.current.turns[1].text).toBe(reply.message);
    expect(result.current.turns.at(-1)?.text).toBe("Latest answer");
    const saved = JSON.parse(sessionStorage.getItem(`vanna.copilot.thread.${WALLET}`)!);
    expect(saved.turns[1].completion.workflowId).toBe(receipt.workflowId);
    await act(async () => { await result.current.open("c-older"); });
    act(() => result.current.updateWorkflowCompletion(reply, "c-newer", WALLET));
    expect(result.current.turns.map((turn) => turn.text)).toEqual(["lend 1 XLM", "Lend 1 XLM."]);
  });
  /**
   * A reload starts a new chat (owner, 25 Sep): the server's open conversation stays in the
   * list, where opening it brings every turn back, and its pointer is cleared so the next turn
   * is not appended to it.
   */
  it("lists the server's conversations on load, starts blank, and reopens the last one from the list", async () => {
    const calls = server([]);
    const { result } = renderHook(() => useInvestigation(WALLET));
    await waitFor(() => expect(result.current.conversations.map((c) => c.id)).toEqual(["c-newer", "c-older"]));
    expect(result.current.conversationId).toBeNull();
    expect(result.current.turns).toEqual([]);
    await waitFor(() => expect(calls.some((c) => c.url === "/api/copilot/session" && c.method === "DELETE")).toBe(true));
    await act(async () => { await result.current.open("c-newer"); });
    expect(result.current.conversationId).toBe("c-newer");
    expect(result.current.turns.map((t) => t.text)).toEqual(["repay 25% of my debt", "Repay …"]);
  });

  it("archives the chat that was on screen when the page reloads, and keeps it openable", async () => {
    server([]);
    sessionStorage.setItem(`vanna.copilot.thread.${WALLET}`, JSON.stringify({
      wallet: WALLET, turns: [{ role: "user", text: "lend 5 XLM" }, { role: "assistant", text: "Lent 5 XLM." }],
      continuation: null, result: null, conversationId: null,
    }));
    const { result } = renderHook(() => useInvestigation(WALLET));
    expect(result.current.turns).toEqual([]);
    const archived = result.current.conversations.find((c) => c.title === "lend 5 XLM");
    expect(archived?.id).toMatch(/^local:/);
    await act(async () => { await result.current.open(archived!.id); });
    expect(result.current.turns.map((t) => t.text)).toEqual(["lend 5 XLM", "Lent 5 XLM."]);
  });

  it("persists a workflow receipt and mirrors it into the open thread", async () => {
    const calls = server([{ result: view("unused") }]);
    const { result } = renderHook(() => useInvestigation(WALLET));
    await waitFor(() => expect(result.current.conversations.length).toBe(2));
    await act(async () => { await result.current.open("c-newer"); });
    expect(result.current.conversationId).toBe("c-newer");
    const hash = "a".repeat(64);
    await act(async () => {
      expect(await result.current.updateExecutionReceipt({
        workflowId: "wf-1", status: "completed", network: "testnet",
        steps: [{ operation: "swap", asset: "XLM", amount: "10", status: "settled", txHash: hash, settledLedger: 42 }],
      })).toBe(true);
    });
    expect(calls.some((call) => call.url === "/api/copilot/session/c-newer" && call.method === "PATCH")).toBe(true);
    expect(result.current.turns[1]?.executionReceipt?.steps[0]?.txHash).toBe(hash);
  });

  // 7 Oct, live (auto-approve on): a finished run's receipt was attached to its turn only after the save succeeded; the save never went
  // out, so the run had no summary at all. The turn gets the receipt first, and the save reports whether it worked so it can be retried.
  it("puts a receipt on its turn even when saving it fails, and says the save failed", async () => {
    const calls = server([{ result: view("unused") }]);
    const { result } = renderHook(() => useInvestigation(WALLET));
    await waitFor(() => expect(result.current.conversations.length).toBe(2));
    await act(async () => { await result.current.open("c-newer"); });
    const hash = "b".repeat(64);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === "PATCH") return new Response("{}", { status: 500 });
      return new Response("{}");
    }));
    let saved = true;
    await act(async () => {
      saved = await result.current.updateExecutionReceipt({
        workflowId: "wf-2", status: "completed", network: "testnet",
        steps: [{ operation: "lend", asset: "XLM", amount: "5", status: "settled", txHash: hash, settledLedger: 7 }],
      });
    });
    expect(saved).toBe(false);
    expect(result.current.turns[1]?.executionReceipt?.steps[0]?.txHash).toBe(hash);
    expect(calls).toBeDefined();
  });

  it("sends the open conversation's id with a turn, and adopts the id the server records a first turn under", async () => {
    const calls = server([{ result: view("Repay …", "r2"), conversationId: "c-newer" }, { result: view("1.46"), conversationId: "c-fresh" }]);
    const { result } = renderHook(() => useInvestigation(WALLET));
    await waitFor(() => expect(result.current.conversations.length).toBe(2));
    await act(async () => { await result.current.open("c-newer"); });
    expect(result.current.conversationId).toBe("c-newer");
    await act(async () => { await result.current.run("and my debt?"); });
    const first = calls.find((c) => c.url === "/api/copilot/investigate")?.body as { conversationId?: string };
    expect(first.conversationId).toBe("c-newer");
    // New chat: the screen clears, the list keeps the conversation, the next turn carries no id …
    await act(async () => { result.current.newChat(); });
    expect(result.current.turns).toEqual([]);
    expect(result.current.conversationId).toBeNull();
    expect(result.current.conversations.map((c) => c.id)).toContain("c-newer");
    await act(async () => { await result.current.run("what's my health?"); });
    const second = calls.filter((c) => c.url === "/api/copilot/investigate")[1].body as { conversationId?: string };
    expect(second.conversationId).toBeUndefined();
    // … and the server's new id is adopted, with the list re-read from the server rather
    // than guessed locally, so its order and titles are the ones a reload would show.
    expect(result.current.conversationId).toBe("c-fresh");
    await waitFor(() => expect(result.current.conversations[0]).toMatchObject({ id: "c-fresh" }));
    expect(sessionStorage.getItem(`vanna.copilot.thread.${WALLET}`)).toContain("c-fresh");
  });

  it("opens a conversation from the list and deletes one, clearing the screen when it was the open one", async () => {
    const calls = server([]);
    const { result } = renderHook(() => useInvestigation(WALLET));
    await waitFor(() => expect(result.current.conversations.length).toBe(2));
    await act(async () => { await result.current.open("c-older"); });
    expect(result.current.conversationId).toBe("c-older");
    expect(result.current.turns.map((t) => t.text)).toEqual(["lend 1 XLM", "Lend 1 XLM."]);
    await act(async () => { await result.current.remove("c-older"); });
    expect(result.current.conversations.map((c) => c.id)).toEqual(["c-newer"]);
    expect(result.current.turns).toEqual([]);
    expect(calls.some((c) => c.url === "/api/copilot/session/c-older" && c.method === "DELETE")).toBe(true);
  });

  it("lists the live chat immediately when the server has not recorded it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string; method?: string }) => {
      if (url === "/api/copilot/session" && (init?.method ?? "GET") === "GET") {
        return { ok: true, json: async () => ({ conversations: [], activeId: null, turns: [] }) } as unknown as Response;
      }
      if (url === "/api/copilot/investigate") return { ok: true, body: {} } as unknown as Response;
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }));
    mocks.consume.mockImplementation(async (_res: unknown, emit: (event: unknown) => void) => {
      emit({ type: "result", result: view("Lend 100 XLM to Earn.") });
    });
    const { result } = renderHook(() => useInvestigation(WALLET));
    await act(async () => { await result.current.run("can you deposit xlm,usdc,blusdc 100 into the lending"); });
    expect(result.current.conversations[0]).toMatchObject({
      id: "local:current",
      title: "can you deposit xlm,usdc,blusdc 100 into the lending",
    });
  });

  it("archives and restores local conversation turns when clicking a local conversation in Recents", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string; method?: string }) => {
      if (url === "/api/copilot/session" && (init?.method ?? "GET") === "GET") {
        return { ok: true, json: async () => ({ conversations: [], activeId: null, turns: [] }) } as unknown as Response;
      }
      if (url === "/api/copilot/investigate") return { ok: true, body: {} } as unknown as Response;
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }));
    mocks.consume.mockImplementation(async (_res: unknown, emit: (event: unknown) => void) => {
      emit({ type: "result", result: view("Lend 50 XLM.") });
    });
    const { result } = renderHook(() => useInvestigation(WALLET));
    await act(async () => { await result.current.run("lend 50 XLM"); });
    expect(result.current.turns.map((t) => t.text)).toEqual(["lend 50 XLM", "Lend 50 XLM."]);
    const localId = result.current.conversations[0]?.id;
    expect(localId).toBe("local:current");

    // Click new chat
    await act(async () => { result.current.newChat(); });
    expect(result.current.turns).toEqual([]);
    expect(result.current.conversationId).toBeNull();
    const archivedId = result.current.conversations[0]?.id;
    expect(archivedId).toMatch(/^local:\d+$/);

    // Reopen the archived local conversation from Recents
    await act(async () => { await result.current.open(archivedId!); });
    expect(result.current.conversationId).toBe(archivedId);
    expect(result.current.turns.map((t) => t.text)).toEqual(["lend 50 XLM", "Lend 50 XLM."]);
  });

  it("sends questionnaire answers with the continuation of the reply that issued them", async () => {
    const calls = server([{ result: view("Which asset?", "r-issued") }, { result: view("Done.") }]);
    const { result } = renderHook(() => useInvestigation(WALLET));
    await act(async () => { await result.current.run("supply my usdc"); });
    const answers = { questionnaireId: "q1", asset: "asset:AQUSDC", venue: "lend:AQUSDC", amount: { kind: "fraction" as const, percent: "25" }, summary: "Lend 25% of my AQUSDC to Earn" };
    await act(async () => { await result.current.run(answers.summary, undefined, answers); });
    const sent = calls.filter((c) => c.url === "/api/copilot/investigate")[1].body as { answers?: unknown; continuation?: string; message?: string };
    expect(sent.answers).toEqual(answers);
    expect(sent.continuation).toBe("r-issued");
    expect(sent.message).toBe(answers.summary);
  });
});
