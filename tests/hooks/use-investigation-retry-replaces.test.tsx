// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ResearchView } from "@/lib/copilot/investigation/view";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(async () => ({ authorization: "Bearer t", "x-privy-token": "test-token" })),
  consume: vi.fn(),
}));
vi.mock("@/lib/copilot/copilot-request", () => ({ copilotRequestHeaders: mocks.headers }));
vi.mock("@/lib/copilot/investigation/stream", () => ({ consumeResearchStream: mocks.consume }));

import { useInvestigation } from "@/hooks/use-investigation";

/**
 * 24 Oct, live: "Try again" after a time-out left "The investigation ran out of time" on screen and wrote the new
 * reply under it, so the chat read as two answers to one question. A retry replaces the reply it retries.
 */
const WALLET = "GDW3B2BVO3MUBPIYWZQA6ZGIOHD73CNZITY5YKVD5KOOHMZ72REVVJ52";
const view = (message: string, status: ResearchView["status"] = "researched"): ResearchView => ({
  status, message, originalRequest: "Show the rates", refinements: [],
  understanding: null, question: null, facts: [], checks: [], warnings: [],
  scope: { wallet: WALLET, smartAccount: null, network: "testnet" },
  continuation: "r1.token", executionAllowed: false,
});

let replies: ResearchView[] = [];
beforeEach(() => {
  sessionStorage.clear();
  mocks.consume.mockReset();
  replies = [view("The investigation ran out of time before it could finish. Nothing was executed - please try again.", "incomplete"), view("XLM 14.6% APR.")];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
    if (url === "/api/copilot/investigate") return { ok: true, body: {} } as unknown as Response;
    if (url === "/api/copilot/session" && (init?.method ?? "GET") === "GET") {
      return { ok: true, json: async () => ({ conversations: [], activeId: null }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }));
  mocks.consume.mockImplementation(async (_res: unknown, emit: (event: unknown) => void) => {
    emit({ type: "result", result: replies.shift()!, conversationId: "c-1" });
  });
});
afterEach(() => vi.restoreAllMocks());

const texts = (turns: Array<{ role: string; text: string }>) => turns.map((t) => `${t.role}:${t.text}`);

describe("useInvestigation - a retry replaces the reply it retries", () => {
  it("drops the stopped reply and shows only the new one", async () => {
    const { result } = renderHook(() => useInvestigation(WALLET));
    await act(async () => { await result.current.run("Show the rates"); });
    expect(texts(result.current.turns)).toEqual(["user:Show the rates", expect.stringMatching(/^assistant:The investigation ran out of time/)]);
    await act(async () => { await result.current.run("Show the rates", undefined, undefined, undefined, { echoUser: false, replaceLastReply: true }); });
    expect(texts(result.current.turns)).toEqual(["user:Show the rates", "assistant:XLM 14.6% APR."]);
  });

  it("without the option, a second run still stacks (nothing else changes)", async () => {
    const { result } = renderHook(() => useInvestigation(WALLET));
    await act(async () => { await result.current.run("Show the rates"); });
    await act(async () => { await result.current.run("Show the rates", undefined, undefined, undefined, { echoUser: false }); });
    expect(result.current.turns.filter((t) => t.role === "assistant")).toHaveLength(2);
  });
});
