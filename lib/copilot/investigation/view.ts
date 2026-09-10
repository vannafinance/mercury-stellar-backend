/** Browser-safe research response. No actions, signatures, raw MCP payloads or credentials. */
export interface ResearchFact {
  id: string;
  label: string;
  value: string;
  unit: string;
  venue: "wallet" | "margin" | "earn" | "blend" | "aquarius" | "oracle" | "signing";
  evidenceId: string;
  sourcePath: string;
  readAt: number;
}

/**
 * The model's restatement of the request — objective, the user's own constraints, and
 * whether borrowing was permitted. Safe to show because it repeats the user's intent
 * back rather than asserting a financial fact, and it is the only way the user can see
 * whether their prompt was understood before any sizing exists.
 */
export interface ResearchUnderstanding {
  intent?: "answer" | "strategy";
  objective: string;
  constraints: string[];
  borrowing: "unspecified" | "allowed" | "required" | "forbidden";
}

/**
 * Borrowing headroom at the user's own stated floor — computed, never modelled.
 *
 * Sized against RiskEngine `liquidation_snapshot` once it agrees with the app
 * snapshot. Present only when the user actually stated a floor; a floor is never
 * invented on their behalf. Drift beyond tolerance yields no capacity object.
 */
export interface ResearchCapacity {
  floor: string;
  grossCollateralUsd: string;
  debtUsd: string;
  healthFactor: string | null;
  maxBorrowUsd: string;
}

export interface ResearchView {
  /**
   * `replied` is a turn answered without investigating — a greeting, or an off-domain
   * refusal. Distinct from `researched` so the record never claims reads that never ran.
   */
  status: "needs_input" | "researched" | "blocked" | "incomplete" | "replied";
  message: string;
  originalRequest: string;
  refinements: string[];
  understanding: ResearchUnderstanding | null;
  question: string | null;
  facts: ResearchFact[];
  capacity?: ResearchCapacity | null;
  /** Deterministically generated and ranked options. Never a model's suggestion. */
  candidates?: import("./candidates").CandidateSet | null;
  rateComparisons?: import("./rate-comparison").RateComparison[];
  checks: Array<{ id: string; label: string; status: "ok" | "error"; readAt: number }>;
  warnings: string[];
  scope: { wallet: string | null; smartAccount: string | null; network: string };
  continuation: string;
  proposalCandidateId?: string | null;
  executionAllowed: false;
  /** Server wall time for this turn. Optional so older clients stay valid. */
  elapsedMs?: number;
}

export type ResearchStreamEvent =
  | { type: "progress"; event: import("./types").InvestigationProgress }
  | { type: "result"; result: ResearchView }
  | { type: "error"; code: string; message: string };
