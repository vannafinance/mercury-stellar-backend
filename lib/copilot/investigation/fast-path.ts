import { resolveRead } from "./catalog";
import { researchCodec } from "./continuation";
import { compactResearchEvidence } from "./evidence";
import { normalizeResearchFacts } from "./normalize";
import { matchFastPath, parseWithdrawCheck, type FastPathMatch } from "./read-cache";
import { interruptible } from "./runtime";
import type { InvestigationScope, Observation } from "./types";
import type { ResearchView } from "./view";
import { factualAnswer } from "./answer";
import type { AssetId } from "../registry/assets";
import { WAD } from "./fixed";
import { PAGE_BASIS_SOURCE } from "./health-basis";
import { allAssets } from "../registry/assets";
import type { ReplyBlock, ReplySegment } from "./view";

export { matchFastPath, parseWithdrawCheck, type FastPathMatch };

/**
 * Exact-match reads that skip the investigation loop.
 *
 * Not a second planner: these are cache hits for questions the page already knows how
 * to answer (health from RiskEngine `liquidation_snapshot`; a single oracle price;
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
  /** A reply the code composed itself (a table, say), used instead of the one-sentence factual answer. */
  reply?: { message: string; blocks: ReplyBlock[] };
}): ResearchView {
  const { facts, warnings } = normalizeResearchFacts(input.observations);
  const healthFailedNoAccount = !input.scope.smartAccount && input.observations.some(
    (o) => o.capability === "liquidation_snapshot" && o.status === "error" && o.error === "no_account"
  );
  const reply = input.reply?.message ?? (healthFailedNoAccount
    ? "A margin account is needed to check your health factor and none is connected."
    : factualAnswer(facts) ?? "I could not read a live figure for that just now.");
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
    candidates: healthFailedNoAccount
      ? {
          feasible: [],
          rejected: [
            {
              label: "Check health factor",
              reason: "Check health factor: a margin account is needed for this step and none is connected.",
              asset: "margin",
              accountRequired: { code: "accountRequired", actions: ["Check health factor"] },
            },
          ],
        }
      : null,
    rateComparisons: [],
    checks: input.observations.map((observation) => ({
      id: observation.id,
      label: observation.capability.replaceAll("_", " "),
      status: observation.status,
      readAt: observation.observedAt,
    })),
    // Failed reads are already represented by the response state, its message,
    // and observation diagnostics. Do not append internal pipeline commentary
    // as a second user-facing warning list. Partial successful reads retain
    // their material warnings.
    warnings: facts.length ? warnings : [],
    scope: { wallet: input.scope.trader, smartAccount: input.scope.smartAccount, network: input.scope.network },
    continuation: researchCodec(input.secret, input.server).seal(input.scope, [input.message], null, evidence),
    executionAllowed: false,
    ...(input.reply ? { replyBlocks: input.reply.blocks } : {}),
    ...(healthFailedNoAccount ? {
      choices: [
        { id: "create_account", label: "Open a margin account", write: "create_account" as const },
      ],
    } : {}),
  };
}

/**
 * The Margin page's Net Leverage Taken: holdings over equity (holdings minus debt), 1x with no debt
 * (`lib/account-model.ts`). Equity wiped out is infinity on the page, which is not a figure to
 * quote, so it is left out rather than shown as a negative or an invented cap.
 */
function netLeverage(grossCollateralUsd: string, debtUsd: string): string | null {
  const gross = Number(grossCollateralUsd);
  const debt = Number(debtUsd);
  if (!Number.isFinite(gross) || !Number.isFinite(debt) || gross < 0 || debt < 0) return null;
  if (debt <= 1e-9) return "1";
  const equity = gross - debt;
  return equity > 0 ? (gross / equity).toFixed(4) : null;
}

export function healthObservations(position: {
  grossCollateralUsd: string;
  debtUsd: string;
  healthFactor: string | null;
}): Observation[] {
  const leverage = netLeverage(position.grossCollateralUsd, position.debtUsd);
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
      ...(leverage ? { net_leverage: leverage } : {}),
      source: PAGE_BASIS_SOURCE,
    },
  }];
}

