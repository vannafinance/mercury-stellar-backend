import { allAssets, resolveAsset, type AssetId } from "../registry/assets";
import { resolveRead } from "./catalog";
import { researchCodec } from "./continuation";
import { compactResearchEvidence } from "./evidence";
import { normalizeResearchFacts } from "./normalize";
import type { InvestigationScope, Observation } from "./types";
import type { ResearchView } from "./view";
import { formatHealthFactor } from "./answer";

/**
 * Exact-match reads that skip the investigation loop.
 *
 * Not a second planner: these are cache hits for questions the page already knows how
 * to answer (health from the same snapshot as the Margin rail; a single oracle price).
 * Anything with a write verb, a second clause, or an ambiguous USDC falls through.
 */

const WRITE_OR_PLAN =
  /\b(swap|lend|borrow|deposit|repay|farm|invest|supply|withdraw|redeem|allocate|park|deploy|strategy|rebalance|then|and also|if\b|unless|whenever|monitor|watch my|every day)\b/i;

const HEALTH_ASK =
  /^(?:hey[, ]+|hi[, ]+|hello[, ]+)?(?:what(?:'s| is)|whats|show(?: me)?|tell me|how(?:'s| is)|check)\s+(?:my\s+)?(?:health(?:\s+factor)?|hf)\b|\bam i (?:safe|at risk|close to liquidation)\b|\b(?:my )?health factor\b\??$/i;

const PRICE_ASK =
  /\b(?:price|oracle|worth|trading at|value)\b/i;

function onlyAsset(text: string): AssetId | null {
  const named = allAssets().filter((asset) => {
    const re = new RegExp(`(?:^|[^A-Z0-9])${asset.id}(?:[^A-Z0-9]|$)`, "i");
    return re.test(text) || asset.aliases.some((alias) => {
      if (/\s/.test(alias)) return false;
      return new RegExp(`(?:^|[^A-Z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^A-Z0-9]|$)`, "i").test(text);
    });
  });
  if (named.length !== 1) return null;
  const match = resolveAsset(named[0].id);
  return match.kind === "asset" ? match.def.id : null;
}

export type FastPathMatch =
  | { kind: "health" }
  | { kind: "price"; asset: AssetId };

export function matchFastPath(message: string): FastPathMatch | null {
  const text = message.trim();
  if (!text || text.length > 120 || WRITE_OR_PLAN.test(text)) return null;
  const compact = text.toLowerCase().replace(/\s+/g, " ");
  if (HEALTH_ASK.test(compact) && !PRICE_ASK.test(compact)) return { kind: "health" };
  if (PRICE_ASK.test(compact)) {
    const asset = onlyAsset(text);
    if (asset) return { kind: "price", asset };
  }
  return null;
}

function view(input: {
  message: string;
  scope: InvestigationScope;
  observations: Observation[];
  secret: string;
  server: string;
}): ResearchView {
  const { facts, warnings } = normalizeResearchFacts(input.observations);
  const health = facts.find((fact) => fact.venue === "margin" && fact.unit === "HF");
  const price = facts.find((fact) => fact.venue === "oracle");
  const reply = health
    ? `Your reported health factor is ${formatHealthFactor(health.value)}.`
    : price
      ? `${price.label}: $${price.value}.`
      : "I could not read a live figure for that just now.";
  const evidence = compactResearchEvidence(input.observations, null, Date.now());
  evidence.allowedCandidateIds = [];
  return {
    status: facts.length ? "researched" : "incomplete",
    message: reply,
    originalRequest: input.message,
    refinements: [],
    understanding: {
      intent: "answer",
      objective: input.message,
      constraints: [],
      borrowing: "unspecified",
    },
    question: null,
    facts,
    capacity: null,
    candidates: null,
    rateComparisons: [],
    checks: input.observations.map((observation) => ({
      id: observation.id,
      label: observation.capability.replaceAll("_", " "),
      status: observation.status,
      readAt: observation.observedAt,
    })),
    warnings: facts.length ? warnings : [...warnings, "This was a fast read; no strategy was sized."],
    scope: { wallet: input.scope.trader, smartAccount: input.scope.smartAccount, network: input.scope.network },
    continuation: researchCodec(input.secret, input.server).seal(input.scope, [input.message], null, evidence),
    executionAllowed: false,
  };
}

export function healthObservations(position: {
  grossCollateralUsd: string;
  debtUsd: string;
  healthFactor: string | null;
}): Observation[] {
  return [{
    id: "e0",
    capability: "account_position",
    args: {},
    observedAt: Date.now(),
    status: "ok",
    data: {
      collateral_usd: position.grossCollateralUsd,
      debt_usd: position.debtUsd,
      ...(position.healthFactor ? { health_factor: position.healthFactor } : {}),
      source: "vanna_app_margin_snapshot",
    },
  }];
}

export async function priceObservation(
  asset: AssetId,
  scope: InvestigationScope,
  mcp: { call: (tool: string, args: Record<string, unknown>, userId?: string) => Promise<Record<string, unknown>> },
): Promise<Observation> {
  const read = resolveRead("asset_price", { asset }, scope);
  const data = await mcp.call(read.tool, read.args, scope.trader ?? undefined);
  return {
    id: "e1",
    capability: "asset_price",
    args: { asset },
    observedAt: Date.now(),
    status: data.error || data.available === false ? "error" : "ok",
    data,
  };
}

export function fastPathView(input: {
  message: string;
  scope: InvestigationScope;
  observations: Observation[];
  secret: string;
  server: string;
}): ResearchView {
  return view(input);
}
