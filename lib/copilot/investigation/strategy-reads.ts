/**
 * Live market + wallet reads used to rank strategy candidates.
 *
 * Shared by investigation seeding and by proposal rebuild when sealed evidence is stale.
 * AQUSDC and SOUSDC are Earn-only: they have pools, not Blend reserves.
 */

import type { MCPClient } from "../mcp-client";
import { resolveRead } from "./capabilities";
import { interruptible } from "./runtime";
import { isRecord } from "./decision";
import type { InvestigationScope, Observation } from "./types";

export const STRATEGY_READS = [
  { capability: "wallet_balances", args: {} },
  { capability: "asset_price", args: { asset: "XLM" } },
  { capability: "asset_price", args: { asset: "BLUSDC" } },
  { capability: "asset_price", args: { asset: "AQUSDC" } },
  { capability: "asset_price", args: { asset: "SOUSDC" } },
  { capability: "earn_market", args: { asset: "XLM" } },
  { capability: "earn_market", args: { asset: "BLUSDC" } },
  { capability: "earn_market", args: { asset: "AQUSDC" } },
  { capability: "earn_market", args: { asset: "SOUSDC" } },
  { capability: "blend_markets", args: {} },
] as const;

export function looksLikeStatedWrite(message: string): boolean {
  const text = message.trim();
  return /^(repay|lend|deposit|withdraw|borrow)\s+\d/i.test(text)
    || /\b(repay|lend|deposit|withdraw)\s+\d+(\.\d+)?\s*(xlm|blusdc|aqusdc|sousdc|usdc)\b/i.test(text);
}

/** Ranking evidence is only worth the round-trip on an allocation question. */
export function needsMarketSeed(message: string): boolean {
  if (looksLikeStatedWrite(message)) return false;
  return /\b(strateg|allocat|best (pool|rate|apy)|supply my|lend my|deploy|invest|yield|compare|use both|take new loan|borrow as much|as much as possible|health factor (doesn'?t|does not) go below)\b/i.test(message);
}

export async function collectStrategyReads(
  scope: InvestigationScope,
  mcp: Pick<MCPClient, "call">,
  signal: AbortSignal,
  now: number,
): Promise<Observation[]> {
  const prepared: Array<{ capability: string; args: Record<string, unknown>; read: ReturnType<typeof resolveRead> }> = [];
  for (const request of STRATEGY_READS) {
    try {
      prepared.push({
        capability: request.capability, args: { ...request.args },
        read: resolveRead(request.capability, request.args, scope),
      });
    } catch { /* capability unavailable for this scope; skip rather than invent */ }
  }
  const observations: Observation[] = prepared.map((entry, offset) => ({
    id: `p${offset + 1}`, capability: entry.capability, args: entry.args, observedAt: now, status: "error",
  }));
  await Promise.all(prepared.map(async (entry, offset) => {
    const observation = observations[offset];
    try {
      const response = await interruptible(
        () => mcp.call(entry.read.tool, entry.read.args, scope.trader ?? undefined),
        AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      );
      if (!isRecord(response) || response.error || response.isError === true || response.ok === false) {
        observation.error = "MCP returned unavailable or failed data; do not use it as a financial fact.";
        return;
      }
      observation.data = response;
      observation.status = "ok";
    } catch {
      observation.error = "MCP read failed. No value was inferred.";
    }
  }));
  return observations;
}
