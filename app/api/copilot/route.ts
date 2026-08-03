/**
 * In-process Copilot API — Gemini intent + MCP execution + auto-sign.
 *
 *   GET  /api/copilot           → health
 *   GET  /api/copilot?probe=1   → health + Vertex probe
 *   POST /api/copilot           → chat / auto-sign / resume pending write
 */

import { NextRequest, NextResponse } from "next/server";
import { getBrainHealth, handleChat, logCopilotEvent, vertexPing } from "@/lib/copilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Multi-leg strategies run N MCP writes + HF samples in one request.
 * Default serverless limits (~10–60s) will abort mid-strategy.
 * Hosts that honor maxDuration (e.g. Vercel Pro) need this headroom.
 */
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  try {
    const health = getBrainHealth();
    if (req.nextUrl.searchParams.get("probe") === "1") {
      const vertex = await vertexPing();
      return NextResponse.json({
        health: {
          ...health,
          vertex_ok: vertex.ok,
          vertex_model: vertex.model,
          vertex_error: vertex.error ?? null,
        },
      });
    }
    return NextResponse.json({ health });
  } catch (e) {
    const message = e instanceof Error ? e.message : "health check failed";
    return NextResponse.json({ health: null, error: message }, { status: 200 });
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ kind: "error", message: "Invalid request body." }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  const autoSign = body.auto_sign && typeof body.auto_sign === "object" ? (body.auto_sign as any) : null;
  const pendingWrite =
    body.pending_write && typeof body.pending_write === "object" ? (body.pending_write as any) : null;
  const resumeMultiLeg =
    body.resume_multi_leg && typeof body.resume_multi_leg === "object"
      ? (body.resume_multi_leg as {
          summary?: string;
          legs?: Array<{
            op: string;
            asset?: string | null;
            amount?: number | null;
            leverage?: number | null;
            label?: string;
          }>;
        })
      : null;

  const approvedPlan =
    body.approved_plan &&
    typeof body.approved_plan === "object" &&
    Array.isArray((body.approved_plan as { steps?: unknown }).steps)
      ? (body.approved_plan as {
          plan_id: string;
          created_at: number;
          steps: Array<{
            op: string;
            asset?: string | null;
            amount?: number | null;
            leverage?: number | null;
          }>;
        })
      : null;

  const summarizeExecution =
    body.summarize_execution &&
    typeof body.summarize_execution === "object" &&
    Array.isArray((body.summarize_execution as { legs?: unknown }).legs)
      ? (body.summarize_execution as {
          intent?: string;
          legs: Array<{
            action?: string;
            status?: string;
            tx_hash?: string | null;
          }>;
        })
      : null;

  if (
    !message &&
    !autoSign &&
    !pendingWrite &&
    !resumeMultiLeg?.legs?.length &&
    !approvedPlan &&
    !summarizeExecution?.legs?.length
  ) {
    return NextResponse.json({ kind: "error", message: "Please type a question." }, { status: 400 });
  }

  const pageContext =
    body.page_context && typeof body.page_context === "object" && !Array.isArray(body.page_context)
      ? (body.page_context as import("@/lib/copilot/types").PageDescriptorCtx)
      : null;

  const pageSnapshot =
    body.page_snapshot && typeof body.page_snapshot === "object" && !Array.isArray(body.page_snapshot)
      ? (body.page_snapshot as import("@/lib/copilot/types").PageSnapshotCtx)
      : null;

  const semanticPageContext =
    body.semantic_page_context &&
    typeof body.semantic_page_context === "object" &&
    !Array.isArray(body.semantic_page_context)
      ? (body.semantic_page_context as import("@/lib/copilot/types").SemanticPageContextCtx)
      : null;

  // Bound DOM text so a huge page cannot blow the request.
  if (pageSnapshot?.visible_text && pageSnapshot.visible_text.length > 16_000) {
    pageSnapshot.visible_text = pageSnapshot.visible_text.slice(0, 16_000);
  }
  if (pageSnapshot?.selection && pageSnapshot.selection.length > 2_500) {
    pageSnapshot.selection = pageSnapshot.selection.slice(0, 2_500);
  }
  if (pageSnapshot?.region_text && pageSnapshot.region_text.length > 6_000) {
    pageSnapshot.region_text = pageSnapshot.region_text.slice(0, 6_000);
  }
  if (semanticPageContext?.mainText && semanticPageContext.mainText.length > 12_000) {
    semanticPageContext.mainText = semanticPageContext.mainText.slice(0, 12_000);
  }
  if (semanticPageContext?.selectedText && semanticPageContext.selectedText.length > 2_500) {
    semanticPageContext.selectedText = semanticPageContext.selectedText.slice(0, 2_500);
  }

  const history = Array.isArray(body.history)
    ? (body.history as Array<{ role?: string; text?: string }>)
        .filter(
          (h) =>
            (h.role === "user" || h.role === "assistant") &&
            typeof h.text === "string" &&
            h.text.trim(),
        )
        .slice(-8)
        .map((h) => ({
          role: h.role as "user" | "assistant",
          text: String(h.text).slice(0, 2000),
        }))
    : null;

  const payload = {
    user_id: typeof body.user_id === "string" && body.user_id ? body.user_id : "guest",
    message:
      message ||
      (autoSign
        ? "auto-sign"
        : resumeMultiLeg?.legs?.length
          ? "resume multi-leg"
          : summarizeExecution?.legs?.length
            ? "summarize execution"
            : "pending-write"),
    tier: body.tier === "paid" ? ("paid" as const) : ("free" as const),
    smart_account: typeof body.smart_account === "string" ? body.smart_account : null,
    page_context: pageContext,
    page_snapshot: pageSnapshot,
    semantic_page_context: semanticPageContext,
    history,
    auto_sign: autoSign,
    pending_write: pendingWrite,
    approved_plan: approvedPlan,
    resume_multi_leg:
      resumeMultiLeg?.legs?.length
        ? {
            summary: resumeMultiLeg.summary,
            legs: resumeMultiLeg.legs,
          }
        : null,
    summarize_execution: summarizeExecution?.legs?.length
      ? {
          intent:
            typeof summarizeExecution.intent === "string" && summarizeExecution.intent.trim()
              ? summarizeExecution.intent.trim()
              : message || "strategy",
          legs: summarizeExecution.legs
            .filter((l) => l && typeof l === "object")
            .map((l) => ({
              action: String(l.action || "step"),
              status: String(l.status || "unknown"),
              tx_hash: l.tx_hash != null ? String(l.tx_hash) : null,
            })),
        }
      : null,
  };

  try {
    const data = await handleChat(payload);
    const multiLeg = !!(data.data && (data.data as Record<string, unknown>).multi_leg);
    const multiSteps = multiLeg
      ? ((data.data as Record<string, unknown>).multi_leg_steps as unknown[])
      : null;
    logCopilotEvent("turn", {
      request_id: data.request_id,
      kind: data.kind,
      template_id: data.intent?.template_id ?? null,
      user: payload.user_id,
      message: message.slice(0, 120),
      execution: data.execution?.status ?? null,
      multi_leg: multiLeg,
      multi_leg_steps: Array.isArray(multiSteps) ? multiSteps.length : null,
      tx_hash: data.execution?.tx_hash ? String(data.execution.tx_hash).slice(0, 16) : null,
    });
    return NextResponse.json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Copilot failed";
    logCopilotEvent("turn_error", { error: msg });
    return NextResponse.json({ kind: "error", message: msg }, { status: 200 });
  }
}
