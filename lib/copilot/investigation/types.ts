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
   */
  unverified?: "bindings";
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
  actions?: Array<{ op: WorkflowOp; asset: string; amount: string; sourceQuote: string }>;
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
  | { kind: "literal"; amount: string; sourceQuote: string }
  /**
   * A share of what the leg draws on, as the user said it: `of: "idle"` is the wallet's
   * spendable balance, `of: "position"` the position the op spends (the Earn position, the
   * posted collateral, the debt). `percent` is the user's figure ("25") or the figure a word
   * of theirs means ("half" → 50), anchored to their quote; code reads the base and sizes.
   */
  | { kind: "fraction"; percent: string; of: "idle" | "position"; sourceQuote: string };

export interface PlanLeg {
  op: PlanOp;
  asset: string;
  sizing: PlanSizing;
}

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
  | { kind: "clarify"; question: string }
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
      /** Findings that stated a figure with no read behind it; left out, and the card says so. */
      droppedFindings?: number;
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
  /** Phase 1 output is internal research, not a safe-to-execute proposal. */
  executionAllowed: false;
}
