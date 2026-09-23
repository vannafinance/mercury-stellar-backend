/**
 * Live market + wallet reads used to rank strategy candidates.
 *
 * Shared by investigation seeding and by proposal rebuild when sealed evidence is stale.
 * AQUSDC and SOUSDC are Earn-only: they have pools, not Blend reserves.
 */

import type { MCPClient } from "../mcp-client";
import { allAssets, ASSET_SYMBOL_PATTERN, lpPairs, poolVenueFor } from "../registry/assets";
import { resolveRead } from "./capabilities";
import { interruptible, readFailureText } from "./runtime";
import { isRecord } from "./decision";
import { PRICE_MAX_AGE_MS } from "./candidates";
import type { InvestigationScope, Observation, ProposedPlan } from "./types";
import { ASSET_OUT_OPS, OP_FLOW } from "../workflow/types";

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
      // A swap is valued on both sides: the asset it spends AND the one it buys.
      if (leg.assetOut) want("asset_price", leg.assetOut);
      const flow = OP_FLOW[leg.op];
      // A leg that carries a rate needs its rate row: the Earn market, and the Blend reserves for a Blend rate.
      if (flow.rate !== null) want("earn_market", leg.asset);
      if (flow.rate === "blend_supply") want("blend_markets");
      const ofIdle = leg.sizing.kind === "all_idle" || (leg.sizing.kind === "fraction" && leg.sizing.of === "idle");
      const ofPosition = leg.sizing.kind === "all_position" || (leg.sizing.kind === "fraction" && leg.sizing.of === "position");
      if (ofIdle) want("wallet_balances");
      // Every declared position read is required for deterministic sizing, including literal
      // exits such as "withdraw 26000 XLM from Blend". The sizer checks literal amounts against
      // the source position too; skipping this read made valid Blend withdrawals look empty.
      // earn_position and farm_lp_position are read per asset — one pair or one pool per call,
      // not a shared table.
      if (flow.positionRead) {
        want(flow.positionRead, flow.positionRead === "earn_position" || flow.positionRead === "farm_lp_position" ? leg.asset : undefined);
      }
      // A repay is capped by what is owed whichever way it is sized, and a refusal must name the debt.
      if (flow.to === "debt" && flow.positionRead) want(flow.positionRead);
      /**
       * Anything that touches an Aquarius pool needs the pool's live reserves: entering it
       * sizes the paired amount against the real ratio (the model's own number is never
       * trusted for it), and a swap quotes its floor against the curve it actually settles
       * on rather than at oracle parity — the gap between the two is what the DEX refused
       * outright on 15 Sep. Soroswap needs no read to ENTER (its contract corrects an
       * imperfect ratio itself), but it does to SWAP: falling back to the oracle quote
       * there proposed "100 XLM for at least 17.4469985 SOUSDC" against a pool paying
       * 7.4921219 (16 Sep, live). Each venue is asked for its own pool's numbers.
       */
      const legVenue = leg.assetOut ? poolVenueFor(leg.asset, leg.assetOut) : null;
      if ((ASSET_OUT_OPS as readonly string[]).includes(leg.op) && leg.assetOut && legVenue) {
        want(
          legVenue === "soroswap" ? "soroswap_pool_reserves" : "aquarius_pool_reserves",
          leg.asset === "XLM" ? leg.assetOut : leg.asset,
        );
      }
      // Leaving an LP position is valued from the same pool read (plan.ts `lpExitUsd`): the
      // shares' slice of each reserve. Keyed off the op's source pocket, not a list of ops.
      if (flow.from === "lp") {
        const pools = lpPairs().filter(({ tokens }) => tokens.includes(leg.asset as never));
        if (pools.length === 1) want(pools[0].venue === "soroswap" ? "soroswap_pool_reserves" : "aquarius_pool_reserves", pools[0].tokens[1]);
      }
      // A lend is funded from the wallet; the account read is how a wrong-pocket
      // sibling becomes a withdraw-then-lend offer instead of a silent skip.
      if (leg.op === "lend") want("account_collateral");
      // A leg the account funds is checked against the account's balance, whatever its sizing word.
      if (flow.from === "account") want("account_collateral");
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
    const readTimeout = AbortSignal.timeout(15_000);
    try {
      const response = await interruptible(
        () => mcp.call(entry.read.tool, entry.read.args, scope.trader ?? undefined),
        AbortSignal.any([signal, readTimeout]),
      );
      if (!isRecord(response) || response.error || response.isError === true || response.ok === false) {
        observation.error = "MCP returned unavailable or failed data; do not use it as a financial fact.";
        return;
      }
      observation.data = response;
      observation.status = "ok";
    } catch (error) {
      observation.error = readFailureText(error, readTimeout.aborted && !signal.aborted);
    }
  }));
  return observations;
}
