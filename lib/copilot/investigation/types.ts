/** Server-side research contracts. None of these types authorize execution. */
export interface InvestigationScope {
  /** Authenticated subject, never a model-generated or browser-asserted identity. */
  subject: string;
  /** Caller must resolve and verify this wallet/account relationship server-side. */
  trader: string | null;
  smartAccount: string | null;
  network: string;
  /**
   * Set when identity could not be verified this turn. Never a confirmed negative
   * (an empty bindings list is not proof the wallet is unlinked).
   * `session` = the page sent a G-address but this request was not signed in.
   * `claimed` = signed in with no binding yet, so `trader` is the address the browser
   * asserted rather than one the account proved. A plan may still be prepared for it —
   * that wallet's own key has to sign the XDR — but nothing may treat it as proof of
   * ownership, and it is never cached for the next request.
   */
  unverified?: "bindings" | "session" | "claimed";
}

export interface InvestigationRequest {
  message: string;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  scope: InvestigationScope;
  /** Authenticated continuation: preserve whole user instructions, not a truncated transcript. */
  task?: { messages: string[]; lastQuestion: string | null };
  /**
   * Evidence the SERVER already holds, presented to the model as observations it need not
   * read. Not a shortcut: it is the same authoritative snapshot the Margin page renders, so
   * asking MCP for it again spends turns and time to obtain a number the app already has —
   * and when that MCP read came back without a scalar ratio, the card reported the health
   * factor as unavailable next to a rail showing it.
   */
  seed?: readonly Observation[];
  /** Named eval fixture for traces. Never the user message. */
  promptName?: string;
}

import type { WorkflowOp } from "../workflow/types";

export interface GoalUnderstanding {
  intent?: "answer" | "strategy";
  relation?: "new" | "refine";
  actions?: StatedAction[];
  /**
   * A lifecycle write — not a sized plan. Opening a margin account is one of these:
   * it has no token amount and runs for the connected G-wallet.
   */
  write?: { op: import("../workflow/lifecycle").LifecycleWriteOp; sourceQuote: string };
  objective: string;
  constraints: string[];
  borrowing: "unspecified" | "allowed" | "required" | "forbidden";
  /**
   * The health-factor floor the user stated, as their exact number with the substring
   * of their message that contains it. Understanding which sentence states a floor is
   * the model's job ("HF stays above 1.3", "never let health dip under 1.25"); the
   * number is verified against the user's own words in code and never invented. Absent
   * when no number was stated — "avoid liquidation" is not a floor.
   */
  healthFactorFloor?: { value: string; sourceQuote: string };
  /**
   * Amounts the user said to leave in the wallet ("keep 100 XLM liquid"), each with the
   * substring of their message that states it. Same contract as the floor: the model finds
   * the sentence, code checks the user really wrote it, and the sizer never spends into it.
   * 23 Sep, XS7: the constraint was in the conversation and an all-idle XLM leg spent all
   * 2152 XLM, because nothing structured carried it to the sizer.
   */
  walletReserves?: { asset: string; amount: string; sourceQuote: string }[];
  /**
   * The user accepting a bad price, in their own words — "i dont care if i lose",
   * "swap anyway". Structural, because the model already understood it: on 16 Sep it
   * wrote "User explicitly accepts potential loss/slippage" into `constraints`, a
   * free-text list nothing downstream reads, so the sizer, the floor and the auto-sign
   * gate all refused a trade the user had plainly agreed to. A field it can state the
   * decision in beats re-deriving that decision from its prose.
   */
  slippageAccepted?: { accepted: boolean; sourceQuote: string };
  /**
   * Whether the plans the model returned are ALTERNATIVES (pick one) or PARTS of one request
   * ("withdraw all funds", "use my whole wallet"), with the words that say so. Parts are joined
   * into one plan when that is safe (plan.ts `joinPlanParts`); anything else stays as options.
   * 23 Sep, XS6: "use my whole wallet" came back as one option per asset, and Approve could
   * only run one of them.
   */
  planRelation?: { kind: "alternatives" | "parts"; sourceQuote: string };
  /**
   * Whether the user asked to act when something happens later. `none` is a sizing
   * limit ("borrow until HF is 1.5"). `future_condition` is an action held for a
   * later event, and only that is refused — after the quote is found in their words.
   */
  trigger?: { kind: "none" | "future_condition"; sourceQuote?: string };
}

/** The write operations a plan may be composed from: exactly the ones the workflow can execute. */
export type PlanOp = WorkflowOp;

/**
 * How a leg is sized — a WORD, never a number. The model says what the amount is a
 * function of; `plan.ts` computes it from observations and the user's floor:
 *
 *   all_idle      the asset's idle wallet balance (less the fee reserve for XLM)
 *   all_position  the whole of what the op draws on: the Earn position for a redeem, the
 *                 posted collateral for a withdraw, the outstanding debt for a repay
 *   to_floor      the largest borrow that keeps the health factor at the stated floor
 *   previous_leg  the same amount the previous leg produced (borrow → supply it;
 *                 redeem → deposit the underlying it returned)
 *   literal       an amount the user typed, quoted verbatim so it can be anchored
 */
