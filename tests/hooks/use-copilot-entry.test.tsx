// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCopilotEntry } from "@/hooks/use-copilot-entry";

/**
 * One composer, and EVERY prompt is investigated.
 *
 * This hook used to ask the server to pick one handler — investigate XOR action — so a
 * concrete instruction skipped investigation entirely and a strategy request could never
 * reach the executor. Both halves were wrong: understanding the account is what makes an
 * action safe, so a write has to be the consequence of an investigation. The contract
 * pinned here is that this hook can ONLY investigate; acting is a separate, explicit step
 * the caller takes afterwards, so nothing here can start a write on its own.
 */

afterEach(() => vi.unstubAllGlobals());
const options = () => ({
  wallet: "wallet",
  onInvestigate: vi.fn(async () => {}),
  onDirect: vi.fn(async () => {}),
});

describe("single composer entry", () => {
  it("routes plain actions directly, strategies and swaps to investigation", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const message of ["deposit 5 XLM as collateral", "what is my health factor?"]) {
      const input = options();
      const { result } = renderHook(() => useCopilotEntry(input));
      await act(async () => result.current.run(message));
      expect(input.onDirect).toHaveBeenCalledWith(message, expect.any(AbortSignal));
      expect(input.onInvestigate).not.toHaveBeenCalled();
      expect(result.current.loading).toBe(false);
    }
    for (const message of ["build me a strategy", "swap 10 XLM to AQUSDC"]) {
      const input = options();
      const { result } = renderHook(() => useCopilotEntry(input));
      await act(async () => result.current.run(message));
      expect(input.onInvestigate).toHaveBeenCalledWith(message, expect.any(AbortSignal));
      expect(input.onDirect).not.toHaveBeenCalled();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores an empty prompt and does not start an investigation", async () => {
    const input = options();
    const { result } = renderHook(() => useCopilotEntry(input));
    await act(async () => result.current.run("   "));
    expect(input.onInvestigate).not.toHaveBeenCalled();
    expect(input.onDirect).not.toHaveBeenCalled();
  });

  it("a new prompt cancels the in-flight one instead of dropping", async () => {
    let release = () => {};
    const pending = new Promise<void>((resolve, reject) => {
      release = resolve;
    });
    let call = 0;
    const input = {
      wallet: "wallet",
      onInvestigate: vi.fn((_message: string, signal: AbortSignal) => {
        call += 1;
        if (call === 1) {
          return new Promise<void>((resolve, reject) => {
            const stop = () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
            if (signal.aborted) stop();
            else signal.addEventListener("abort", stop, { once: true });
            pending.then(resolve, reject);
          });
        }
        return Promise.resolve();
      }),
      onDirect: vi.fn(async () => {}),
    };
    const { result } = renderHook(() => useCopilotEntry(input));

    const first = act(async () => { await result.current.run("build me a strategy first"); });
    await act(async () => { await result.current.run("build me a strategy second"); });
    expect(input.onInvestigate).toHaveBeenCalledTimes(2);
    expect(input.onInvestigate.mock.calls[1][0]).toBe("build me a strategy second");
    expect(result.current.loading).toBe(false);

    release();
    await first;
  });

  it("surfaces a failure as an error instead of continuing quietly", async () => {
    const input = {
      wallet: "wallet",
      onInvestigate: vi.fn(async () => { throw new Error("MCP unavailable"); }),
      onDirect: vi.fn(async () => { throw new Error("MCP unavailable"); }),
    };
    const { result } = renderHook(() => useCopilotEntry(input));
    await act(async () => result.current.run("deposit 5 XLM as collateral"));
    expect(result.current.error).toBe("MCP unavailable");
    expect(result.current.loading).toBe(false);
  });

  it("clears loading and error when the wallet changes", async () => {
    const input = {
      wallet: "wallet-a",
      onInvestigate: vi.fn(async () => { throw new Error("MCP unavailable"); }),
      onDirect: vi.fn(async () => { throw new Error("MCP unavailable"); }),
    };
    const { result, rerender } = renderHook((props: typeof input) => useCopilotEntry(props), {
      initialProps: input,
    });
    await act(async () => result.current.run("deposit 5 XLM as collateral"));
    expect(result.current.error).toBe("MCP unavailable");
    await act(async () => { rerender({ ...input, wallet: "wallet-b" }); });
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("cancel releases the composer so the next prompt is accepted", async () => {
    let release = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    // Only the FIRST run hangs; the follow-up must be able to complete on its own.
    let call = 0;
    const handler = vi.fn(() => (call++ === 0 ? pending : Promise.resolve()));
    const input = { wallet: "wallet", onInvestigate: handler, onDirect: handler };
    const { result } = renderHook(() => useCopilotEntry(input));

    const first = act(async () => { await result.current.run("build me a strategy"); });
    act(() => result.current.cancel());
    expect(result.current.loading).toBe(false);

    // The abandoned run must not block the next one.
    await act(async () => { await result.current.run("deposit 5 XLM as collateral"); });
    expect(handler).toHaveBeenCalledTimes(2);

    release();
    await first;
  });
});

/**
 * Leaving /copilot mid-prompt used to kill the prompt.
 *
 * The composer's controller is what `onInvestigate` receives as its abort signal, and the
 * effect that cancels it on a wallet change also returned `cancel` as its cleanup. React
 * runs a cleanup on unmount too, so navigating to any other route aborted the in-flight
 * fetch and cancelled the server request with it — the investigation did not pause, it
 * died, and returning to the page showed nothing.
 *
 * What is pinned here is which events may stop a run: an explicit cancel, the deadline, a
 * superseding prompt, and a genuine wallet change. Going off screen is not one of them.
 */
describe("a run outlives the page it was started from", () => {
  it("does not abort the investigation when the composer unmounts", async () => {
    let seen: AbortSignal | null = null;
    let release = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const input = {
      wallet: "wallet",
      onInvestigate: vi.fn((_message: string, signal: AbortSignal) => { seen = signal; return pending; }),
      onDirect: vi.fn(async () => {}),
    };
    const { result, unmount } = renderHook(() => useCopilotEntry(input));

    // Not wrapped in `act`: the run must stay genuinely in flight across the unmount,
    // and an async act scope that never settles swallows the assertions after it.
    const inFlight = result.current.run("build me a strategy");
    const signal = seen as unknown as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);

    // The user navigates away while the investigation is still running.
    await act(async () => { unmount(); });
    expect(signal.aborted).toBe(false);

    // And it still finishes, against the state the root layout owns.
    release();
    await inFlight;
    expect(signal.aborted).toBe(false);
  });

  it("still cancels the previous wallet's run when the wallet really changes", async () => {
    let seen: AbortSignal | null = null;
    const pending = new Promise<void>(() => {});
    const input = {
      wallet: "wallet-a",
      onInvestigate: vi.fn((_message: string, signal: AbortSignal) => { seen = signal; return pending; }),
      onDirect: vi.fn(async () => {}),
    };
    const { result, rerender } = renderHook((props: typeof input) => useCopilotEntry(props), {
      initialProps: input,
    });

    void result.current.run("build me a strategy");
    const signal = seen as unknown as AbortSignal;
    expect(signal.aborted).toBe(false);

    await act(async () => { rerender({ ...input, wallet: "wallet-b" }); });
    expect(signal.aborted).toBe(true);
    expect(result.current.loading).toBe(false);
  });
});
