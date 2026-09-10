import { resolveRead } from "./catalog";
import { researchCodec } from "./continuation";
import { compactResearchEvidence } from "./evidence";
import { normalizeResearchFacts } from "./normalize";
import { matchFastPath, parseWithdrawCheck, type FastPathMatch } from "./read-cache";
import type { InvestigationScope, Observation } from "./types";
import type { ResearchView } from "./view";
import { factualAnswer } from "./answer";
import type { AssetId } from "../registry/assets";

export { matchFastPath, parseWithdrawCheck, type FastPathMatch };

/**
 * Exact-match reads that skip the investigation loop.
 *
 * Not a second planner: these are cache hits for questions the page already knows how
 * to answer (health from the same snapshot as the Margin rail; a single oracle price;
 * a named withdraw eligibility check). Anything with a second write/plan clause falls
 * through. `routeMessage` uses the same matcher so it cannot override a researched plan
 * with a keyword write.
 */

function payloadFailed(data: Record<string, unknown>): boolean {
  return !!data.error || data.isError === true || data.ok === false || data.success === false ||
    data.available === false || ["error", "failed", "rejected", "unavailable"].includes(String(data.status));
}

function view(input: {
  message: string;
  scope: InvestigationScope;
  observations: Observation[];
  secret: string;
  server: string;
}): ResearchView {
  const { facts, warnings } = normalizeResearchFacts(input.observations);
  const reply = factualAnswer(facts) ?? "I could not read a live figure for that just now.";
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
    status: payloadFailed(data) ? "error" : "ok",
    data,
  };
}

export async function withdrawObservation(
  asset: AssetId,
  amount: string,
  scope: InvestigationScope,
  mcp: { call: (tool: string, args: Record<string, unknown>, userId?: string) => Promise<Record<string, unknown>> },
): Promise<Observation> {
  const read = resolveRead("can_withdraw", { asset, amount }, scope);
  const data = await mcp.call(read.tool, read.args, scope.trader ?? undefined);
  return {
    id: "e1",
    capability: "can_withdraw",
    args: { asset, amount },
    observedAt: Date.now(),
    status: payloadFailed(data) ? "error" : "ok",
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
