/**
 * Turn a ranked candidate into journal steps the user can approve.
 *
 * The candidate's `legs` are the health-factor-moving operations only. Supplying borrowed
 * proceeds into Blend is health-factor neutral, so `borrow_supply` has one borrow leg
 * and `supply_idle` has none — the Blend supply the label promises is added here. Mapping
 * `legs` alone would borrow and never supply.
 *
 * Which steps a shape implies is read from the kind's traits (`candidate-id.ts`), never
 * from the id string: a new kind registered there compiles by what it funds from and
 * where it supplies to, without a prefix check here learning its name.
 *
 * Amounts are display token strings, converted from USD with the oracle price read in this
 * same investigation. No fallback, no $1 peg, and rounding is down so a step cannot ask
 * for more than the account can fund.
 */

import { decimalWad, formatWad, mulDown, WAD, ZERO } from "./fixed";
import { freshPrices } from "./candidates";
import type { Candidate } from "./candidates";
import { candidateKindTraits } from "./candidate-id";
import type { Observation, InvestigationScope } from "./types";
import type { SizedLeg } from "./sizing";
import type { ProposalStep, StepSizing, WorkflowOp } from "../workflow/types";
import { resolveAssetDef } from "../registry/assets";

export type CompileReason =
  | "missing_price" | "stale_price" | "unpriceable_amount"
  | "unsupported_venue" | "unsupported_op" | "zero_amount";

export type CompileResult =
  | { ok: true; steps: ProposalStep[] }
  | { ok: false; reason: CompileReason };

/**
 * Interim product decision: a floor-derived step may re-size down by up to 5% and
 * still be the same instruction ("max at the floor"). More than that is a different
 * position. Written onto the step so the approval card shows the range; change this
 * constant rather than scattering a second fraction.
 */
export const DERIVED_MIN_AMOUNT_RATIO = "0.95";

const POSITIVE_DECIMAL = /^\d+(\.\d+)?$/;

const OP_RANK: Record<WorkflowOp, number> = {
  redeem: 0,
  deposit_collateral: 1,
  repay: 2,
  borrow: 3,
  lend: 4,
  supply_blend: 5,
  withdraw_collateral: 6,
  // Leaving Blend frees tokens the later legs may use, so it ranks with the other exits.
  blend_withdraw: 0,
  // A swap converts what the account already holds, before anything is put to work with it.
  swap: 1,
};

export function compileProposal(input: {
  candidate: Candidate;
  scope: InvestigationScope;
  observations: readonly Observation[];
  floor: string | null;
  now: number;
}): CompileResult {
  /**
   * A composed plan was sized and allowlisted in `plan.ts`; its steps are the proposal.
   * Prices are re-checked here because propose may be compiling seconds later.
   */
  if (input.candidate.kind === "composed") {
    if (!input.candidate.steps?.length) return { ok: false, reason: "unsupported_op" };
    for (const asset of new Set(input.candidate.steps.map((step) => step.asset))) {
      const priced = priceFor(asset, input.observations, input.now);
      if (!priced.ok) return priced;
    }
    return { ok: true, steps: input.candidate.steps.map((step) => ({ ...step })) };
  }
  if (input.candidate.venue === "earn") return compileEarn(input);
  if (input.candidate.venue !== "blend") {
    return { ok: false, reason: "unsupported_venue" };
  }
  if (input.candidate.legs.some((leg) => leg.op === "withdraw_collateral")) {
    return { ok: false, reason: "unsupported_op" };
  }

  const priced = priceFor(input.candidate.asset, input.observations, input.now);
  if (!priced.ok) return priced;

  const sizing = stepSizing(input.candidate, input.floor);
  const steps: ProposalStep[] = [];

  for (const [index, leg] of input.candidate.legs.entries()) {
    const mapped = compileLeg(input, leg, priced.price, sizing, index);
    if (!mapped.ok) return mapped;
    steps.push(mapped.step);
  }

  if (impliesBlendSupply(input.candidate)) {
    const usd = supplyUsd(input.candidate);
    const amount = tokensFromUsd(usd, priced.price);
    if (!amount.ok) return amount;
    // Wallet-funded Blend supply has to move the tokens into margin first; borrowed
    // proceeds are already in the C-address.
    if (candidateKindTraits(input.candidate.kind).funding === "wallet") {
      steps.push({ id: "s0-deposit_collateral", op: "deposit_collateral", asset: input.candidate.asset,
        amount: amount.tokens, label: `Deposit ${amount.tokens} ${input.candidate.asset} from wallet into margin`,
        tool: "vanna_deposit_collateral", args: writeArgs(input.scope, wireSymbol(input.candidate.asset), amount.tokens), sizing });
    }
    steps.push(blendSupplyStep(input, amount.tokens, sizing, steps.length));
  }

  if (!steps.length) return { ok: false, reason: "unsupported_op" };
  steps.sort((a, b) => OP_RANK[a.op] - OP_RANK[b.op] || a.id.localeCompare(b.id));
  return { ok: true, steps };
}

