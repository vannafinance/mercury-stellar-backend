// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ResearchView } from "@/lib/copilot/investigation/view";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(async () => ({ authorization: "Bearer t", "x-privy-token": "test-token" })),
  consume: vi.fn(),
}));
vi.mock("@/lib/copilot/copilot-request", () => ({ copilotRequestHeaders: mocks.headers }));
vi.mock("@/lib/copilot/investigation/stream", () => ({ consumeResearchStream: mocks.consume }));

import { useInvestigation } from "@/hooks/use-investigation";

const WALLET = "GDW3B2BVO3MUBPIYWZQA6ZGIOHD73CNZITY5YKVD5KOOHMZ72REVVJ52";

function view(message: string): ResearchView {
  return {
    status: "researched", message, originalRequest: message, refinements: [],
    understanding: null, question: null, facts: [], checks: [], warnings: [],
    scope: { wallet: WALLET, smartAccount: null, network: "testnet" },
    continuation: "r1.token", executionAllowed: false,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  mocks.consume.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
    if (url === "/api/copilot/investigate") return { ok: true, body: {} } as unknown as Response;
    if (url === "/api/copilot/session" && (init?.method ?? "GET") === "GET") {
      return { ok: true, json: async () => ({ conversations: [], activeId: null }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }));
  mocks.consume.mockImplementation(async (_res: unknown, emit: (event: unknown) => void) => {
    emit({ type: "result", result: view("Deposit 5 XLM as collateral."), conversationId: "c-1" });
  });
});
afterEach(() => vi.restoreAllMocks());

const userTurns = (turns: Array<{ role: string; text: string }>) => turns.filter((t) => t.role === "user").map((t) => t.text);

describe("useInvestigation - continuing a request the user already made", () => {
  it("adds the user's message once for a normal run", async () => {
    const { result } = renderHook(() => useInvestigation(WALLET));
    await act(async () => { await result.current.run("Deposit 5 XLM"); });
    expect(userTurns(result.current.turns)).toEqual(["Deposit 5 XLM"]);
  });

  it("adds no user message when the run is a continuation, and still shows the reply", async () => {
    const { result } = renderHook(() => useInvestigation(WALLET));
    await act(async () => { await result.current.run("Deposit 5 XLM", undefined, undefined, undefined, { echoUser: false }); });
    expect(userTurns(result.current.turns)).toEqual([]);
    expect(result.current.turns.at(-1)).toMatchObject({ role: "assistant", text: "Deposit 5 XLM as collateral." });
  });

  it("clears the direct-lane card in the store when it is cleared", async () => {
    const { result } = renderHook(() => useInvestigation(WALLET));
    act(() => { result.current.syncDirect({ kind: "staged" }, "Deposit 5 XLM"); });
    await waitFor(() => expect(result.current.directResponse).toEqual({ kind: "staged" }));
    act(() => { result.current.syncDirect(null, null); });
    await waitFor(() => expect(result.current.directResponse).toBeNull());
    expect(result.current.directSubmitted).toBeNull();
  });
});
