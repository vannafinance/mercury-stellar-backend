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

  if (!message && !autoSign && !pendingWrite) {
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

  const history = Array.isArray(body.history)
    ? (body.history as Array<{ role?: string; text?: string }>)
        .filter(
          (h) =>
            (h.role === "user" || h.role === "assistant") &&
            typeof h.text === "string" &&
            h.text.trim(),
        )
        .slice(-6)
        .map((h) => ({
          role: h.role as "user" | "assistant",
          text: String(h.text).slice(0, 2000),
        }))
    : null;

  const payload = {
    user_id: typeof body.user_id === "string" && body.user_id ? body.user_id : "guest",
    message: message || (autoSign ? "auto-sign" : "pending-write"),
    tier: body.tier === "paid" ? ("paid" as const) : ("free" as const),
    smart_account: typeof body.smart_account === "string" ? body.smart_account : null,
    page_context: pageContext,
    page_snapshot: pageSnapshot,
    history,
    auto_sign: autoSign,
    pending_write: pendingWrite,
  };

  try {
    const data = await handleChat(payload);
    logCopilotEvent("turn", {
      request_id: data.request_id,
      kind: data.kind,
      template_id: data.intent?.template_id ?? null,
      user: payload.user_id,
      message: message.slice(0, 120),
      execution: data.execution?.status ?? null,
    });
    return NextResponse.json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Copilot failed";
    logCopilotEvent("turn_error", { error: msg });
    return NextResponse.json({ kind: "error", message: msg }, { status: 200 });
  }
}
