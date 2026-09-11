import { describe, expect, it, vi } from "vitest";
import { RETRY, isRetryableError, withRetry } from "@/lib/copilot/retry-policy";

describe("retry policy", () => {
  it("retries rpc reads on ECONNRESET and then succeeds", async () => {
    const op = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce("ok");
    await expect(withRetry(RETRY.rpcRead, op)).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("does not retry writes", async () => {
    const op = vi.fn().mockRejectedValue(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    await expect(withRetry(RETRY.mcpWrite, op)).rejects.toThrow(/EPIPE/);
    expect(op).toHaveBeenCalledTimes(1);
    expect(isRetryableError({ code: "EPIPE" }, RETRY.mcpWrite)).toBe(false);
  });

  it("does not retry a non-retryable read error", async () => {
    const op = vi.fn().mockRejectedValue(new Error("simulation failed: invalid footprint"));
    await expect(withRetry(RETRY.rpcRead, op)).rejects.toThrow(/invalid footprint/);
    expect(op).toHaveBeenCalledTimes(1);
  });
});
