import type { InvestigationScope } from "../investigation/types";
import { assetForVenueSpelling, type Venue } from "../registry/assets";

/**
 * The write operations the copilot can compose, propose and execute. THE list — every
 * other mention (plan legs, literal actions, model schemas, the allowlist's tool map, the
 * prompt's vocabulary) is derived from it, so adding an op is one edit here plus the
 * `Record<WorkflowOp, …>` maps the compiler then demands.
 */
export const WORKFLOW_OPS = ["lend", "redeem", "deposit_collateral", "withdraw_collateral", "borrow", "repay", "supply_blend", "blend_withdraw", "swap", "remove_liquidity", "add_liquidity"] as const;
export type WorkflowOp = (typeof WORKFLOW_OPS)[number];

/**
 * The ops whose leg names a SECOND asset — `assetOut` — because `asset` alone does not
 * describe the whole leg: a swap changes to a different asset, add_liquidity spends a
 * paired token too. Every other op's `asset` is the entire leg. One list, so a leg
 * validator and a prompt schema cannot disagree about which ops may carry the field —
 * `decision.ts`'s structural parser dropped every add_liquidity plan outright (15 Sep,
 * live) because it still only allowed `assetOut`/`venue` on a leg named "swap".
 */
export const ASSET_OUT_OPS: readonly WorkflowOp[] = ["swap", "add_liquidity"];

/**
 * The places a step moves value between. `wallet` and `account` hold tokens; `earn`,
 * `blend` and `debt` are positions. Each is held by one key — the G-wallet signs for its
 * own tokens and its Earn vTokens; the smart account holds everything margin-side.
 */
export const POCKET_HOLDER = { wallet: "trader", earn: "trader", account: "smartAccount", blend: "smartAccount", lp: "smartAccount", debt: "smartAccount" } as const;
export type Pocket = keyof typeof POCKET_HOLDER;

/**
 * The pockets that hold a yield-bearing POSITION, as opposed to idle tokens (`wallet`),
 * collateral at rest (`account`) or borrowing capacity (`debt`).
 *
 * Stated as a property of the pocket model rather than a list of ops, so a new op needs
 * no change here — it declares where it moves value to, and that answers the question.
 * `OP_FLOW[op].rate` says whether that position's return can be READ; the two together
 * are what let the carry guard tell "this earns nothing" apart from "I cannot see what
 * this earns", which it previously could not.
 */
export const POSITION_POCKETS: readonly Pocket[] = ["earn", "blend", "lp"];

/** Does this op deploy value into a position, as opposed to moving or holding it? */
export function deploysIntoPosition(op: WorkflowOp): boolean {
  const { from, to } = OP_FLOW[op];
  return POSITION_POCKETS.includes(to) && !POSITION_POCKETS.includes(from);
}

/**
 * Which token a leg LEAVES BEHIND for a later leg to spend — not the one it spends.
 *
 * For every op but two, that is the leg's own `asset`. A swap is the exception that
 * broke the producer scan: its `asset` is the token going IN (`tokenIn: swapStep.asset`
 * below), and what it hands on is `assetOut`. A scan comparing `leg.asset` therefore
 * could not see a swap producing AQUSDC at all, and the leg after it was refused for
 * having no preceding leg in that asset when leg 1 produced exactly it (X5, 22 Sep).
 *
 * `add_liquidity` produces `null` deliberately, though it appears in `ASSET_OUT_OPS`
 * beside swap. That list answers "may this leg name a second asset", which is a
 * different question: an LP add CONSUMES both tokens and leaves an LP receipt, not a
 * token a later leg can spend. Blanket-applying `ASSET_OUT_OPS` here would make it
 * look like a producer of its paired token — the opposite of what it does.
 *
 * Each op says once what it produces, so a new op declares it here rather than in
 * whichever scan happens to need it.
 */
export function producedAsset(leg: { op: WorkflowOp; asset?: string | null; assetOut?: string | null }): string | null {
  if (leg.op === "add_liquidity") return null;
  if (leg.op === "swap") return leg.assetOut ?? null;
  return leg.asset ?? null;
}

