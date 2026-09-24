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
  /** Optional structured linkage for a fact explicitly requested by the read. */
  requested?: boolean;
  /**
   * True only when this number is an amount of the fact's own token. A rate, ratio,
   * health factor or percentage is never a quantity of the asset, and must never be
   * rendered as one. Set where the unit is derived (`facts-by-shape.ts`).
   */
  quantity?: boolean;
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
  /** Omitted for legacy/user-stated floors; present when the configured safety buffer was applied. */
  floorSource?: "user" | "configured_safety_buffer";
  grossCollateralUsd: string;
  debtUsd: string;
  healthFactor: string | null;
  maxBorrowUsd: string;
}

export interface QuestionnaireOption {
  id: string;
  label: string;
  detail?: string;
  forAsset?: string;
  op?: string;
  sourceSectionId?: string;
}
export interface QuestionnaireStep {
  slot: "asset" | "venue" | "amount";
  prompt: string;
  options: QuestionnaireOption[];
  max?: Record<string, { amount: string; asset: string; where: string; note?: string; bound?: "upper"; starting?: string }>;
  presets?: { id: string; label: string; percent: string }[];
  pair?: Record<string, { asset: string; perUnit: string | null; note?: string }>;
}
export interface QuestionnaireSection {
  id: string;
  title: string;
  actionIndex: number;
  /** Position of this action in the user's message, so stated actions can be merged back in order. */
  position?: number;
  steps: QuestionnaireStep[];
  sourceQuote?: string;
  op?: string;
  /** Sealed when the section was built. A later summary cannot change it. */
  assetOut?: string;
}
export interface SealedAction {
  position: number;
  action: import("./types").StatedAction;
}
export interface Questionnaire {
  id: string;
  title: string;
  subtitle: string;
  steps: QuestionnaireStep[];
  /** One entry per action that was missing something, in the order the user said them. */
  sections?: QuestionnaireSection[];
  /** Fully stated actions, sealed with their position so Send runs them too. */
  stated?: SealedAction[];
}
export interface QuestionnaireSectionAnswer {
  sectionId: string;
  asset: string;
  venue: string | null;
  amount: { kind: "fraction"; percent: string } | { kind: "literal"; amount: string } | { kind: "previous_leg" };
}
export interface QuestionnaireAnswers {
  questionnaireId: string;
  asset: string;
  venue: string | null;
  amount: { kind: "fraction"; percent: string } | { kind: "literal"; amount: string } | { kind: "previous_leg" };
  summary: string;
  sections?: QuestionnaireSectionAnswer[];
}

export interface ResearchView {
  /** Why a run stopped or plans were dropped, in validator terms. Never rendered; read from the response. */
  diagnostics?: {
    stopReason?: string; stopDetail?: string; droppedPlanReasons?: string[];
    failedReads?: { capability: string; args: Record<string, unknown>; error: string }[];
  };
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
  /** User-stated side of a swap, kept even when the risk gate rejects the plan. */
  swapIntent?: {
    tokenIn: string; tokenOut: string; venue: "aquarius" | "soroswap";
    amount: string; amountAsset: "asset" | "assetOut";
  } | null;
  rateComparisons?: import("./rate-comparison").RateComparison[];
  checks: Array<{ id: string; label: string; status: "ok" | "error"; readAt: number }>;
  warnings: string[];
  /**
   * Answers to `question` the user can pick with one tap. `send` is sent as the user's
   * next turn through the existing continuation. Built in code from the user's own words
   * (round 2 contract, docs/copilot/AGENT-TASKS.md), never invented by the model.
   */
  choices?: { id: string; label: string; send?: string; write?: "create_account" }[];
  /** Present when a direct action is missing inputs. The issued options are sealed in the continuation. */
  questionnaire?: Questionnaire;
  /**
   * The answers named one direct action. The client runs it under the direct-action
   * approval rule: no plan card. Strategy turns leave this unset.
   */
  directAction?: boolean;
  scope: { wallet: string | null; smartAccount: string | null; network: string };
  continuation: string;
  proposalCandidateId?: string | null;
  /**
   * A lifecycle write the page should run through `/api/copilot` `pending_write`.
   * Not a plan: no amounts, no journal. Identity is the connected session wallet.
   */
  pendingWrite?: { op: import("../workflow/lifecycle").LifecycleWriteOp } | null;
  executionAllowed: false;
  elapsedMs?: number;
}


export interface QuestionnaireOption {
  id: string;             // stable id the server issued
  label: string;          // "BLUSDC", "Earn", "Aquarius XLM/AQUSDC pool"
  detail?: string;        // "680 in wallet", "19.17% APY", "pairs with XLM · you have 2,147 XLM"
  forAsset?: string;      // venue options: the asset they apply to
  op?: string;            // venue options: the op this choice means (lend, supply_blend, add_liquidity)
}

export interface QuestionnaireStep {
  slot: "asset" | "venue" | "amount";
  prompt: string;         // "Which asset?", "Where should it go?", "How much?"
  options: QuestionnaireOption[];          // empty for the amount step
  max?: Record<string, { amount: string; asset: string; where: string }>; // amount step, keyed by asset id (and pool option id for LP)
  presets?: { id: string; label: string; percent: string }[];            // amount step, from BALANCE_FRACTION_OPTIONS
  pair?: Record<string, { asset: string; perUnit: string | null }>;      // LP venue option id → the other token and its per-unit ratio (null if reserves not read)
}

export interface Questionnaire {
  id: string;             // sealed in the continuation with the issued options
  title: string;          // "Supply USDC"
  subtitle: string;       // "Choose which, where and how much"
  steps: QuestionnaireStep[];
}

export interface QuestionnaireAnswers {
  questionnaireId: string;
  asset: string;                     // an issued asset option id
  venue: string | null;              // an issued venue option id, or null when that step was skipped
  amount: { kind: "fraction"; percent: string } | { kind: "literal"; amount: string };
  summary: string;                   // "Supply 50% of my BLUSDC to Earn": what the thread shows as the user's turn
}

export type ResearchStreamEvent =
  | { type: "progress"; event: import("./types").InvestigationProgress }
  /** `conversationId`: where the server recorded this turn, so the next turn joins it. */
  | { type: "result"; result: ResearchView; conversationId?: string }
  | { type: "error"; code: string; message: string };

