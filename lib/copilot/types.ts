import type { StructuredAnswer } from "./answer-schema";
import type { GuideAnswer } from "./guide-schema";
import type { PlanConstraints } from "./plan-ir";

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
    /**
     * `bind_start` / `bind_status` drive the additional-signer consent that
     * `wallet_not_bound` requires — see WalletBindPrompt for why it is a separate
     * step from connecting the wallet.
     */
    action?:
      | "start"
      | "use_defaults"
      | "custom"
      | "disable"
      | "bind_start"
      | "bind_status"
      /**
       * The silent path. The page has already run Privy's `addSigners` in the
       * gesture that turned auto-sign on; this completes the binding server-side
       * and then applies the enable. No user-visible detour.
       */
      | "bind_register";
    max_per_tx_usd?: number | string;
    max_per_day_usd?: number | string;
    /** `bind_status` / `bind_register` — the connect request to complete or poll. */
    request_id?: string;
    /** `bind_register` only — the G-address the browser authorized the quorum on. */
    wallet_address?: string;
    /**
     * `bind_status` only — replay this action the moment the binding lands, so
     * the user gets what they originally asked for rather than a "now try again".
     */
    retry_action?: "use_defaults" | "custom" | "disable";
  } | null;
  /** Re-run a pending write after enabling auto-sign / agent chain hop */
  pending_write?: {
    op: string;
    asset?: string | null;
    amount?: number | null;
    leverage?: number | null;
    /** The loan slot, independent of the collateral slot above. */
    borrow_asset?: string | null;
    borrow_amount?: number | null;
    /** Which slot a variant chip answers — see the ChatResponse copy of this field. */
    clarify_slot?: "collateral" | "borrow" | null;
    /** Carried through a variant clarification — see CopilotAction.explain. */
    explain?: boolean | null;
    token_a?: string | null;
    token_b?: string | null;
    amount_a?: number | null;
    amount_b?: number | null;
    fraction?: number | null;
    /**
     * Remaining hop after this write confirms (e.g. borrow → supply_to_blend).
     * May nest further via follow_up.
     */
    follow_up?: NextStepHop | null;
  } | null;
  /**
   * A plan the user has explicitly approved, sent back verbatim from a plan_preview.
   * Replayed as-is — never re-inferred — so what executes is what was shown. The
   * plan_id must still match the steps or the server refuses to run it.
   */
  approved_plan?: {
    plan_id: string;
    created_at: number;
    steps: Array<{
      op: string;
      asset?: string | null;
      amount?: number | null;
      leverage?: number | null;
      /**
       * The loan slot. Part of the approved content and part of the fingerprint —
       * dropping it here replayed a cross-asset borrow as a same-asset one.
       */
      borrow_asset?: string | null;
    }>;
  } | null;
  /**
   * Resume a multi-leg strategy from remaining / failed legs (client button).
   * Server builds a plan from these legs and runs MultiLegAgent.
   */
  resume_multi_leg?: {
    summary?: string;
    legs: Array<{
      op: string;
      asset?: string | null;
      amount?: number | null;
      leverage?: number | null;
      label?: string;
    }>;
  } | null;
  /**
   * Client-signed final leg: ask Vertex for a structured receipt from legs that
   * actually ran (and their real tx hashes). No invented HF/balances.
   */
  summarize_execution?: {
    intent: string;
    legs: Array<{
      action: string;
      status: string;
      tx_hash?: string | null;
    }>;
    /** Optional real HF reading from the client rail — never invented. */
    final_health_factor?: number | null;
    health_factor_floor?: number | null;
  } | null;
}