export interface OpFlow {
  /**
   * The product whose write tool builds the step, and so which spelling of the asset it
   * takes. Not the DEX a swap routes through: a swap spends and receives margin-account
   * tokens, so it spells them the margin way and carries its `venue` on the leg.
   */
  venue: Venue;
  /** Where the tokens come from: the balance that caps the step. `debt` is borrowing capacity — nothing is spent. */
  from: Pocket;
  /** Where they land. `debt` means the debt shrinks; `earn` / `blend` mean a position grows. */
  to: Pocket;
  /** The read whose row states the whole of what the op draws on — what "all of it" and "a share of it" size from. */
  positionRead: "earn_position" | "account_collateral" | "account_debt" | "blend_position" | "farm_lp_position" | null;
  /**
   * How the margin account's health moves. `lowers` is what the user's floor guards;
   * `neutral` legs are not sizer legs. A Blend supply is neutral because the RiskEngine
   * values the b-token receipt at underlying × oracle price, exactly as the collateral it
   * replaced (Protocol_V1_Soroban RiskEngineContract/src/risk_engine.rs, `BlendUnderlying`).
   */
  health: "raises" | "lowers" | "neutral";
  /** The rate that labels the leg, from the rate rows; null for a leg that earns and costs nothing. */
  rate: "earn_supply" | "earn_borrow" | "blend_supply" | null;
}

/**
 * THE op-flow table. Where each op draws from, where it puts the tokens, what caps it and
 * how it moves health. The sizer (which sizing words fit an op, which leg may feed the
 * next), the reads a plan needs, the risk validator's funds flow and holders, the prompt's
 * venue list and the propose-time simulation all derive from these rows — one truth, so
 * the sizer and the validator cannot disagree about what a step does.
 */
/**
 * The most steps one approval may sign. The journal enforces it; the plan parser and sizer
 * read it from here, so no second, stricter limit can drift in (23 Sep, XS5: the parser capped
 * plans at 6 legs and silently dropped a legitimate 7-leg unwind).
 */
export const MAX_WORKFLOW_STEPS = 8;

export const OP_FLOW = Object.freeze({
  lend:                { venue: "earn",   from: "wallet",  to: "earn",    positionRead: null,                 health: "neutral", rate: "earn_supply" },
  redeem:              { venue: "earn",   from: "earn",    to: "wallet",  positionRead: "earn_position",      health: "neutral", rate: null },
  deposit_collateral:  { venue: "margin", from: "wallet",  to: "account", positionRead: null,                 health: "raises",  rate: null },
  withdraw_collateral: { venue: "margin", from: "account", to: "wallet",  positionRead: "account_collateral", health: "lowers",  rate: null },
  borrow:              { venue: "margin", from: "debt",    to: "account", positionRead: null,                 health: "lowers",  rate: "earn_borrow" },
  repay:               { venue: "margin", from: "account", to: "debt",    positionRead: "account_debt",       health: "raises",  rate: null },
  supply_blend:        { venue: "blend",  from: "account", to: "blend",   positionRead: null,                 health: "neutral", rate: "blend_supply" },
  /**
   * The way out of Blend: the b-token receipt burns and the underlying returns to the
   * margin account. Health-neutral in both directions — the RiskEngine already values the
   * receipt at underlying × oracle, so what comes back is worth what it replaced. No rate,
   * because the position stops earning.
   */
  blend_withdraw:      { venue: "blend",  from: "blend",   to: "account", positionRead: "blend_position",     health: "neutral", rate: null },
  /**
   * One margin-account token for another, through Soroswap or Aquarius. Both sides are
   * collateral the RiskEngine prices from the same oracle, so a swap is health-neutral up
   * to slippage — and it is refused outright when the token it buys is not accepted as
   * collateral, because that would quietly drop the account's backing.
   */
  swap:                { venue: "margin", from: "account", to: "account", positionRead: "account_collateral", health: "neutral", rate: null },
  /**
   * The way out of an LP position: the pool's shares burn and BOTH underlying tokens come
   * back to the margin account. Health-neutral — the RiskEngine values the LP receipt from
   * the same oracle prices as the tokens it returns (`LpAquarius` / `LpSoroswap`). Like a
   * swap it spells its tokens the margin way and takes the DEX from the pair, not the row.
   */
  remove_liquidity:    { venue: "margin", from: "lp",      to: "account", positionRead: "farm_lp_position",   health: "neutral", rate: null },
  /**
   * The way INTO an LP position, and remove_liquidity's exact mirror: both of the pool's
   * tokens leave the margin account and LP shares come back. Health-neutral for the same
   * reason the exit is — the RiskEngine prices the LP receipt from the same oracle feeds as
   * the tokens it replaces. Spends `account` because the tokens must already be in the
   * margin account (a wallet balance is deposited first, exactly as a swap requires).
   *
   * `positionRead` is null: nothing about the CURRENT position sizes an entry. What it
   * needs instead is the pool's live reserves, so the paired amount matches the ratio the
   * pool will actually mint against — a different read, requested by the sizer, not by the
   * op-flow table's position slot.
   */
  add_liquidity:       { venue: "margin", from: "account", to: "lp",      positionRead: null,                 health: "neutral", rate: null },
} as const satisfies Record<WorkflowOp, OpFlow>);

