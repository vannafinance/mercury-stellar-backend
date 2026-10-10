import { allAssets, lpPairs, resolveAssetDef } from "../registry/assets";
import { MAX_WORKFLOW_STEPS, OP_FLOW, WORKFLOW_OPS, type WorkflowOp } from "../workflow/types";
import { decimalWad, ZERO } from "./fixed";
import { PRICE_MAX_AGE_MS } from "./candidates";
import { catalogEntry } from "./catalog";
import { POSITION_ROWS, isPositionRowRead, planCandidateId, positionRowIn, verbOf, type ResolvedPlans } from "./plan";
import { positionReadCapabilities } from "./position-coverage";
import type { GoalUnderstanding, Observation, ProposedPlan } from "./types";

export function requestsPortfolioExit(goal: GoalUnderstanding | undefined, messages: readonly string[]): boolean {
  const exit = goal?.portfolioExit;
  return goal?.intent === "strategy" && exit?.destination === "wallet" && !!exit.sourceQuote.trim()
    && messages.some(message => message.includes(exit.sourceQuote));
}

export interface ExitRequirement { op: WorkflowOp; asset: string }
export interface ExitCoverage { required: ExitRequirement[]; unread: string[] }

export function portfolioExitProblem(plan: ProposedPlan | undefined, coverage: ExitCoverage): string | null {
  const missing = coverage.required.filter(row => !plan?.legs.some(leg => leg.op === row.op
    && leg.asset === row.asset && leg.sizing.kind === "all_position"));
  if (coverage.unread.length) return `The full exit cannot be verified because these position reads are incomplete: ${coverage.unread.join(", ")}.`;
  if (coverage.required.length > MAX_WORKFLOW_STEPS) return `Closing all positions requires at least ${coverage.required.length} steps across your held positions, debt repayments and wallet withdrawals; one approval currently supports ${MAX_WORKFLOW_STEPS}. An Earn-only redemption would leave other positions open.`;
  return missing.length ? `This does not complete the requested exit. Missing whole-position steps: ${missing.map(row => `${verbOf(row.op)} ${row.asset}`).join(", ")}.` : null;
}

/** Inventory every declared source pocket. A failed/malformed read never means an empty position. */
export function portfolioExitCoverage(observations: readonly Observation[], now: number, basis?: { debtUsd: string } | null): ExitCoverage {
  const required: ExitRequirement[] = [], unread: string[] = [];
  const add = (op: WorkflowOp, asset: string) => {
    if (!required.some(row => row.op === op && row.asset === asset)) required.push({ op, asset });
  };
  for (const capability of positionReadCapabilities()) {
    const op = WORKFLOW_OPS.find(op => OP_FLOW[op].positionRead === capability && OP_FLOW[op].from !== OP_FLOW[op].to);
    if (!op) continue;
    const spec = catalogEntry(capability)?.modelArgs.asset;
    const assets = spec?.type === "enum" ? spec.values : allAssets().filter(asset => asset.marginSymbol).map(asset => asset.id);
    for (const asset of assets) {
      const read = [...observations].reverse().find(row => row.capability === capability
        && (spec?.type !== "enum" || row.args.asset === asset));
      const data = read?.data;
      if (!read || read.status !== "ok" || !data || now - read.observedAt > PRICE_MAX_AGE_MS
        || (Array.isArray(data.errors) && data.errors.length)) { unread.push(`${capability}:${asset}`); continue; }
      let amount: unknown;
      if (isPositionRowRead(capability)) {
        const keys = POSITION_ROWS[capability];
        const symbol = resolveAssetDef(asset)?.marginSymbol ?? asset;
        const rows = keys.flatMap(key => Array.isArray(data[key]) ? data[key] as Record<string, unknown>[] : []);
        const matched = rows.filter(row => row && (row.symbol === symbol || row.symbol === asset));
        const balance = positionRowIn(data, keys, symbol, asset);
        if (!keys.some(key => Array.isArray(data[key])) || matched.some(row => row.balance_untrusted === true)
          || (matched.length > 0 && balance === null)) { unread.push(`${capability}:${asset}`); continue; }
        amount = balance ?? "0";
      } else {
        amount = capability === "earn_position" ? data.human : data.lp_shares_human;
      }
      try {
        if (typeof amount !== "string" && typeof amount !== "number") throw new Error();
        const balance = decimalWad(String(amount));
        if (balance < ZERO) throw new Error();
        if (balance > ZERO) add(op, asset);
      } catch { unread.push(`${capability}:${asset}`); }
    }
  }
  // Position exits returning to margin need a subsequent wallet withdrawal, including
  // tokens absent from today's plain-collateral row but produced by the exit itself.
  const walletExit = WORKFLOW_OPS.find(op => OP_FLOW[op].from === "account" && OP_FLOW[op].to === "wallet");
  if (walletExit) for (const row of [...required]) {
    if (OP_FLOW[row.op].to !== "account") continue;
    const tokens = OP_FLOW[row.op].from === "lp"
      ? lpPairs().filter(pair => pair.tokens.includes(row.asset as never)).flatMap(pair => [...pair.tokens]) : [row.asset];
    for (const asset of tokens) add(walletExit, asset);
  }
  if (basis) {
    try {
      const hasDebt = required.some(row => OP_FLOW[row.op].to === "debt");
      if ((decimalWad(basis.debtUsd) > ZERO) !== hasDebt) unread.push("account_debt:inconsistent_with_contract");
    } catch { unread.push("account_debt:unverified_contract_basis"); }
  }
  return { required, unread: [...new Set(unread)] };
}

/** A partial option cannot satisfy a terminal goal; alternatives must each cover it. */
export function enforcePortfolioExit(resolved: ResolvedPlans, plans: readonly ProposedPlan[], coverage: ExitCoverage): ResolvedPlans {
  const rejected: ResolvedPlans["rejected"] = [...resolved.rejected];
  const candidates = resolved.candidates.filter(candidate => {
    const plan = plans.find(plan => planCandidateId(plan) === candidate.id);
    const reason = portfolioExitProblem(plan, coverage)
      ?? (coverage.required.some(row => OP_FLOW[row.op].to === "debt") && candidate.finalHealthFactor !== null
        ? "The prepared repayment amounts leave debt outstanding, so this plan cannot close all positions and release all collateral." : null);
    if (!reason) return true;
    rejected.push({ title: candidate.label, leg: null, reason,
      ...(!coverage.unread.length && coverage.required.length <= MAX_WORKFLOW_STEPS ? { repairable: true as const } : {}) });
    return false;
  });
  return { candidates, rejected };
}
