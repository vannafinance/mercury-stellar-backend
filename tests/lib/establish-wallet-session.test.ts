import { afterEach, describe, expect, it, vi } from "vitest";
const sign = vi.hoisted(() => vi.fn());
vi.mock("@/lib/wallet-adapter", () => ({ signMessage: sign }));
import { establishWalletSession, pendingWalletSession } from "@/lib/copilot/establish-wallet-session";
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("shared Freighter ownership proof", () => {
  it("coalesces concurrent consumers into one prompt and encodes byte signatures", async () => {
    let signed!: (value: unknown) => void;
    sign.mockReturnValue(new Promise(resolve => { signed = resolve; }));
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      const body = options?.body ? JSON.parse(String(options.body)) : null;
      if (!body) return { ok: true, json: async () => ({ ok: false }) };
      if (body.action === "challenge") return { ok: true, json: async () => ({ ok: true, message: "ownership challenge" }) };
      expect(body.signature).toBe("AQID");
      return { ok: true, json: async () => ({ ok: true, wallet: "wallet" }) };
    });
    vi.stubGlobal("fetch", fetcher);
    const first = establishWalletSession("wallet"); const second = establishWalletSession("wallet");
    expect(first).toBe(second); expect(pendingWalletSession("wallet")).toBe(first);
    await vi.waitFor(() => expect(sign).toHaveBeenCalledTimes(1));
    signed({ signedMessage: new Uint8Array([1, 2, 3]), signerAddress: "wallet" });
    expect(await first).toBe(true); expect(pendingWalletSession("wallet")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("refuses proof signed by another wallet and allows a fresh attempt after refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, options?: RequestInit) => ({ ok: true, json: async () => options?.body
      ? { ok: true, message: "ownership challenge" } : { ok: false } })));
    sign.mockResolvedValue({ signedMessage: "signature", signerAddress: "other" });
    expect(await establishWalletSession("wallet")).toBe(false);
    expect(pendingWalletSession("wallet")).toBeNull();
    expect(await establishWalletSession("wallet")).toBe(false);
    expect(sign).toHaveBeenCalledTimes(2);
  });
});