/** Ops whose every pocket is the G-wallet's: they never touch the margin account. */
export const WALLET_OPS: readonly WorkflowOp[] = WORKFLOW_OPS.filter((op) =>
  POCKET_HOLDER[OP_FLOW[op].from] === "trader" && POCKET_HOLDER[OP_FLOW[op].to] === "trader");
/** Ops the closed-form sizer projects: every one that moves the account's health. */
export type SizedOp = { [K in WorkflowOp]: (typeof OP_FLOW)[K]["health"] extends "neutral" ? never : K }[WorkflowOp];
export const SIZED_OPS: readonly SizedOp[] = WORKFLOW_OPS.filter((op): op is SizedOp => OP_FLOW[op].health !== "neutral");
/** The pockets that hold tokens a later leg can take as "what the previous leg produced". */
const TOKEN_POCKETS: readonly Pocket[] = ["wallet", "account"];
/**
 * Whether what `earlier` leaves behind is what `later` spends — the whole meaning of
 * `previous_leg`. Only tokens hand over: a position (Earn vTokens, a Blend receipt, a
 * shrunken debt) is not an amount the next tool is called with.
 */
export function feeds(earlier: WorkflowOp, later: WorkflowOp): boolean {
  const left = OP_FLOW[earlier].to;
  return TOKEN_POCKETS.includes(left) && left === OP_FLOW[later].from;
}
/**
 * Where a step's amount came from, which decides whether it may be re-derived later.
 *
 * `stated` — the amount WAS the instruction ("borrow 500 USDC"). If it no longer fits, the
 * honest response is to stop: shrinking 500 to 430 answers a different question.
 *
 * `derived_max_at_floor` — the amount came from a constraint ("borrow the max that keeps HF
 * at or above 1.3"). The figure was never the user's number, so executing a stale one is
 * LESS faithful than re-deriving it at broadcast time. Re-derivation is bounded by
 * `minAmountUsd`: without a floor on it the user's health-factor constraint would quietly
 * stop being a stop condition and become a slider, since some amount always fits.
 */
export type StepSizing =
  | { basis: "stated" }
  | { basis: "derived_max_at_floor"; minAmountUsd: string }
  /**
   * The amount was the WHOLE of a position when the plan was sized, not a figure the user
   * named. `read` is the capability that holds it, so the write can ask the same source again.
   *
   * A position denominated in receipt tokens grows on its own: a Blend bToken accrues
   * through its b-rate, posted collateral moves with the account. Freezing "all of it" as a
   * literal therefore goes stale with nobody touching anything, and the exit either leaves
   * dust behind or reverts on chain after it has been signed. Recording the intent is what
   * lets the write tell "876.38, the number they asked for" from "876.38, which was all of
   * it at the time".
   */
  | { basis: "whole_position"; read: string }
  /**
   * The amount is the pool-read estimate of what a removal pays in `asset`.
   * Execute replaces the sent amount with the measured account balance change
   * after `fromStep` settles. The proposal amount stays the approved estimate.
   */
  | { basis: "settled_payout"; fromStep: string; asset: string };

export interface ProposalStep {
  id: string;
  op: WorkflowOp;
  asset: string;
  amount: string;
  label: string;
  tool: string;
  args: Record<string, unknown>;
  /** Exact-output swap floor; never lower this when the pool moves. */
  targetOut?: string;
  /** Absent means `stated`: never re-derive an amount whose origin was not recorded. */
  sizing?: StepSizing;
}

export type ReviewFundingPocket = "wallet" | "earn" | "account";
export interface ReviewFundingMovement {
  pocket: ReviewFundingPocket;
  asset: string;
  amount: string;
}
export interface StepFundingPreview {
  spends: ReviewFundingMovement[];
  receives: ReviewFundingMovement[];
}

/**
 * Deterministic token movements shared by the approval card and the server's
 * authoritative funding check. Quoted swap/LP-exit outputs are deliberately
 * excluded because a later sealed step cannot safely spend them before execution.
 */
export function stepFundingPreview(step: ProposalStep): StepFundingPreview {
  const flow = OP_FLOW[step.op];
  const visible = (pocket: Pocket): pocket is ReviewFundingPocket =>
    pocket === "wallet" || pocket === "earn" || pocket === "account";
  const spends: ReviewFundingMovement[] = visible(flow.from)
    ? [{ pocket: flow.from, asset: step.asset, amount: step.amount }]
    : [];
  const receives: ReviewFundingMovement[] = [];

  if (step.op === "add_liquidity") {
    const wireAsset = String(step.args.token_b ?? "");
    const pairedAsset = assetForVenueSpelling("margin", wireAsset)?.id ?? wireAsset;
    const pairedAmount = step.args.amount_b;
    if (pairedAsset && (typeof pairedAmount === "string" || typeof pairedAmount === "number")) {
      spends.push({ pocket: "account", asset: pairedAsset, amount: String(pairedAmount) });
    }
  }

  if (step.op !== "redeem" && step.op !== "swap" && step.op !== "remove_liquidity" && visible(flow.to)) {
    receives.push({ pocket: flow.to, asset: step.asset, amount: step.amount });
  }
  return { spends, receives };
}

