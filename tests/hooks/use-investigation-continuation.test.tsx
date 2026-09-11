// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ResearchView } from "@/lib/copilot/investigation/view";

/**
 * Which turns continue a prior investigation, and which start a new one.
 *
 * The continuation token carries the ORIGINAL objective plus every refinement, and the
 * research prompt instructs the model never to discard that objective. Sending it on
 * every turn therefore did not merely mislabel the card — asking "price of XLM" and then
 * a full strategy goal recorded "price of XLM" as the objective and reduced the real goal
 * to a refinement of it, so the investigation kept optimising the wrong thing. Only a
 * reply to an open question may continue; anything else starts over.
 */

const mocks = vi.hoisted(() => ({
  headers: vi.fn(async () => ({ "content-type": "application/json" })),
  consume: vi.fn(),
}));

vi.mock("@/lib/copilot/copilot-request", () => ({ copilotRequestHeaders: mocks.headers }));
vi.mock("@/lib/copilot/investigation/stream", () => ({ consumeResearchStream: mocks.consume }));

import { useInvestigation } from "@/hooks/use-investigation";

const WALLET = "GDW3B2BVO3MUBPIYWZQA6ZGIOHD73CNZITY5YKVD5KOOHMZ72REVVJ52";

function view(over: Partial<ResearchView> = {}): ResearchView {
  return {
    status: "researched", message: "collected", originalRequest: "original", refinements: [],
    understanding: null, question: null, facts: [], checks: [], warnings: [],
    scope: { wallet: WALLET, smartAccount: null, network: "testnet" },
    continuation: "r1.token", executionAllowed: false, ...over,
  };
}

/** Queue one server outcome per run() call, and record what each request sent. */
function server(outcomes: Array<{ result?: ResearchView; error?: { code: string; message: string } }>) {
  const sent: Array<{
    message: string;
    continuation: string | null;
    session?: string | null;
    wallet: string | null;
    history?: Array<{ role: string; text: string }>;
  }> = [];
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { body?: string; method?: string }) => {
    if (!init?.body) return { ok: false, status: 404 } as unknown as Response;
    sent.push(JSON.parse(init.body));
    return { ok: true, body: {} } as unknown as Response;
  }));
  mocks.consume.mockImplementation(async (_res: unknown, emit: (event: unknown) => void) => {
    const outcome = outcomes[Math.min(call++, outcomes.length - 1)];
    if (outcome.error) emit({ type: "error", ...outcome.error });
    else emit({ type: "result", result: outcome.result });
  });
  return sent;
}

