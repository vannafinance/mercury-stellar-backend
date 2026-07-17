// Wire types for the Copilot chat, mirroring the orchestrator's Pydantic
// contracts (vanna-copilot-orchestrator/app/schemas.py). Kept in sync by hand;
// if the orchestrator's ChatResponse changes, update these too.

export type ChatKind =
  | "answer"
  | "preview"
  | "clarification"
  | "blocked"
  | "unavailable"
  | "error";

export type RiskDecision = "allow" | "block" | "needs_confirmation";

export interface RiskResult {
  decision: RiskDecision;
  reasons: string[];
  projected_health_factor?: number | null;
  projected_liquidation_price?: number | null;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  is_write: boolean;
}

export interface Preview {
  template_id: string;
  human_summary: string;
  slots: Record<string, unknown>;
  risk: RiskResult;
  tool_calls: ToolCall[];
  unsigned_xdrs: string[];
  requires_signature: boolean;
}

export interface ParsedIntent {
  template_id?: string | null;
  slots: Record<string, unknown>;
  confidence: number;
  clarification_needed?: string | null;
  raw_reasoning?: string | null;
}

export interface ChatResponse {
  kind: ChatKind;
  message: string;
  preview?: Preview | null;
  intent?: ParsedIntent | null;
}

// ---- Catalog types (GET /api/copilot → { health, templates }) ----
// Mirrors the orchestrator's GET /templates payload (app/main.py).

export interface BrainHealth {
  status: string;
  llm_provider: string;
  mcp_mode: string;
  templates: number;
}

export interface CatalogSlot {
  name: string;
  type: string;
  required: boolean;
  description: string | null;
  min: number | null;
  max: number | null;
  allowed: string[] | null;
}

export interface CatalogAction {
  id: string;
  type: "action";
  category: string;
  kind: string;
  title: string;
  intent_phrase: string;
  free_tier: boolean;
  available: boolean;
  is_write: boolean;
  notes: string | null;
  tool_sequence: string[];
  slots: CatalogSlot[];
}

export interface CatalogQuery {
  id: string;
  type: "query";
  kind: "query";
  title: string;
  intent_phrase: string;
  tool: string;
  available: boolean;
  requires_account: boolean;
  notes: string | null;
  required_slots: string[];
  allowed_assets: string[] | null;
}

export type CatalogEntry = CatalogAction | CatalogQuery;
