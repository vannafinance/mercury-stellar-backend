/** Server-side research contracts. None of these types authorize execution. */
export interface InvestigationScope {
  /** Authenticated subject, never a model-generated or browser-asserted identity. */
  subject: string;
  /** Caller must resolve and verify this wallet/account relationship server-side. */
  trader: string | null;
  smartAccount: string | null;
  network: string;
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
}

export interface GoalUnderstanding {
  intent?: "answer" | "strategy";
  relation?: "new" | "refine";
  actions?: Array<{ op: "lend" | "deposit_collateral" | "borrow" | "repay" | "supply_blend"; asset: string; amount: string; sourceQuote: string }>;
  objective: string;
  constraints: string[];
  borrowing: "unspecified" | "allowed" | "required" | "forbidden";
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
