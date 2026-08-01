/** Contracts shared between the in-process brain and /api/copilot. */

export type RiskDecision = "allow" | "block" | "needs_confirmation";

/** On-screen metric snapshot for the page-aware assistant (concept lane). */
export type PageMetricCtx = {
  label: string;
  value: string | null;
  isPlaceholder?: boolean;
  glossaryKey?: string;
};

/** Optional structured page registry (legacy enrichment only). */
export type PageDescriptorCtx = {
  route: string;
  title: string;
  purpose: string;
  metrics: PageMetricCtx[];
  actions: string[];
};

/**
 * Live DOM snapshot from the browser (legacy flat text).
 * Prefer semantic_page_context for the Gemini-style agent.
 */
export type PageSnapshotCtx = {
  path?: string;
  title?: string;
  url?: string;
  visible_text?: string;
  selection?: string | null;
  region_text?: string | null;
  headings?: string[];
  metrics?: Array<{ label: string; value: string }>;
  tables?: string[];
  captured_at?: number;
  char_count?: number;
};

/** Structured pageContext from the Gemini master plan (semantic reader). */
export type SemanticPageContextCtx = {
  url?: string;
  path?: string;
  title?: string;
  description?: string;
  sections?: Array<{ level?: number; text?: string; id?: string | null }>;
  mainText?: string;
  selectedText?: string | null;
  interactiveHints?: Array<{ id: string; label: string }>;
  capturedAt?: number;
};

export type ClientToolCallCtx = {
  name: string;
  args: Record<string, unknown>;
};

export interface ChatRequest {
  user_id: string;
  message: string;
  tier?: "free" | "paid";
  smart_account?: string | null;
  /** @deprecated Prefer semantic_page_context. */
  page_context?: PageDescriptorCtx | null;
  /** @deprecated Prefer semantic_page_context. */
  page_snapshot?: PageSnapshotCtx | null;
  /** Gemini-plan semantic pageContext JSON (primary for page agent). */
  semantic_page_context?: SemanticPageContextCtx | null;
  /**
   * Optional prior turns so the assistant can answer follow-ups naturally.
   * Client should send only short recent history (e.g. last 8 messages).
   */
  history?: Array<{ role: "user" | "assistant"; text: string }> | null;
  /** Client may send auto-sign confirmation choices */
  auto_sign?: {
    action?: "start" | "use_defaults" | "custom" | "disable";
    max_per_tx_usd?: number | string;
    max_per_day_usd?: number | string;
  } | null;
  /** Re-run a pending write after enabling auto-sign / agent chain hop */
  pending_write?: {
    op: string;
    asset?: string | null;
    amount?: number | null;
    leverage?: number | null;
    token_a?: string | null;
    token_b?: string | null;
    amount_a?: number | null;
    amount_b?: number | null;
    fraction?: number | null;
    /**
     * Remaining hop after this write confirms (e.g. borrow → then supply_to_blend).
     * Client echoes this on the next auto step so the server can attach next_step.
     */
    follow_up?: {
      op: string;
      asset?: string | null;
      amount?: number | null;
      leverage?: number | null;
      label?: string;
      step?: number;
      total_steps?: number;
    } | null;
  } | null;
}

export interface CopilotAction {
  op: string;
  asset?: string | null;
  amount?: number | null;
  requires_amount?: boolean;
  requires_account?: boolean;
  multi_leg?: boolean;
  smart_account?: string | null;
  trader?: string | null;
  leverage?: number | null;
  /** Aquarius / Soroswap LP pair legs */
  token_a?: string | null;
  token_b?: string | null;
  amount_a?: number | null;
  amount_b?: number | null;
  /** e.g. 0.5 for "remove half my liquidity" */
  fraction?: number | null;
  /**
   * User-stated health-factor floor (“keep HF above 1.5”, “avoid liquidation”).
   * Risk gate blocks writes that would project below this.
   */
  min_hf?: number | null;
  /** Prefer max-yield venue selection (earn vs farm ranking). */
  prefer_max_yield?: boolean | null;
  /** DEX venue: aquarius | soroswap */
  venue?: string | null;
}

export interface RiskResult {
  decision: RiskDecision;
  reasons: string[];
  projected_health_factor?: number | null;
}

export interface Simulation {
  hf_before: number | null;
  hf_after: number | null;
  collateral_before: number;
  collateral_after: number;
  debt_before: number;
  debt_after: number;
  ltv_before: number;
  ltv_after: number;
  liquidation_threshold: number;
  amount_usd: number;
  asset?: string | null;
}

