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
    // MCP explicitly identifies a missing configured feed as non-transient. Do not
    // cache prices, stale data, generic contract failures or transport exceptions.
    if (response.error === "contract_error" && response.reason === "no_price_feed") {
      failures.set(key, structuredClone(response));
    }
    return response;
  } };
}