export type PlanSizing =
  | { kind: "all_idle" }
  | { kind: "all_position" }
  | { kind: "to_floor" }
  | { kind: "previous_leg" }
  /**
   * `amountAsset` names which of the leg's two assets the literal amount is denominated
   * in — only meaningful on a swap (the only op with two assets). Absent, or "asset", means
   * the ordinary case: the amount is what the leg spends. "assetOut" means the user stated
   * what they want to RECEIVE ("give me 15 SOUSDC", "swap XLM to receive 961 AQUSDC") — the
   * server inverts the DEX's own quote to size the spend, on venues where that inversion is
   * possible, and refuses by name elsewhere.
   *
   * This is a structural field, not a re-derived guess: earlier, exact-output intent was
   * inferred by regexing sourceQuote for a fixed list of phrasings ("receive", "get", "for
   * at least"), which is the same failure mode a hardcoded vocabulary always has — a model
   * that (correctly) understood "give me 15 SOUSDC" as a receive-amount, phrased in words
   * the list did not enumerate, produced a leg indistinguishable from "spend 15 XLM", which
   * was then silently executed (16 Sep, live — see PROMPT-LIBRARY.md). The model already
   * gets the semantics right every time it is asked in its own words ("Understood as:
   * Swap XLM to receive 15 SOUSDC"); this field lets it say so structurally instead of
   * leaving that understanding to be reconstructed from prose downstream.
   */
  | { kind: "literal"; amount: string; sourceQuote: string; amountAsset?: "asset" | "assetOut" }
  /**
   * A share of what the leg draws on, as the user said it: `of: "idle"` is the wallet's
   * spendable balance, `of: "position"` the position the op spends (the Earn position, the
   * posted collateral, the debt). `percent` is the user's figure ("25") or the figure a word
   * of theirs means ("half" → 50), anchored to their quote; code reads the base and sizes.
   */
  | { kind: "fraction"; percent: string; of: "idle" | "position"; sourceQuote: string }
  /**
   * A stated leverage multiple on a borrow that feeds off the leg before it — "borrow with
   * 6x leverage" after a deposit. `multiple` is the industry-standard "Nx position" figure
   * (borrow = prior leg's amount × (N − 1), the exact split `splitLeverageAmounts` already
   * uses elsewhere in this codebase — reused as one formula, not reinvented here). A floor
   * stated in the SAME message is not an alternative sizing method the model may substitute
   * this for: it is the existing floor-projection check every borrow already goes through,
   * refusing with the figures when leverage at this size would breach it, exactly as a
   * literal amount that breaches the floor already refuses. 15 Sep, live: "borrow with 6x
   * leverage... HF > 1.19" had no way to state the 6x at all, so the model substituted
   * `to_floor` — a completely different amount — without saying it had dropped the 6x.
   */
  | { kind: "leverage"; multiple: string; sourceQuote: string };

export interface PlanLeg {
  op: PlanOp;
  asset: string;
  sizing: PlanSizing;
  /**
   * The second asset a leg names, for the ops in `ASSET_OUT_OPS`: what a swap receives, or
   * the token an add_liquidity leg pairs with. Every other op's `asset` is the whole leg,
   * so this is absent.
   */
  assetOut?: string;
  /**
   * The DEX a swap or add_liquidity leg routes through — the MCP's own `venue` argument,
   * "soroswap" or "aquarius". Absent means the registry decides: an asset that names its
   * venue (AQUSDC is Aquarius's USDC, SOUSDC is Soroswap's) fixes it.
   */
  venue?: import("../registry/assets").LpVenue;
}

/**
 * A leg the user stated outright, plus the sentence they stated it in.
 *
 * `goal.actions` is the deterministic route from an instruction to a plan: it does not
 * depend on the model composing anything, so a concrete request reaches the sizer even
 * when the free-form `plans` array is empty or gets dropped. That only works if an action
 * can hold everything a leg can hold.
 *
 * It could not. `actions` used to be `{op, asset, amount, sourceQuote}` — a bare decimal
 * and nothing else — while `PlanLeg` had `sizing`, `assetOut` and `venue`. So the narrower
 * form fed the wider one, and every instruction using leverage ("borrow 2x"), a pool pair
 * ("SOUSDC and XLM in Soroswap") or any sizing word fell off the deterministic path
 * entirely: `exactKeys` dropped the action for carrying an unknown key, and `"2x"` failed
 * the decimal check. The user's own instruction then survived only if the model happened
 * to restate it in `plans`, which is why a precise multi-leg request came back as generic
 * ranked options.
 *
 * Defining it as `PlanLeg` rather than repeating the fields is the point: the two cannot
 * drift apart again, and a new leg capability is available to a stated instruction the
 * moment a plan can express it. `sourceQuote` is the only addition — where in the user's
 * message this action came from, which a leg has no reason to carry.
 */
