// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(async () => ({ authorization: "Bearer t", "x-privy-token": "test-token" })),
  consume: vi.fn(),
}));
vi.mock("@/lib/copilot/copilot-request", () => ({ copilotRequestHeaders: mocks.headers }));
vi.mock("@/lib/copilot/investigation/stream", () => ({ consumeResearchStream: mocks.consume }));

import { useInvestigation } from "@/hooks/use-investigation";

const WALLET = "GDW3B2BVO3MUBPIYWZQA6ZGIOHD73CNZITY5YKVD5KOOHMZ72REVVJ52";

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ conversations: [], activeId: null }), body: {} }) as unknown as Response));
  mocks.consume.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("useInvestigation - holding the progress line between runs", () => {
  it("shows a label, then clears it", () => {
    const { result } = renderHook(() => useInvestigation(WALLET));
    act(() => result.current.holdProgress("Refreshing your account"));
    expect(result.current.loading).toBe(true);
    expect(result.current.progress).toEqual({ kind: "scope", label: "Refreshing your account" });
    act(() => result.current.holdProgress(null));
    expect(result.current.loading).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it("clears itself after a minute so a failed hand-off cannot leave a spinner", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useInvestigation(WALLET));
    act(() => result.current.holdProgress("Waiting for the ledger"));
    act(() => { vi.advanceTimersByTime(61_000); });
    expect(result.current.loading).toBe(false);
  });

  it("does not stop a real run when a clear arrives after it started", async () => {
    const { result } = renderHook(() => useInvestigation(WALLET));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.consume.mockImplementation(async () => { await gate; });
    act(() => result.current.holdProgress("Continuing your original request"));
    let pending!: Promise<void>;
    act(() => { pending = result.current.run("Deposit 5 XLM", undefined, undefined, undefined, { echoUser: false }); });
    act(() => result.current.holdProgress(null));
    expect(result.current.loading).toBe(true);
    await act(async () => { release(); await pending; });
  });

  it("clears the held line when cancel is pressed", () => {
    const { result } = renderHook(() => useInvestigation(WALLET));
    act(() => result.current.holdProgress("Waiting for the ledger"));
    act(() => result.current.cancel());
    expect(result.current.loading).toBe(false);
  });
});