function compileEarn(input: {
  candidate: Candidate;
  scope: InvestigationScope;
  observations: readonly Observation[];
  floor: string | null;
  now: number;
}): CompileResult {
  // Idle Earn only. Borrow-to-Earn would move C-address proceeds to the G-wallet.
  const traits = candidateKindTraits(input.candidate.kind);
  if (input.candidate.borrows || input.candidate.legs.length || traits.venue !== "earn" || traits.funding !== "wallet") {
    return { ok: false, reason: "unsupported_op" };
  }
  const priced = priceFor(input.candidate.asset, input.observations, input.now);
  if (!priced.ok) return priced;
  const amount = tokensFromUsd(input.candidate.amountUsd, priced.price);
  if (!amount.ok) return amount;
  const symbol = resolveAssetDef(input.candidate.asset)?.earnSymbol;
  if (!symbol) return { ok: false, reason: "unsupported_venue" };
  const label = resolveAssetDef(input.candidate.asset)?.displayLabel ?? input.candidate.asset;
  return {
    ok: true,
    steps: [{
      id: "s0-lend",
      op: "lend",
      asset: input.candidate.asset,
      amount: amount.tokens,
      label: `Lend ${amount.tokens} ${label} to Earn`,
      tool: "vanna_lend",
      args: { symbol, amount: amount.tokens, lender: input.scope.trader },
      sizing: stepSizing(input.candidate, input.floor),
    }],
  };
}

function impliesBlendSupply(candidate: Candidate): boolean {
  return candidateKindTraits(candidate.kind).venue === "blend";
}

function supplyUsd(candidate: Candidate): string {
  const borrowed = candidate.legs.find((leg) => leg.op === "borrow");
  return borrowed?.amountUsd ?? candidate.amountUsd;
}

function stepSizing(candidate: Candidate, floor: string | null): StepSizing {
  // Freeze token units for every approved step. A USD resize cannot be substituted
  // into token-denominated arguments, including for floor-derived proposals.
  void candidate; void floor;
  return { basis: "stated" };
}

function minAmountUsd(amountUsd: string): string {
  return formatWad(mulDown(decimalWad(amountUsd), decimalWad(DERIVED_MIN_AMOUNT_RATIO), WAD));
}

function compileLeg(
  input: { candidate: Candidate; scope: InvestigationScope },
  leg: SizedLeg,
  price: bigint,
  sizing: StepSizing,
  index: number,
): { ok: true; step: ProposalStep } | { ok: false; reason: CompileReason } {
  if (leg.op === "withdraw_collateral") return { ok: false, reason: "unsupported_op" };
  const amount = tokensFromUsd(leg.amountUsd, price);
  if (!amount.ok) return amount;
  const mapped = marginOp(leg.op);
  if (!mapped) return { ok: false, reason: "unsupported_op" };
  const symbol = wireSymbol(input.candidate.asset);
  return {
    ok: true,
    step: {
      id: `s${index}-${mapped.op}`,
      op: mapped.op,
      asset: input.candidate.asset,
      amount: amount.tokens,
      label: leg.label,
      tool: mapped.tool,
      args: writeArgs(input.scope, symbol, amount.tokens),
      sizing,
    },
  };
}

