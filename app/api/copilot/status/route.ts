import { NextRequest, NextResponse } from "next/server";
import { loadUserFromRequest } from "@/lib/copilot/request-user";
import { copilotConfig } from "@/lib/copilot/config";
import { statusLinesFor } from "@/lib/copilot/status-lines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Progress lines for the chat's "working" row, worded by the model for this prompt. Cosmetic: it never reads or
 * changes research or a plan, and every failure (signed out, over a limit, model down) answers with no lines.
 */
export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (origin && copilotConfig.publicOrigin && origin !== copilotConfig.publicOrigin) {
    return NextResponse.json({ lines: [] }, { status: 403 });
  }
  const loaded = await loadUserFromRequest(req);
  const body = (await req.json().catch(() => ({}))) as { message?: unknown };
  const message = typeof body.message === "string" ? body.message : "";
  // Signed-in users only: a guest's turn shows the investigation's own progress label.
  const lines = loaded.bound ? await statusLinesFor(loaded.bound.sub, message) : [];
  return loaded.commit(NextResponse.json({ lines }, { headers: { "Cache-Control": "no-store" } }));
}
