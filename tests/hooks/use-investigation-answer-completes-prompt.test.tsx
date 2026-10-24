// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ResearchView } from "@/lib/copilot/investigation/view";
import type { QuestionnaireAnswers } from "@/lib/copilot/investigation/view";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(async () => ({ authorization: "Bearer t", "x-privy-token": "test-token" })),
  consume: vi.fn(),
}));
vi.mock("@/lib/copilot/copilot-request", () => ({ copilotRequestHeaders: mocks.headers }));
vi.mock("@/lib/copilot/investigation/stream", () => ({ consumeResearchStream: mocks.consume }));

import { useInvestigation } from "@/hooks/use-investigation";

/**
 * 24 Oct: after "deposit usdc" drew its questionnaire and the user chose, the thread showed their choices as a second
 * prompt, "Deposit 370.94 AQUSDC", under the first. An answer completes the prompt that asked, so it takes that prompt's place.
 */
const WALLET = "GDW3B2BVO3MUBPIYWZQA6ZGIOHD73CNZITY5YKVD5KOOHMZ72REVVJ52";
const view = (message: string, extra: Record<string, unknown> = {}): ResearchView => ({
  status: "researched", message, originalRequest: message, refinements: [],
  understanding: null, question: null, facts: [], checks: [], warnings: [],
  scope: { wallet: WALLET, smartAccount: null, network: "testnet" },
  continuation: "r1.token", executionAllowed: false, ...extra,
}) as ResearchView;

let replies: ResearchView[] = [];
beforeEach(() => {
  sessionStorage.clear();
  mocks.consume.mockReset();
  replies = [];
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

const users = (turns: Array<{ role: string; text: string }>) => turns.filter((t) => t.role === "user").map((t) => t.text);
const answers = { questionnaireId: "q1", summary: "Deposit 370.94 AQUSDC", asset: "AQUSDC", venue: null, amount: { kind: "literal", amount: "370.94" } } as unknown as QuestionnaireAnswers;

describe("useInvestigation - a questionnaire answer completes the prompt that asked", () => {
  it("shows one prompt, the completed one, and the reply to it", async () => {
    const { result } = renderHook(() => useInvestigation(WALLET));
    replies = [view("Which asset?", { questionnaire: { questionnaireId: "q1" } }), view("Deposit prepared.")];
    await act(async () => { await result.current.run("deposit usdc"); });
    expect(users(result.current.turns)).toEqual(["deposit usdc"]);
    await act(async () => { await result.current.run(answers.summary, undefined, answers); });
    expect(users(result.current.turns)).toEqual(["Deposit 370.94 AQUSDC"]);
    expect(result.current.turns.at(-1)).toMatchObject({ role: "assistant", text: "Deposit prepared." });
  });

  it("leaves earlier turns of the thread alone", async () => {
    const { result } = renderHook(() => useInvestigation(WALLET));
    replies = [view("Your health factor is 2.32"), view("Which asset?", { questionnaire: { questionnaireId: "q1" } }), view("Deposit prepared.")];
    await act(async () => { await result.current.run("what is my health factor"); });
    await act(async () => { await result.current.run("deposit usdc"); });
    await act(async () => { await result.current.run(answers.summary, undefined, answers); });
    expect(users(result.current.turns)).toEqual(["what is my health factor", "Deposit 370.94 AQUSDC"]);
  });

  it("a prompt sent without answers is still its own prompt", async () => {
    const { result } = renderHook(() => useInvestigation(WALLET));
    replies = [view("Which asset?", { questionnaire: { questionnaireId: "q1" } }), view("You hold 5 XLM")];
    await act(async () => { await result.current.run("deposit usdc"); });
    await act(async () => { await result.current.run("and my balance?"); });
    expect(users(result.current.turns)).toEqual(["deposit usdc", "and my balance?"]);
  });
});
