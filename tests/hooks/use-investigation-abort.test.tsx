// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

/**
 * A deadline and a cancel are different events and must not share a sentence.
 *
 * ## The live failure this pins
 *
 * 13 Sep, signed in: a healthy investigation was eleven seconds in when the wallet store
 * reported `null` for a render, the hook's wallet effect treated that as "wallet changed",
 * aborted the request and wiped the thread — and the user read "The investigation ran out
 * of time before it could finish". Handoff §5: an aborted request reported as a timeout.
 * Acceptance, verbatim: trigger both paths deliberately; they produce different messages.
 */

const mocks = vi.hoisted(() => ({
  headers: vi.fn(async () => ({ "content-type": "application/json" })),
  consume: vi.fn(),
}));
vi.mock("@/lib/copilot/copilot-request", () => ({ copilotRequestHeaders: mocks.headers }));
vi.mock("@/lib/copilot/investigation/stream", () => ({ consumeResearchStream: mocks.consume }));

import { useInvestigation } from "@/hooks/use-investigation";

const WALLET = "GDW3B2BVO3MUBPIYWZQA6ZGIOHD73CNZITY5YKVD5KOOHMZ72REVVJ52";

/** A server that never answers: the run ends only by deadline or abort. */
function silentServer() {
  vi.stubGlobal("fetch", vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useInvestigation — deadline vs cancel", () => {
  it("says 'ran out of time' only when the 120s backstop fired", async () => {
    vi.useFakeTimers();
    silentServer();
    const { result } = renderHook(() => useInvestigation(WALLET));
    await act(async () => { void result.current.run("deploy my XLM"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_500); });
    expect(result.current.error).toMatch(/ran out of time/);
  });

  it("says 'cancelled or replaced' when the request was aborted before the deadline", async () => {
    vi.useFakeTimers();
    silentServer();
    const { result } = renderHook(() => useInvestigation(WALLET));
    const outer = new AbortController();
    await act(async () => { void result.current.run("deploy my XLM", outer.signal); });
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
    // Eleven seconds in, the request is torn down by its owner — not by the clock.
    await act(async () => { outer.abort(); await vi.advanceTimersByTimeAsync(10); });
    expect(result.current.error).toBe("This investigation was cancelled or replaced before it finished. Nothing was executed — run it again.");
    expect(result.current.loading).toBe(false);
  });

  it("does not abort a run when the wallet store blinks to null and back", async () => {
    vi.useFakeTimers();
    silentServer();
    let wallet: string | null = WALLET;
    const { result, rerender } = renderHook(() => useInvestigation(wallet));
    await act(async () => { void result.current.run("deploy my XLM"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(result.current.loading).toBe(true);
    // The store reports null for one render, then the same wallet again.
    wallet = null; rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    wallet = WALLET; rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.turns.map((t) => t.text)).toContain("deploy my XLM");
  });

  it("still resets when the wallet really disconnects", async () => {
    vi.useFakeTimers();
    silentServer();
    let wallet: string | null = WALLET;
    const { result, rerender } = renderHook(() => useInvestigation(wallet));
    await act(async () => { void result.current.run("deploy my XLM"); });
    wallet = null; rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(result.current.loading).toBe(false);
    expect(result.current.turns).toEqual([]);
  });
});
