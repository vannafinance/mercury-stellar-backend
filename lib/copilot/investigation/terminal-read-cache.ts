import type { MCPClient } from "../mcp-client";
import { CATALOG } from "./catalog";

const readTools = new Set(CATALOG.map(entry => entry.tool));

/** One investigation only; execution uses its own fresh MCP client. */
export function reuseTerminalReadFailures(client: Pick<MCPClient, "call">): Pick<MCPClient, "call"> {
  const failures = new Map<string, Record<string, unknown>>();
  return { call: async (tool, args, userId) => {
    if (!readTools.has(tool)) return client.call(tool, args, userId);
    const key = JSON.stringify([tool, Object.keys(args).sort().map(name => [name, args[name]]), userId ?? null]);
    const prior = failures.get(key);
    if (prior) return structuredClone(prior);
    const response = await client.call(tool, args, userId);
    // Legacy MCP mislabeled all oracle panics as missing feeds. Require an
    // explicit non-retryable declaration, not just that ambiguous reason label.
    // Prices, stale data, generic failures and exceptions are never cached.
    if (response.error === "contract_error" && response.reason === "no_price_feed" && response.retryable === false) {
      failures.set(key, structuredClone(response));
    }
    return response;
  } };
}