function marginOp(op: SizedLeg["op"]): { op: WorkflowOp; tool: string } | null {
  switch (op) {
    case "deposit_collateral": return { op: "deposit_collateral", tool: "vanna_deposit_collateral" };
    case "borrow": return { op: "borrow", tool: "vanna_borrow" };
    case "repay": return { op: "repay", tool: "vanna_repay" };
    default: return null;
  }
}

function blendSupplyStep(
  input: { candidate: Candidate; scope: InvestigationScope },
  amount: string,
  sizing: StepSizing,
  index: number,
): ProposalStep {
  const def = resolveAssetDef(input.candidate.asset);
  // Blend's own symbol: BLUSDC is USDC on the wire, never AQUSDC.
  const blendSym = def?.blendReserve ? (def.marginSymbol ?? def.id) : input.candidate.asset;
  const label = def?.displayLabel ?? input.candidate.asset;
  return {
    id: `s${index}-supply_blend`,
    op: "supply_blend",
    asset: input.candidate.asset,
    amount,
    label: `Supply ${amount} ${label} to Blend`,
    tool: "vanna_blend_supply",
    args: writeArgs(input.scope, blendSym, amount),
    sizing,
  };
}

export function writeArgs(scope: InvestigationScope, symbol: string, amount: string): Record<string, unknown> {
  return { smart_account: scope.smartAccount, symbol, amount, trader: scope.trader };
}

/** The symbol the margin contract and Blend pool want — BLUSDC is USDC on the wire. */
export function wireSymbol(asset: string): string {
  return resolveAssetDef(asset)?.marginSymbol ?? asset;
}

export function tokensFromUsd(
  usd: string,
  price: bigint,
  decimals = 6,
): { ok: true; tokens: string } | { ok: false; reason: "unpriceable_amount" | "zero_amount" } {
  let tokens: bigint;
  try {
    tokens = mulDown(decimalWad(usd), WAD, price);
    // Cut to the token's precision when the caller read it; the fixed shapes' legacy
    // default of six places is re-checked by the live risk validator before any write.
    const quantum = BigInt(10) ** BigInt(18 - Math.min(18, Math.max(0, decimals)));
    tokens = tokens / quantum * quantum;
  } catch {
    return { ok: false, reason: "unpriceable_amount" };
  }
  if (tokens <= ZERO) return { ok: false, reason: "zero_amount" };
  const formatted = formatWad(tokens);
  if (!POSITIVE_DECIMAL.test(formatted) || Number(formatted) <= 0) {
    return { ok: false, reason: "zero_amount" };
  }
  return { ok: true, tokens: formatted };
}

export function priceFor(
  asset: string,
  observations: readonly Observation[],
  now: number,
): { ok: true; price: bigint } | { ok: false; reason: "missing_price" | "stale_price" } {
  const fresh = freshPrices(observations, now).get(asset);
  if (fresh && fresh > ZERO) return { ok: true, price: fresh };
  const anyValid = observations.some((observation) => {
    if (observation.capability !== "asset_price" || observation.status !== "ok") return false;
    if (String(observation.args.asset ?? "") !== asset) return false;
    try {
      const raw = observation.data?.price_usd;
      const price = decimalWad(typeof raw === "number" ? String(raw) : String(raw ?? ""));
      return price > ZERO;
    } catch {
      return false;
    }
  });
  return { ok: false, reason: anyValid ? "stale_price" : "missing_price" };
}
