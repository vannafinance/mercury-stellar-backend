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
const options = () => ({ wallet: "wallet", onInvestigate: vi.fn(async () => {}) });

describe("single composer entry", () => {
  it("investigates every prompt, concrete instruction or open-ended goal alike", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const message of [
      "deposit 5 XLM as collateral",
      "Swap 10 XLM to AQUSDC then add liquidity in Aquarius",
      "build me a strategy that keeps health factor above 1.3",
      "what is my health factor?",
    ]) {
      const input = options();
      const { result } = renderHook(() => useCopilotEntry(input));
      await act(async () => result.current.run(message));
      expect(input.onInvestigate).toHaveBeenCalledWith(message);
      expect(result.current.loading).toBe(false);
    }
    // No routing round-trip: there is nothing left to classify.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores an empty prompt and does not start an investigation", async () => {
    const input = options();
    const { result } = renderHook(() => useCopilotEntry(input));
    await act(async () => result.current.run("   "));
    expect(input.onInvestigate).not.toHaveBeenCalled();
  });

  it("runs one investigation at a time", async () => {
    // A deferred created up front, and always settled before the test ends — a promise
    // left pending here leaks React state updates into the tests that follow.
    let release = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const input = { wallet: "wallet", onInvestigate: vi.fn(() => pending) };
    const { result } = renderHook(() => useCopilotEntry(input));

    const first = act(async () => { await result.current.run("first"); });
    await act(async () => { await result.current.run("second"); });
    expect(input.onInvestigate).toHaveBeenCalledTimes(1);
    expect(input.onInvestigate).toHaveBeenCalledWith("first");

    release();
    await first;
  });

  it("surfaces a failure as an error instead of continuing quietly", async () => {
    const input = {
      wallet: "wallet",
      onInvestigate: vi.fn(async () => { throw new Error("MCP unavailable"); }),
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
    const input = { wallet: "wallet", onInvestigate: vi.fn(() => (call++ === 0 ? pending : Promise.resolve())) };
    const { result } = renderHook(() => useCopilotEntry(input));

    const first = act(async () => { await result.current.run("build me a strategy"); });
    act(() => result.current.cancel());
    expect(result.current.loading).toBe(false);

    // The abandoned run must not block the next one.
    await act(async () => { await result.current.run("deposit 5 XLM as collateral"); });
    expect(input.onInvestigate).toHaveBeenCalledTimes(2);

    release();
    await first;
  });
});
