/**
 * Live market + wallet reads used to rank strategy candidates.
 *
 * Shared by investigation seeding and by proposal rebuild when sealed evidence is stale.
 * AQUSDC and SOUSDC are Earn-only: they have pools, not Blend reserves.
 */

import type { MCPClient } from "../mcp-client";
import { allAssets, ASSET_SYMBOL_PATTERN } from "../registry/assets";
import { resolveRead } from "./capabilities";
import { interruptible } from "./runtime";
import { isRecord } from "./decision";
import { PRICE_MAX_AGE_MS } from "./candidates";
import type { InvestigationScope, Observation, ProposedPlan } from "./types";

export interface StrategyRead { capability: string; args: Record<string, unknown> }

/** Every asset with an Earn pool, from the registry — no separate list of "strategy assets". */
const EARN_ASSETS = allAssets().filter((asset) => asset.earnSymbol).map((asset) => asset.id);

export const STRATEGY_READS: readonly StrategyRead[] = [
  { capability: "wallet_balances", args: {} },
  ...EARN_ASSETS.map((asset) => ({ capability: "asset_price", args: { asset } })),
  ...EARN_ASSETS.map((asset) => ({ capability: "earn_market", args: { asset } })),
  { capability: "blend_markets", args: {} },
];

export function looksLikeStatedWrite(message: string): boolean {
  const text = message.trim();
  return /^(repay|lend|deposit|withdraw|borrow)\s+\d/i.test(text)
    || new RegExp(`\\b(repay|lend|deposit|withdraw)\\s+\\d+(\\.\\d+)?\\s*(?:${ASSET_SYMBOL_PATTERN.source}|usdc)\\b`, "i").test(text);
}

/**
 * The reads a set of plans needs that the observations do not already hold fresh: a price
 * and an Earn market for every asset a leg names, the wallet when a leg is sized from it,
 * the Blend reserves when a leg supplies there. Derived from the plans, not from what the
 * user happened to type.
 */
export function readsForPlans(plans: readonly ProposedPlan[], observations: readonly Observation[], now: number): StrategyRead[] {
  const fresh = (capability: string, asset?: string) => observations.some((o) =>
    o.capability === capability && o.status === "ok" && o.data && now - o.observedAt <= PRICE_MAX_AGE_MS &&
    (asset === undefined || o.args.asset === asset));
  const wanted = new Map<string, StrategyRead>();
  const want = (capability: string, asset?: string) => {
    if (fresh(capability, asset)) return;
    wanted.set(`${capability}:${asset ?? ""}`, { capability, args: asset ? { asset } : {} });
  };
  // The wallet read states every protocol token's decimals; every emitted amount is cut to them.
  if (plans.some((plan) => plan.legs.length)) want("wallet_balances");
  for (const plan of plans) {
    for (const leg of plan.legs) {
      want("asset_price", leg.asset);
      // A rate row pairs an asset's Earn market with its Blend reserve, so a Blend leg needs both.
      if (leg.op === "lend" || leg.op === "borrow" || leg.op === "supply_blend") want("earn_market", leg.asset);
      if (leg.op === "supply_blend") want("blend_markets");
      if (leg.sizing.kind === "all_idle") want("wallet_balances");
      // `all_position` draws on what the op spends: the Earn position, the posted collateral, the debt.
      if (leg.sizing.kind === "all_position" && leg.op === "redeem") want("earn_position", leg.asset);
      if (leg.sizing.kind === "all_position" && leg.op === "withdraw_collateral") want("account_collateral");
      // A repay is capped by what is owed whichever way it is sized, and a refusal must name the debt.
      if (leg.op === "repay") want("account_debt");
    }
  }
  return [...wanted.values()];
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
  requests: readonly StrategyRead[] = STRATEGY_READS,
  idPrefix = "p",
): Promise<Observation[]> {
  const prepared: Array<{ capability: string; args: Record<string, unknown>; read: ReturnType<typeof resolveRead> }> = [];
  for (const request of requests) {
    try {
      prepared.push({
        capability: request.capability, args: { ...request.args },
        read: resolveRead(request.capability, request.args, scope),
      });
    } catch { /* capability unavailable for this scope; skip rather than invent */ }
  }
  const observations: Observation[] = prepared.map((entry, offset) => ({
    id: `${idPrefix}${offset + 1}`, capability: entry.capability, args: entry.args, observedAt: now, status: "error",
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
