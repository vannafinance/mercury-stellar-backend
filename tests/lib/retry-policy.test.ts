import { describe, expect, it, vi } from "vitest";
import { RETRY, isRetryableError, withRetry, classifyUpstreamError } from "@/lib/copilot/retry-policy";

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

  it("retries axios Network Error and browser Failed to fetch (case-insensitive)", async () => {
    const axiosBlip = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }))
      .mockResolvedValueOnce("ok");
    await expect(withRetry(RETRY.rpcRead, axiosBlip)).resolves.toBe("ok");
    expect(axiosBlip).toHaveBeenCalledTimes(2);

    const browserBlip = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce("ok");
    await expect(withRetry(RETRY.mcpRead, browserBlip)).resolves.toBe("ok");
    expect(browserBlip).toHaveBeenCalledTimes(2);
  });

  it("retries on HTTP 429 and Cloudflare 524 with jittered backoff", async () => {
    const rateLimited = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("Too Many Requests"), { status: 429 }))
      .mockResolvedValueOnce("ok");
    await expect(withRetry(RETRY.rpcRead, rateLimited)).resolves.toBe("ok");
    expect(rateLimited).toHaveBeenCalledTimes(2);

    const gatewayTimeout = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("Cloudflare 524 A timeout occurred"), { status: 524 }))
      .mockResolvedValueOnce("ok");
    await expect(withRetry(RETRY.mcpRead, gatewayTimeout)).resolves.toBe("ok");
    expect(gatewayTimeout).toHaveBeenCalledTimes(2);
  });

  it("classifies upstream errors into clear user diagnostics", () => {
    expect(classifyUpstreamError(Object.assign(new Error("rate limit exceeded"), { status: 429 })))
      .toContain("RPC rate-limiting (HTTP 429)");
    expect(classifyUpstreamError(new Error("Cloudflare 524 timeout")))
      .toContain("gateway timeout (Cloudflare 524)");
    expect(classifyUpstreamError(new Error("Random user input error"))).toBeNull();
  });
});
