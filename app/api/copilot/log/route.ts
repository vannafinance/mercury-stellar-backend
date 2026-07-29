/**
 * Write-execution log sink (in-process).
 * Fire-and-forget from the UI after wallet sign + submit.
 */

import { NextRequest, NextResponse } from "next/server";
import { logCopilotEvent } from "@/lib/copilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    logCopilotEvent("execute", {
      request_id: body.request_id ?? null,
      op: body.op ?? null,
      asset: body.asset ?? null,
      amount: body.amount ?? null,
      ok: body.ok ?? null,
      hash: body.hash ?? null,
      error: body.error ?? null,
      wallet: body.wallet ?? null,
    });
  } catch {
    // logging must never surface an error to the user
  }
  return NextResponse.json({ ok: true });
}
