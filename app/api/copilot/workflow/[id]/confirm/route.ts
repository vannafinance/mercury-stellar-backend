import { NextRequest, NextResponse } from "next/server";
import { loadUserFromRequest } from "@/lib/copilot/request-user";
import { withBoundUser } from "@/lib/copilot/user-context";
import { getMcpClient } from "@/lib/copilot/mcp-client";
import { copilotConfig } from "@/lib/copilot/config";
import { isRecord } from "@/lib/copilot/investigation/decision";
import { ResearchError } from "@/lib/copilot/investigation/scope";
import { WorkflowConflict } from "@/lib/copilot/workflow/journal";
import { confirmWorkflow } from "@/lib/copilot/investigation/execute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function inputFrom(req: NextRequest): Promise<{ txHash: string }> {
  if (!req.body) throw new ResearchError("invalid_request", "Send the submitted transaction hash only.", 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4_096) { await reader.cancel(); throw new ResearchError("request_too_large", "This confirmation is too large.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ResearchError("invalid_request", "Invalid confirmation.", 400); }
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "txHash") ||
    typeof body.txHash !== "string" || !/^[a-f0-9]{64}$/i.test(body.txHash)) {
    throw new ResearchError("invalid_request", "Send the submitted transaction hash only. This route cannot accept tools, amounts or envelopes.", 400);
  }
  return { txHash: body.txHash };
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) return NextResponse.json({ message: "Request origin was refused." }, { status: 403 });
  const { id } = await params;
  if (!/^[a-f0-9-]{36}$/.test(id)) {
    return NextResponse.json({ code: "invalid_request", message: "Send the submitted transaction hash only." }, { status: 400 });
  }
  let input: { txHash: string };
  try { input = await inputFrom(req); } catch (error) {
    const known = error instanceof ResearchError ? error : new ResearchError("invalid_request", "Invalid confirmation.", 400);
    return NextResponse.json({ code: known.code, message: known.message }, { status: known.status });
  }
  const loaded = await loadUserFromRequest(req);
  if (!loaded.bound) return loaded.commit(NextResponse.json({ code: "sign_in_required", message: "Sign in to confirm a plan for your connected account." }, { status: 401 }));
  const secret = process.env.COPILOT_RESEARCH_SECRET?.trim() || copilotConfig.sessionSecret;
  const network = process.env.COPILOT_RESEARCH_NETWORK?.trim() || "testnet";
  if (process.env.COPILOT_RESEARCH_ENABLED === "false" || secret.length < 32 || network !== "testnet") {
    return loaded.commit(NextResponse.json({ code: "research_not_configured", message: "Investigation is not available on this deployment yet." }, { status: 503 }));
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 75_000);
  const bound = loaded.bound;
  try {
    const view = await withBoundUser(bound, () => confirmWorkflow({
      id, txHash: input.txHash, subject: bound.sub, secret, server: copilotConfig.mcpBaseUrl, network,
      mcp: getMcpClient(), signal: AbortSignal.any([req.signal, abort.signal]),
    }));
    return loaded.commit(NextResponse.json(view, { headers: { "Cache-Control": "no-store" } }));
  } catch (error) {
    if (error instanceof WorkflowConflict) {
      return loaded.commit(NextResponse.json({ code: error.message, message: "This confirmation could not be recorded. Try again." }, { status: 409 }));
    }
    const known = error instanceof ResearchError ? error : error instanceof Error && error.message === "workflow_not_found"
      ? new ResearchError("workflow_not_found", "This plan was not found for your account.", 404)
      : null;
    return loaded.commit(NextResponse.json({
      code: known?.code ?? "confirm_unavailable",
      message: known?.message ?? "This confirmation could not be recorded. Please try again.",
    }, { status: known?.status ?? 409 }));
  } finally {
    clearTimeout(timer);
  }
}
