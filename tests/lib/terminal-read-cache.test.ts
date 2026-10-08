import { describe, expect, it, vi } from "vitest";
import { reuseTerminalReadFailures } from "@/lib/copilot/investigation/terminal-read-cache";

describe("request-local terminal read failures", () => {
  const noFeed = { error: "contract_error", reason: "no_price_feed", retryable: false, symbol: "XLM" };

  it("reuses the same confirmed missing feed across research and preparation", async () => {
    const call = vi.fn().mockResolvedValue(noFeed);
    const client = reuseTerminalReadFailures({ call });
    expect(await client.call("vanna_get_price", { symbol: "XLM" }, "user")).toEqual(noFeed);
    expect(await client.call("vanna_get_price", { symbol: "XLM" }, "user")).toEqual(noFeed);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("keeps different assets and identities separate and resets for a new investigation", async () => {
    const call = vi.fn().mockResolvedValue(noFeed);
    const client = reuseTerminalReadFailures({ call });
    await client.call("vanna_get_price", { symbol: "XLM" }, "one");
    await client.call("vanna_get_price", { symbol: "USDC" }, "one");
    await client.call("vanna_get_price", { symbol: "XLM" }, "two");
    await reuseTerminalReadFailures({ call }).call("vanna_get_price", { symbol: "XLM" }, "one");
    expect(call).toHaveBeenCalledTimes(4);
  });

  it.each([
    { error: "contract_error", reason: "no_price_feed" },
    { error: "contract_error" },
    { error: "stale_price" },
    { error: "server_not_ready" },
    { price_usd: "0.2" },
  ])("does not cache transient failures or live financial figures: %j", async (response) => {
    const call = vi.fn().mockResolvedValue(response);
    const client = reuseTerminalReadFailures({ call });
    await client.call("vanna_get_price", { symbol: "XLM" });
    await client.call("vanna_get_price", { symbol: "XLM" });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("never caches writes, including a write rejected for a missing feed", async () => {
    const call = vi.fn().mockResolvedValue(noFeed);
    const client = reuseTerminalReadFailures({ call });
    await client.call("vanna_borrow", { symbol: "XLM", amount: "1" });
    await client.call("vanna_borrow", { symbol: "XLM", amount: "1" });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("keeps transport exceptions retryable", async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue({ price_usd: "0.2" });
    const client = reuseTerminalReadFailures({ call });
    await expect(client.call("vanna_get_price", { symbol: "XLM" })).rejects.toThrow("timeout");
    expect(await client.call("vanna_get_price", { symbol: "XLM" })).toEqual({ price_usd: "0.2" });
    expect(call).toHaveBeenCalledTimes(2);
  });
});