describe("useInvestigation — continuation chaining", () => {
  it("can cancel while identity headers are stalled, without sending a request later", async () => {
    const sent = server([{ result: view() }]);
    mocks.headers.mockImplementationOnce(() => new Promise(() => {}));
    const { result } = renderHook(() => useInvestigation(WALLET));
    let running: Promise<void>;
    act(() => { running = result.current.run("wallet balances"); });
    await act(async () => { result.current.cancel(); await running; });
    expect(result.current.loading).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("two prompts submitted in sequence each POST to investigate", async () => {
    const sent = server([{ result: view() }, { result: view() }]);
    const { result } = renderHook(() => useInvestigation(WALLET));
    await act(async () => { await result.current.run("first"); });
    await act(async () => { await result.current.run("second"); });
    expect(sent.map((row) => row.message)).toEqual(["first", "second"]);
    expect(result.current.loading).toBe(false);
  });

  it("a second prompt while headers are stalled still sends its own request and clears loading", async () => {
    mocks.headers.mockImplementationOnce(() => new Promise(() => {}));
    const sent = server([{ result: view() }, { result: view() }]);
    const { result } = renderHook(() => useInvestigation(WALLET));
    let first!: Promise<void>;
    act(() => { first = result.current.run("first"); });
    expect(result.current.loading).toBe(true);
    await act(async () => { await result.current.run("second"); });
    expect(sent.map((row) => row.message)).toEqual(["second"]);
    expect(result.current.loading).toBe(false);
    await act(async () => { await first; });
    expect(sent).toHaveLength(1);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue({ "content-type": "application/json" });
    sessionStorage.clear();
  });

  it("does not chain a new goal onto a finished investigation", async () => {
    const sent = server([{ result: view({ continuation: "r1.first", question: null }) }]);
    const { result } = renderHook(() => useInvestigation(WALLET));

    await act(async () => { await result.current.run("price of XLM"); });
    await act(async () => { await result.current.run("build a strategy with USDC and XLM"); });

    expect(sent).toHaveLength(2);
    expect(sent.map((row) => row.message)).toEqual([
      "price of XLM",
      "build a strategy with USDC and XLM",
    ]);
    expect(result.current.loading).toBe(false);
    expect(sent[0].continuation).toBeNull();
    expect(sent[0].history).toEqual([]);
    // New objective: do not inherit the first goal, but keep the transcript and evidence token.
    expect(sent[1].continuation).toBeNull();
    expect(sent[1].session).toBe("r1.first");
    expect(sent[1].message).toBe("build a strategy with USDC and XLM");
    expect(sent[1].history).toEqual([
      { role: "user", text: "price of XLM" },
      { role: "assistant", text: "collected" },
    ]);
    expect(result.current.turns.map((turn) => turn.text)).toEqual([
      "price of XLM",
      "collected",
      "build a strategy with USDC and XLM",
      "collected",
    ]);
  });

  it("chains a reply that answers an open question", async () => {
    const sent = server([
      { result: view({ status: "needs_input", continuation: "r1.first", question: "How much do you want to invest?" }) },
      { result: view({ continuation: "r1.second", question: null }) },
    ]);
    const { result } = renderHook(() => useInvestigation(WALLET));

    await act(async () => { await result.current.run("build a strategy with USDC and XLM"); });
    await act(async () => { await result.current.run("about 500 USDC"); });

    expect(sent[1].message).toBe("about 500 USDC");
    expect(sent[1].continuation).toBe("r1.first");
    expect(sent[1].history).toEqual([
      { role: "user", text: "build a strategy with USDC and XLM" },
      { role: "assistant", text: "collected" },
    ]);
  });

  it("stops chaining a new independent goal once the answered question is resolved", async () => {
    const sent = server([
      { result: view({ status: "needs_input", continuation: "r1.first", question: "Which venue?" }) },
      { result: view({ continuation: "r1.second", question: null }) },
      { result: view({ continuation: "r1.health", question: null, message: "Health is 1.46." }) },
    ]);
    const { result } = renderHook(() => useInvestigation(WALLET));

    await act(async () => { await result.current.run("build a strategy"); });
    await act(async () => { await result.current.run("Vanna Earn"); });
    await act(async () => { await result.current.run("what's my health factor"); });

    expect(sent[1].continuation).toBe("r1.first");
    expect(sent[2].continuation).toBeNull();
    expect(sent[2].session).toBe("r1.second");
    expect(result.current.turns.some((turn) => turn.text === "build a strategy")).toBe(true);
    expect(result.current.turns.some((turn) => turn.text === "what's my health factor")).toBe(true);
  });

  it("chains a refinement of the current plan as a full re-solve, not a new investigation", async () => {
    const sent = server([
      { result: view({
        status: "researched", continuation: "r1.first", question: null,
        understanding: { intent: "strategy", objective: "Build a yield position", constraints: ["1.3 floor"], borrowing: "allowed" },
      }) },
      { result: view({ continuation: "r1.second", question: null }) },
    ]);
    const { result } = renderHook(() => useInvestigation(WALLET));

    await act(async () => { await result.current.run("build a strategy with USDC"); });
    await act(async () => { await result.current.run("make it 1.4 instead"); });

    expect(sent[1].message).toBe("make it 1.4 instead");
    expect(sent[1].continuation).toBe("r1.first");
  });

  it("keeps the thread on screen while a reply is in flight", async () => {
    const sent = server([
      { result: view({ status: "needs_input", continuation: "r1.first", question: "Which variant?", message: "Which USDC?" }) },
      { result: view({ continuation: "r1.second", question: null, message: "Using SOUSDC." }) },
    ]);
    const { result } = renderHook(() => useInvestigation(WALLET));

    await act(async () => { await result.current.run("supply my USDC"); });
    expect(result.current.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(result.current.result?.question).toBe("Which variant?");

    await act(async () => { await result.current.run("SOUSDC"); });
    expect(sent[1].continuation).toBe("r1.first");
    expect(result.current.turns.map((turn) => turn.text)).toEqual([
      "supply my USDC",
      "Which USDC?",
      "SOUSDC",
      "Using SOUSDC.",
    ]);
  });

  it("drops the chain when the server reports the context expired", async () => {
    const sent = server([
      { result: view({ status: "needs_input", continuation: "r1.first", question: "Which venue?" }) },
      { error: { code: "context_expired", message: "This investigation has expired." } },
      { result: view({ question: null }) },
    ]);
    const { result } = renderHook(() => useInvestigation(WALLET));

    await act(async () => { await result.current.run("build a strategy"); });
    await act(async () => { await result.current.run("Vanna Earn"); });
    await act(async () => { await result.current.run("Vanna Earn"); });

    expect(sent[1].continuation).toBe("r1.first");
    expect(sent[2].continuation).toBeNull();
    expect(sent[2].history).toEqual([
      { role: "user", text: "build a strategy" },
      { role: "assistant", text: "collected" },
    ]);
  });

  it("reset clears the chain so the next goal starts clean", async () => {
    const sent = server([
      { result: view({ status: "needs_input", continuation: "r1.first", question: "Which venue?" }) },
      { result: view({ question: null }) },
    ]);
    const { result } = renderHook(() => useInvestigation(WALLET));

    await act(async () => { await result.current.run("build a strategy"); });
    act(() => { result.current.reset(); });
    await act(async () => { await result.current.run("something else entirely"); });

    expect(sent[1].continuation).toBeNull();
    expect(sent[1].history).toEqual([]);
  });

  it("clears loading when the result event arrives even if the stream stays open", async () => {
    server([{ result: view() }]);
    mocks.consume.mockImplementation(async (_res: unknown, emit: (event: unknown) => void) => {
      emit({ type: "result", result: view() });
      await new Promise(() => {});
    });
    const { result } = renderHook(() => useInvestigation(WALLET));
    act(() => { void result.current.run("can I withdraw 100 XLM without getting liquidated?"); });
    await vi.waitFor(() => {
      expect(result.current.result?.message).toBe("collected");
    });
    expect(result.current.loading).toBe(false);
    act(() => { result.current.cancel(); });
  });
});