/** Posted-collateral ratio from one RiskEngine tuple. Not a mix of app and contract figures. */
export function postedHealthFactorFromSnapshot(data: Record<string, unknown>): string | null {
  const wadC = typeof data.collateral_usd_wad === "string" ? data.collateral_usd_wad : "";
  const wadD = typeof data.debt_usd_wad === "string" ? data.debt_usd_wad : "";
  if (/^\d+$/.test(wadC) && /^\d+$/.test(wadD)) {
    const debt = BigInt(wadD);
    if (debt === BigInt(0)) return null;
    const ratio = BigInt(wadC) * WAD / debt;
    const whole = ratio / WAD;
    const frac = (ratio % WAD).toString().padStart(18, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : `${whole}`;
  }
  const collateral = Number(data.collateral_usd);
  const debt = Number(data.debt_usd);
  if (!Number.isFinite(collateral) || !Number.isFinite(debt) || collateral < 0 || debt <= 0) return null;
  return String(collateral / debt);
}

function withPostedRatio(observation: Observation, extra: Record<string, unknown> = {}): Observation {
  if (observation.status !== "ok" || !observation.data) return observation;
  const posted = postedHealthFactorFromSnapshot(observation.data);
  return posted
    ? { ...observation, data: { ...observation.data, posted_health_factor: posted, ...extra } }
    : { ...observation, data: { ...observation.data, ...extra } };
}

/**
 * Same bands as sizing drift (`capacity.ts`). Unposted collateral changes the ratio;
 * a dropped borrow leg changes *debt*. Only a debt mismatch means the page figure is
 * unsafe to quote as health.
 */
export function pageDebtAgreesWithContract(pageDebtUsd: number, contractDebtUsd: number): boolean {
  if (!Number.isFinite(pageDebtUsd) || !Number.isFinite(contractDebtUsd)) return false;
  const diff = Math.abs(pageDebtUsd - contractDebtUsd);
  const scale = Math.max(Math.abs(pageDebtUsd), Math.abs(contractDebtUsd), 1);
  return diff <= Math.max(0.5, 0.005 * scale);
}

export async function liquidationSnapshotObservation(
  scope: InvestigationScope,
  mcp: { call: (tool: string, args: Record<string, unknown>, userId?: string) => Promise<Record<string, unknown>> },
): Promise<Observation> {
  const read = resolveRead("liquidation_snapshot", {}, scope);
  const data = await mcp.call(read.tool, read.args, scope.trader ?? undefined);
  return withPostedRatio({
    id: "e0",
    capability: "liquidation_snapshot",
    args: {},
    observedAt: Date.now(),
    status: payloadFailed(data) ? "error" : "ok",
    data,
  });
}

/**
 * Display matches the Margin page when that figure is safe to quote. The contract
 * read is the cancellable source that must never hang the turn.
 *
 * Debt that agrees → one website number (unposted collateral is a definition, not a
 * bug). Debt that disagrees → refuse the panel number and quote the risk engine.
 * A dial that flashes a huge figure then settles (live: 25.50 → 3.89) is hydration
 * lag on GET /api/account, not this mismatch.
 */
export async function readHealthFastPath(input: {
  scope: InvestigationScope;
  mcp: { call: (tool: string, args: Record<string, unknown>, userId?: string) => Promise<Record<string, unknown>> };
  signal: AbortSignal;
  budgetMs: number;
  snapshotFallback: () => Promise<{
    grossCollateralUsd: string;
    debtUsd: string;
    healthFactor: string | null;
  } | null>;
}): Promise<Observation[]> {
  if (!input.scope.smartAccount) {
    return [{
      id: "e0",
      capability: "liquidation_snapshot",
      args: {},
      observedAt: Date.now(),
      status: "error",
      error: "no_account",
    }];
  }
  const budget = () => AbortSignal.any([input.signal, AbortSignal.timeout(input.budgetMs)]);
  const contractTask = interruptible(
    () => liquidationSnapshotObservation(input.scope, input.mcp),
    budget(),
  ).then((observation) => observation, (error) => {
    console.warn("[copilot] investigation health contract read failed", {
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
    return null;
  });
  const pageTask = interruptible(() => input.snapshotFallback(), budget()).then((position) => position, (error) => {
    console.warn("[copilot] investigation health snapshot fallback failed", {
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
    return null;
  });
  const [contract, page] = await Promise.all([contractTask, pageTask]);
  const contractOk = contract?.status === "ok" && contract.data ? contract : null;
  const contractDebt = contractOk ? Number(contractOk.data?.debt_usd) : Number.NaN;
  const pageDebt = page ? Number(page.debtUsd) : Number.NaN;
  if (
    contractOk && page && pageDebtAgreesWithContract(pageDebt, contractDebt)
  ) {
    return healthObservations(page);
  }
  if (
    contractOk && page && Number.isFinite(contractDebt) && Number.isFinite(pageDebt)
    && !pageDebtAgreesWithContract(pageDebt, contractDebt)
  ) {
    return [withPostedRatio(contractOk, {
      page_debt_mismatch: true,
      ...(page.healthFactor ? { page_health_factor: page.healthFactor } : {}),
    })];
  }
  if (contractOk) return [withPostedRatio(contractOk)];
  if (page) return healthObservations(page);
  return [{
    id: "e0",
    capability: "liquidation_snapshot",
    args: {},
    observedAt: Date.now(),
    status: "error",
    error: "health_unavailable",
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

// ── "How much can I borrow?" ─────────────────────────────────────────────────

/** Plain words for what bounds a borrow: the MCP's own `limiting_factor`, never a number. */
const LIMITED_BY: Record<string, string> = {
  collateral_health: "your collateral",
  pool_liquidity: "pool liquidity",
  pool_utilization_cap: "pool capacity",
};

/**
 * The most of each margin asset the account can borrow now. The reads are the ones the investigation would make (`max_borrow` per asset);
 * asked in the same instant they travel as one MCP call (max-borrow-batch.ts). An asset whose read fails is left out, never guessed.
 */
export async function readCapacityFastPath(input: {
  scope: InvestigationScope;
  mcp: { call: (tool: string, args: Record<string, unknown>, userId?: string) => Promise<Record<string, unknown>> };
  signal: AbortSignal;
  budgetMs: number;
}): Promise<Observation[]> {
  if (!input.scope.smartAccount) return [];
  const budget = AbortSignal.any([input.signal, AbortSignal.timeout(input.budgetMs)]);
  const assets = allAssets().filter((asset) => asset.marginSymbol).map((asset) => asset.id);
  return Promise.all(assets.map(async (asset, index): Promise<Observation> => {
    const base = { id: `e${index}`, capability: "max_borrow", args: { asset }, observedAt: Date.now() };
    try {
      const read = resolveRead("max_borrow", { asset }, input.scope);
      const data = await interruptible(() => input.mcp.call(read.tool, read.args, input.scope.trader ?? undefined), budget);
      return { ...base, status: payloadFailed(data) ? "error" : "ok", data };
    } catch (error) {
      console.warn("[copilot] capacity fast-path read failed", { asset, error: error instanceof Error ? error.name : "unknown" });
      return { ...base, status: "error", error: "read_failed" };
    }
  }));
}

const text = (value: string): ReplySegment => ({ text: value });
const tokens = (value: string): string => {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 2 : 6 });
};

/** The reply: one sentence, a table of the figures (an amount per asset and what bounds it), and a plain caution. */
export function capacityView(input: {
  message: string;
  scope: InvestigationScope;
  observations: Observation[];
  secret: string;
  server: string;
}): ResearchView {
  const rows = input.observations
    .filter((o) => o.status === "ok" && typeof o.data?.max_borrow_human === "string")
    .map((o) => ({
      asset: String(o.args.asset ?? o.data?.symbol ?? ""),
      amount: tokens(String(o.data!.max_borrow_human)),
      limit: LIMITED_BY[String(o.data!.limiting_factor ?? "")] ?? "",
    }))
    .filter((row) => row.asset);
  const lead = "Here is the most you can borrow of each asset right now.";
  const caution = "These are the protocol's limits: borrowing the full amount would leave very little room before liquidation.";
  const blocks: ReplyBlock[] = [
    { type: "paragraph", segments: [text(lead)] },
    {
      type: "table",
      columns: [[text("Asset")], [text("You can borrow")], [text("Limited by")]],
      rows: rows.map((row) => [[text(row.asset)], [text(`${row.amount} ${row.asset}`)], [text(row.limit || "-")]]),
    },
    { type: "paragraph", segments: [text(caution)] },
  ];
  const plain = `${lead} ${rows.map((row) => `${row.asset} ${row.amount}`).join(", ")}. ${caution}`;
  return view({ ...input, reply: { message: plain, blocks } });
}
