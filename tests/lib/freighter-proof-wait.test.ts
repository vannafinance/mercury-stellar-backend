import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ pendingWalletSession: vi.fn(), walletSessionStatus: vi.fn(), getActiveWalletKind: vi.fn(() => "freighter") }));
vi.mock("@/lib/copilot/establish-wallet-session", () => mocks);
vi.mock("@/lib/wallet-adapter", () => ({ getActiveWalletKind: mocks.getActiveWalletKind }));
vi.mock("@/lib/copilot/copilot-request", () => ({ copilotRequestHeaders: vi.fn(async () => ({ "Content-Type": "application/json" })) }));
import { requestHeaders } from "@/hooks/use-investigation";
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe("Freighter user-reviewed sign-in proof", () => {
  it("waits for an in-flight message signature beyond the old ten-second window", async () => {
    vi.useFakeTimers(); let finish!: (value: boolean) => void;
    mocks.pendingWalletSession.mockReturnValue(new Promise<boolean>(resolve => { finish = resolve; }));
    mocks.walletSessionStatus.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    let returned = false;
    const waiting = requestHeaders(new AbortController().signal, "wallet").then(value => { returned = true; return value; });
    await vi.advanceTimersByTimeAsync(15_000); expect(returned).toBe(false);
    finish(true); expect(await waiting).toEqual({ "Content-Type": "application/json" });
  });
  it("reports the missing ownership proof instead of sending a guest request", async () => {
    mocks.walletSessionStatus.mockResolvedValue(false); mocks.pendingWalletSession.mockReturnValue(null);
    await expect(requestHeaders(new AbortController().signal, "wallet")).rejects.toThrow("Verify your Freighter wallet");
  });
  it("cancelling while the message proof is pending stops the request", async () => {
    mocks.walletSessionStatus.mockResolvedValue(false); mocks.pendingWalletSession.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController(); const waiting = requestHeaders(controller.signal, "wallet");
    controller.abort(); await expect(waiting).rejects.toThrow();
  });
});
