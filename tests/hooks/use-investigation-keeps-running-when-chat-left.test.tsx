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
import { readStoredLocalThread } from "@/lib/copilot/investigation/thread";

/**
 * 24 Oct, live: looking at another chat while a prompt was still being worked out threw the answer away - the chat came
 * back showing only the question. A reply run now keeps going when its chat is left, files its answer under that chat, and
 * is picked back up if the chat is opened while it is still working.
 */
const WALLET = "GDW3B2BVO3MUBPIYWZQA6ZGIOHD73CNZITY5YKVD5KOOHMZ72REVVJ52";
const reply = (message: string): ResearchView => ({
  status: "researched", message, originalRequest: "Show the rates", refinements: [],
  understanding: null, question: null, facts: [], checks: [], warnings: [],
  scope: { wallet: WALLET, smartAccount: null, network: "testnet" },
  continuation: "r1.token", executionAllowed: false,
});

let release: (() => void) | null = null;
const releases: Array<() => void> = [];
let aborted = false;
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  release = null;
  releases.length = 0;
  aborted = false;
  mocks.consume.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; signal?: AbortSignal }) => {
    if (url === "/api/copilot/investigate") {
      init?.signal?.addEventListener("abort", () => { aborted = true; });
      return { ok: true, body: {} } as unknown as Response;
    }
    if (url === "/api/copilot/session" && (init?.method ?? "GET") === "GET") {
      return { ok: true, json: async () => ({ conversations: [], activeId: null }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }));
  // The answer arrives only when the test lets it.
  mocks.consume.mockImplementation((_res: unknown, emit: (event: unknown) => void) =>
    new Promise<void>((resolve) => { release = () => { emit({ type: "result", result: reply("XLM 14.6% APR.") }); resolve(); }; releases.push(release); }));
});
afterEach(() => vi.restoreAllMocks());

const started = async (hook: ReturnType<typeof renderHook<ReturnType<typeof useInvestigation>, unknown>>) => {
  let pending!: Promise<void>;
  await act(async () => { pending = hook.result.current.run("Show the rates") as Promise<void>; await new Promise((r) => setTimeout(r, 30)); });
  return { pending };
};

describe("useInvestigation - a reply keeps running when its chat is left", () => {
  it("is not aborted by New chat, and its answer is filed under the chat it belongs to", async () => {
    const hook = renderHook(() => useInvestigation(WALLET));
    const { pending } = await started(hook);
    expect(hook.result.current.loading).toBe(true);
    act(() => { hook.result.current.newChat(); });
    expect(aborted).toBe(false);
    expect(hook.result.current.turns).toEqual([]);
    expect(hook.result.current.loading).toBe(false);
    const localId = hook.result.current.conversations.find((item) => item.id.startsWith("local:"))!.id;
    expect(readStoredLocalThread(WALLET, localId)?.turns.map((turn) => turn.role)).toEqual(["user"]);
    await act(async () => { release!(); await pending; });
    // The blank chat on screen is untouched; the left chat now holds the answer.
    expect(hook.result.current.turns).toEqual([]);
    expect(readStoredLocalThread(WALLET, localId)?.turns.map((turn) => `${turn.role}:${turn.text}`)).toEqual(["user:Show the rates", "assistant:XLM 14.6% APR."]);
  });

  it("is picked back up when its chat is opened while it is still working, and the answer lands there", async () => {
    const hook = renderHook(() => useInvestigation(WALLET));
    const { pending } = await started(hook);
    act(() => { hook.result.current.newChat(); });
    const localId = hook.result.current.conversations.find((item) => item.id.startsWith("local:"))!.id;
    await act(async () => { await hook.result.current.open(localId); });
    expect(hook.result.current.loading).toBe(true);
    await act(async () => { release!(); await pending; });
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.turns.map((turn) => `${turn.role}:${turn.text}`)).toEqual(["user:Show the rates", "assistant:XLM 14.6% APR."]);
  });
  it("treats an answer that landed while the chat was away as just received when the chat is opened soon after, and as history later", async () => {
    for (const [waitMs, origin] of [[10_000, "live"], [300_000, "restored"]] as const) {
      sessionStorage.clear(); localStorage.clear();
      const hook = renderHook(() => useInvestigation(WALLET));
      const { pending } = await started(hook);
      act(() => { hook.result.current.newChat(); });
      const localId = hook.result.current.conversations.find((item) => item.id.startsWith("local:"))!.id;
      await act(async () => { release!(); await pending; });
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + waitMs);
      await act(async () => { await hook.result.current.open(localId); });
      expect(hook.result.current.resultOrigin).toBe(origin);
      expect(hook.result.current.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
      vi.restoreAllMocks();
      hook.unmount();
    }
  });
  it("is not stopped by a new prompt sent in the chat that was opened meanwhile", async () => {
    const hook = renderHook(() => useInvestigation(WALLET));
    const { pending: first } = await started(hook);
    act(() => { hook.result.current.newChat(); });
    let second!: Promise<void>;
    await act(async () => { second = hook.result.current.run("Another question") as Promise<void>; await new Promise((r) => setTimeout(r, 30)); });
    expect(aborted).toBe(false);
    const localId = Object.keys(sessionStorage).map((key) => key.match(/\.(local:\d+)$/)?.[1]).find(Boolean)!;
    await act(async () => { releases[0](); await first; });
    expect(readStoredLocalThread(WALLET, localId)?.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    await act(async () => { releases[1](); await second; });
    expect(hook.result.current.turns.map((turn) => turn.text)).toEqual(["Another question", "XLM 14.6% APR."]);
  });
});