export interface Preview {
  template_id: string;
  human_summary: string;
  slots: Record<string, unknown>;
  risk: RiskResult;
  requires_signature: boolean;
  action?: CopilotAction | null;
  simulation?: Simulation | null;
  /** MCP execution path metadata */
  mcp?: {
    tool?: string;
    status?: string;
    tx_hash?: string | null;
    needs_auto_sign?: boolean;
  } | null;
}

export interface AutoSignPrompt {
  status: "needs_confirmation" | "needs_enable";
  message: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  pending_write?: CopilotAction | null;
  raw?: Record<string, unknown> | null;
}

export interface ClarifyOption {
  id: string;
  label: string;
  description?: string;
}

export interface ChatResponse {
  kind:
    | "answer"
    | "clarification"
    | "unavailable"
    | "blocked"
    | "error"
    | "preview"
    | "executed"
    | "needs_auto_sign"
    | "needs_wallet_sign";
  message: string;
  preview?: Preview | null;
  data?: Record<string, unknown> | null;
  intent?: { template_id?: string | null; slots?: Record<string, unknown> } | null;
  request_id?: string | null;
  /**
   * Client-side tools for the page agent (navigate / scroll / highlight).
   * Executed in the browser only — never on the server.
   */
  client_tools?: ClientToolCallCtx[] | null;
  /**
   * Structured choices for clarifications (e.g. BLUSDC / AQUSDC / SOUSDC).
   * UI renders buttons; selecting one re-runs the pending_write with that asset.
   */
  clarify_options?: ClarifyOption[] | null;
  /** When set with clarify_options, resume this write after the user picks. */
  pending_write?: {
    op: string;
    asset?: string | null;
    amount?: number | null;
    leverage?: number | null;
  } | null;
  auto_sign?: AutoSignPrompt | null;
  /** Proof the live MCP server was used */
  mcp?: {
    tool?: string | null;
    simulation_success?: boolean;
    auto_sign?: string | null;
    auto_sign_error?: string | null;
    has_unsigned_xdr?: boolean;
  } | null;
  /** Present when MCP built XDR but Sign Service cannot auto-sign (user must wallet-sign once) */
  unsigned_xdr?: string | null;
  /**
   * Next write the client should run automatically after the current step
   * confirms on-chain (e.g. borrow after deposit in a 2× leverage plan).
   */
  next_step?: {
    op: string;
    asset?: string | null;
    amount?: number | null;
    leverage?: number | null;
    label?: string;
    step?: number;
    total_steps?: number;
    /** Nested hop after this step confirms (3-leg Blend farm). */
    follow_up?: {
      op: string;
      asset?: string | null;
      amount?: number | null;
      leverage?: number | null;
      label?: string;
      step?: number;
      total_steps?: number;
    } | null;
  } | null;
  execution?: {
    status: string;
    tx_hash?: string | null;
    steps?: Array<{
      tool: string;
      label: string;
      status: string;
      message: string;
      tx_hash?: string | null;
      hf_after?: number | null;
    }>;
  } | null;
}

export interface BrainHealth {
  status: string;
  llm_provider: string;
  mcp_mode: string;
  templates: number;
  in_process: true;
  execution_mode?: string;
}

export type RoutedIntent =
  | {
      kind: "read";
      tool: string;
      args: Record<string, unknown>;
      requires_account?: boolean;
      template_id: string;
    }
  | {
      kind: "write";
      op: string;
      asset?: string | null;
      amount?: number | null;
      multi_leg?: boolean;
      requires_account?: boolean;
      requires_amount?: boolean;
      template_id: string;
      leverage?: number | null;
      deposit_amount?: number | null;
      borrow_amount?: number | null;
      token_a?: string | null;
      token_b?: string | null;
      amount_a?: number | null;
      amount_b?: number | null;
      fraction?: number | null;
      min_hf?: number | null;
      prefer_max_yield?: boolean | null;
      token_in?: string | null;
      token_out?: string | null;
      venue?: string | null;
    }
  | {
      kind: "plan";
      steps: Array<{
        kind: "read" | "write";
        tool?: string;
        op?: string;
        args?: Record<string, unknown>;
        asset?: string | null;
        amount?: number | null;
        /** Optional; usually carried in args.leverage for expandPlanWrites. */
        leverage?: number | null;
      }>;
      template_id: string;
      summary?: string;
    }
  | {
      kind: "restricted";
      reason: string;
      template_id: string;
    }
  | {
      kind: "clarify";
      message: string;
      template_id?: string | null;
    }
  | {
      kind: "auto_sign";
      action: "start" | "use_defaults" | "custom" | "disable";
      max_per_tx_usd?: number | string;
      max_per_day_usd?: number | string;
      template_id: string;
    };
