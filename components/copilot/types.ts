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

// UI-side message model (what the widget renders in the thread).
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  kind?: ChatKind;
  preview?: Preview | null;
}