export interface WorkflowProposal {
  id: string;
  revision: number;
  digest: string;
  scope: InvestigationScope;
  server: string;
  createdAt: number;
  expiresAt: number;
  objective: string;
  messages: string[];
  assumptions: string[];
  constraints: string[];
  floor: string | null;
  /**
   * The user accepted a fill far below fair value, in their own words. Carried from the
   * sealed research so the decision survives to approval — the pre-write re-quote lowers
   * the floor to the live price for them instead of refusing a trade they agreed to.
   */
  slippageAccepted?: boolean;
  steps: ProposalStep[];
}
export type StepStatus = "pending" | "invoking" | "awaiting_signature" | "submitting" | "submitted" | "settled" | "failed" | "uncertain";
export interface WorkflowStepState {
  id: string;
  status: StepStatus;
  /**
   * What was actually sent, when re-derivation changed it. The proposal itself stays frozen
   * — its digest is what the user approved — so a deviation is recorded here beside it
   * rather than by editing the approved artifact.
   */
  executedAmountUsd?: string;
  /**
   * Margin-account balances read immediately before this removal was submitted,
   * keyed by registry id. Runtime state only: the approved proposal is not edited.
   */
  balancesBefore?: Record<string, string>;
  txHash?: string;
  unsignedXdr?: string;
  signedXdr?: string;
  message?: string;
  settledLedger?: number;
}
export interface WorkflowRecord {
  proposal: WorkflowProposal;
  status: "proposed" | "validating" | "approved" | "running" | "awaiting_signature" | "completed" | "blocked" | "cancelled" | "uncertain";
  approvedAt?: number;
  updatedAt: number;
  message: string;
  steps: WorkflowStepState[];
}
/** No tool arguments or signing authority may be supplied back by the browser. */
export interface WorkflowView {
  id: string;
  revision: number;
  digest: string;
  status: WorkflowRecord["status"];
  objective: string;
  expiresAt: number;
  assumptions: string[];
  constraints: string[];
  message: string;
  steps: Array<Pick<ProposalStep, "id" | "op" | "asset" | "amount" | "label" | "sizing"> &
    { funding?: StepFundingPreview } & WorkflowStepState>;
  /** Display-only swap terms. The server keeps the executable arguments in the proposal. */
  swap?: {
    tokenIn: string; tokenOut: string; venue: "aquarius" | "soroswap";
    amountIn: string; minOut: string; targetOut: string | null;
  };
  /**
   * The user accepted a fill far below fair value, in their own words, before this
   * proposal was even sealed (`WorkflowProposal.slippageAccepted`). The client reads
   * this to decide whether a swap may skip its manual "Confirm swap" click when auto
   * sign is on — never to change what gets signed, only who has to click.
   */
  slippageAccepted: boolean;
}
export function workflowView(record: WorkflowRecord): WorkflowView {
  const p = record.proposal;
  const swapStep = p.steps.find((step) => step.op === "swap") ?? null;
  const venue = swapStep?.args.venue;
  const tokenOut = swapStep?.args.token_out;
  const minOut = swapStep?.args.min_out;
  return { id: p.id, revision: p.revision, digest: p.digest, status: record.status, objective: p.objective,
    expiresAt: p.expiresAt, assumptions: p.assumptions, constraints: p.constraints, message: record.message,
    slippageAccepted: p.slippageAccepted === true,
    ...(swapStep && (venue === "aquarius" || venue === "soroswap") && typeof tokenOut === "string" && typeof minOut === "string"
      ? { swap: { tokenIn: swapStep.asset, tokenOut, venue, amountIn: swapStep.amount,
          minOut, targetOut: swapStep.targetOut ?? null } } : {}),
    steps: p.steps.map((step, index) => {
      const state = record.steps[index];
      return { id: step.id, op: step.op, asset: step.asset, amount: step.amount, label: step.label,
        sizing: step.sizing, funding: stepFundingPreview(step),
        status: state.status, txHash: state.txHash, unsignedXdr: state.unsignedXdr,
        message: state.message, settledLedger: state.settledLedger,
        executedAmountUsd: state.executedAmountUsd };
    }),
  };
}