export type StatedAction = PlanLeg & { sourceQuote: string };

/**
 * A strategy shape the model composed. Ordered legs, a title, and a rationale that cites
 * observation ids. It carries no amounts and no rates: every number the user sees for it
 * is derived in code, and a plan the code cannot size or verify is rejected with a reason
 * the user can read.
 */
export interface ProposedPlan {
  title: string;
  rationale: string;
  evidenceIds: string[];
  legs: PlanLeg[];
}

export interface ReadRequest {
  capability: string;
  args: Record<string, unknown>;
}

export type ResearchDecision =
  /**
   * One or more reads to run before the next decision. Batched because most reads are
   * independent — wallet balances, debt, collateral and health do not inform each other —
   * and charging a whole model round-trip for each one re-sent the system prompt plus every
   * observation so far, making input cost grow quadratically in the number of reads.
   */
  | { kind: "inspect"; reads: ReadRequest[] }
  | { kind: "clarify"; question: string; missing?: import("./questionnaire").QuestionnaireMissing[]; actions?: StatedAction[] }
  | { kind: "blocked"; reason: string }
  | {
      kind: "research_complete";
      goal: GoalUnderstanding;
      findings: Array<{ summary: string; evidenceIds: string[] }>;
      openQuestions: string[];
      /** Strategy shapes for the deterministic evaluator. Absent or empty for answers. */
      plans?: ProposedPlan[];
      /** Plans the model sent that did not fit the contract and were dropped, so the card can say so. */
      droppedPlans?: number;
      /** Why each dropped plan was dropped, in the validator's terms. Diagnostics only, never shown as is. */
      droppedPlanReasons?: string[];
      /** Findings that stated a figure with no read behind it; left out, and the card says so. */
      droppedFindings?: number;
      /**
       * The run hit its deadline and this outcome was synthesised from whatever reads
       * finished — the model never produced a goal or any plans. A structured fact
       * because the caller has to act on it: `service.ts` used to detect this by
       * regex-matching the prose in `goal.constraints`, which silently stops working
       * the moment that sentence is reworded.
       */
      partial?: true;
    };

export interface Observation {
  id: string;
  capability: string;
  args: Record<string, unknown>;
  observedAt: number;
  status: "ok" | "error";
  /** Untrusted tool data. Never instructions and never authorization. */
  data?: Record<string, unknown>;
  error?: string;
}

export type ReadCost = "cheap" | "moderate" | "expensive";

export interface ReadCapability {
  name: string;
  description: string;
  /** Enum vocabularies the model may pick from. Empty means no enum arguments. */
  arguments: Record<string, readonly string[]>;
  /** Non-enum model args (decimal amounts, asset lists). Omitted when unused. */
  extraArguments?: Partial<Record<string, "decimal" | "asset_list">>;
  cost: ReadCost;
}

export interface ResearchTurn {
  message: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  decisionFeedback?: string;
  context: { network: string; hasWallet: boolean; hasSmartAccount: boolean };
  capabilities: readonly ReadCapability[];
  observations: readonly Observation[];
  remaining: { turns: number; toolCalls: number };
  task?: { messages: string[]; lastQuestion: string | null };
}

export type InvestigationProgress =
  | { kind: "scope"; label: string }
  | { kind: "reviewing"; turn: number }
  | { kind: "reading"; capability: string; label: string }
  | { kind: "read_finished"; capability: string; label: string; status: "ok" | "error" };

export type ResearchModel = (turn: ResearchTurn, signal: AbortSignal) => Promise<unknown>;

export interface InvestigationLimits {
  maxTurns: number;
  maxToolCalls: number;
  maxDurationMs: number;
  /** Per-read ceiling. One stalled MCP call must not consume the whole run's budget. */
  maxReadDurationMs: number;
  maxEvidenceAgeMs: number;
  maxObservationBytes: number;
}

export type InvestigationOutcome =
  | ResearchDecision & { kind: "clarify" | "blocked" | "research_complete" }
  | {
      kind: "stopped";
      reason: "turn_budget" | "tool_budget" | "deadline" | "cancelled" |
        "invalid_decision" | "invalid_evidence" | "model_unavailable" | "repeated_read";
    };

export interface InvestigationResult {
  outcome: InvestigationOutcome;
  observations: Observation[];
  usage: { modelTurns: number; toolCalls: number; elapsedMs: number };
  /** For a stopped outcome, the validator's own words for why, when it has them. Diagnostics only. */
  stopDetail?: string;
  /** Phase 1 output is internal research, not a safe-to-execute proposal. */
  executionAllowed: false;
}