export interface CopilotAction {
  /**
   * The user also asked what this action does, so the response should include the
   * projected impact. Carried on the action so it survives a variant clarification,
   * after which the incoming message is just "BLUSDC" and the original ask is lost.
   */
  explain?: boolean | null;
  op: string;
  asset?: string | null;
  amount?: number | null;
  requires_amount?: boolean;
  requires_account?: boolean;
  multi_leg?: boolean;
  smart_account?: string | null;
  trader?: string | null;
  leverage?: number | null;
  /**
   * Collateral and borrow are two independent slots.
   *
   * `asset`/`amount` are the collateral; these are the loan. Absent `borrow_asset`
   * means "same asset", which is the common case and the reason one field carried
   * both for so long — until "deposit AQUSDC, borrow XLM" made the conflation
   * visible as a borrow leg denominated in the wrong token.
   */
  borrow_asset?: string | null;
  borrow_amount?: number | null;
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

/**
 * The wallet is connected in the browser but not bound to this identity at the
 * Sign Service, so no server-side signing authority exists for it.
 *
 * ## Why this is its own gate and not an auto-sign error
 *
 * "Privy connected" and "Vanna may sign for this wallet" are two different facts
 * that live in two different systems, and only the first one a wallet-connect
 * modal can establish. The binding is a row in the Sign Service's
 * `identity_wallet_bindings`, written at `/wallets/connect/start` from the
 * forwarded user assertion and completed when the user authorizes the Vanna
 * quorum as an ADDITIONAL signer on their own wallet (`addSigners`).
 *
 * Nothing in the browser wallet session can produce that row. Disconnecting and
 * reconnecting through Privy — even while signed in — refreshes the browser's
 * wallet session and writes no binding, which is exactly why the 403 survived a
 * reconnect and read as a bug in sign-in rather than a missing consent step.
 *
 * So the honest response to `wallet_not_bound` is not "auto-sign failed, retry"
 * but "one consent you have never given is missing, here is the link". The gate
 * carries `connect_url`; the user grants the signer; `retry_action` is what we
 * re-run for them once the binding lands, so the request they originally made
 * completes instead of having to be typed again.
 */
export interface WalletBindPrompt {
  /**
   * `needs_consent` — a fresh connect request exists, the user has not finished.
   * `pending` — polled, still not finished. `bound` — binding written.
   * `expired` — the link timed out; a new one must be minted.
   * `unavailable` — connect_start itself failed (reason in the message).
   */
  status: "needs_consent" | "pending" | "bound" | "expired" | "unavailable";
  /** Single-use connect request id. Poll it with `auto_sign.action = "bind_status"`. */
  request_id?: string | null;
  /**
   * FALLBACK ONLY. The externally hosted page that performs the same consent.
   *
   * Used when the in-app path cannot run (no `signer_id`, the Privy SDK refused, or
   * the register forward failed). It is not the normal route: sending someone to a
   * second tab to finish "I just turned auto-sign on" reads as a broken product.
   */
  connect_url?: string | null;
  /**
   * The Privy signer-quorum the page must authorize, so the consent can happen
   * in-app with at most Privy's own sheet. Absent → only the link fallback works.
   */
  signer_id?: string | null;
  /** Seconds until `request_id` expires. */
  expires_in?: number | null;
  /** MCP's suggested poll backoff. The client walks this list, it does not invent one. */
  poll_schedule_seconds?: number[] | null;
  /** Wallet this binding is for — shown so the user can check it is the one they expect. */
  wallet_address?: string | null;
  /** Re-run this auto-sign action once the binding exists (the user's original ask). */
  retry_action?: "use_defaults" | "custom" | "disable" | null;
  /** Caps to replay with `retry_action = "custom"`. */
  max_per_tx_usd?: number | string | null;
  max_per_day_usd?: number | string | null;
}

export interface ClarifyOption {
  id: string;
  label: string;
  description?: string;
}

/** One hop in a client agent chain (may nest via follow_up for 3+ leg farms). */
export type NextStepHop = {
  op: string;
  asset?: string | null;
  amount?: number | null;
  leverage?: number | null;
  label?: string;
  step?: number;
  total_steps?: number;
  follow_up?: NextStepHop | null;
};

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
    | "needs_wallet_sign"
    /** Wallet connected in-browser but not bound as a signer — see WalletBindPrompt. */
    | "needs_wallet_bind"
    /** A multi-leg plan awaiting the user's approval. Nothing has executed. */
    | "plan_preview";
  message: string;
  /**
   * Structured read answer. Present when the model returned data rather than prose;
   * `message` always carries the same content flattened to text, so a surface without
   * the renderer loses formatting, never the answer.
   */
  answer?: StructuredAnswer | null;
  /**
   * Structured Guide explanation. Present when the Guide answered with data rather
   * than prose; `message` carries the same content flattened.
   */
  guide?: GuideAnswer | null;
  /**
   * Present on plan_preview. Send the whole thing back as `approved_plan` to run it.
   */
  plan?: {
    plan_id: string;
    summary: string;
    created_at: number;
    /** On-chain legs the user will sign; exceeds steps.length when a step is levered. */
    signature_count: number;
    warnings: string[];
    steps: Array<{
      n: number;
      op: string;
      asset: string | null;
      amount: number | null;
      leverage: number | null;
      /** The loan slot — must be echoed back in approved_plan. */
      borrow_asset?: string | null;
      label: string;
      venue: "earn" | "margin" | "farm" | "wallet" | "other";
    }>;
  } | null;
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
    /** The loan slot, independent of the collateral slot above. */
    borrow_asset?: string | null;
    borrow_amount?: number | null;
    /**
     * Which asset slot the clarification is about, so the chip the user taps lands
     * in that slot and leaves the other one — already answered — alone.
     */
    clarify_slot?: "collateral" | "borrow" | null;
    /** Carried through a variant clarification — see CopilotAction.explain. */
    explain?: boolean | null;
  } | null;
  auto_sign?: AutoSignPrompt | null;
  /** Present on `needs_wallet_bind` — the missing additional-signer consent. */
  wallet_bind?: WalletBindPrompt | null;
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
  /** Next write after current step confirms (agent chain). Nested follow_up allowed. */
  next_step?: NextStepHop | null;
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
  /**
   * Which Google credential the copilot will route with.
   *
   * "workload_identity" is keyless (host OIDC token exchanged for an access token) and
   * "service_account" is a key in an env var; both are machine-independent and work in a
   * deploy. "developer_login" means it is leaning on whoever ran `gcloud auth login` on this
   * machine — the state that made the same prompt answer on one laptop and return the
   * capability blurb on another. Reported so that difference is visible before someone
   * hits it, since the symptom only appears once the login has already expired.
   */
  vertex_auth?: "workload_identity" | "service_account" | "developer_login";
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
      /** Borrow asset when it differs from the collateral asset (see CopilotAction). */
      borrow_asset?: string | null;
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
      /**
       * Constraints read once from the raw message. Optional because plans from the LLM
       * planner and the template router do not carry them; consumers fall back to parsing
       * the message, so an absent value behaves exactly as before.
       */
      constraints?: PlanConstraints;
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
    }
  | {
      /**
       * Browser-only action (no MCP). Used for G-wallet create/connect via Privy/Freighter.
       * Keys never leave the client — MCP has no create_wallet tool.
       */
      kind: "client";
      tool: string;
      args?: Record<string, unknown>;
      message: string;
      template_id: string;
    };
