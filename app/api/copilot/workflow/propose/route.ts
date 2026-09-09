import { NextRequest, NextResponse } from "next/server";
import { loadUserFromRequest } from "@/lib/copilot/request-user";
import { withBoundUser } from "@/lib/copilot/user-context";
import { getMcpClient } from "@/lib/copilot/mcp-client";
import { copilotConfig } from "@/lib/copilot/config";
import { isRecord } from "@/lib/copilot/investigation/decision";
import { ResearchError } from "@/lib/copilot/investigation/scope";
import { proposeWorkflow } from "@/lib/copilot/investigation/proposal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function inputFrom(req: NextRequest): Promise<{ continuation: string; candidateId: string }> {
  if (!req.body) throw new ResearchError("invalid_request", "Send the investigation continuation and the option to prepare.", 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 96_000) { await reader.cancel(); throw new ResearchError("request_too_large", "This proposal request is too large.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ResearchError("invalid_request", "Invalid proposal request.", 400); }
  if (!isRecord(body) || Object.keys(body).some((key) => !["continuation", "candidateId"].includes(key)) ||
    typeof body.continuation !== "string" || !body.continuation.trim() || body.continuation.length > 65_536 ||
    typeof body.candidateId !== "string" || !/^[a-z0-9_]{1,80}$/.test(body.candidateId)) {
    throw new ResearchError("invalid_request", "Send the investigation continuation and the option to prepare only. This route cannot accept execution instructions or approval payloads.", 400);
  }
  return { continuation: body.continuation, candidateId: body.candidateId };
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) return NextResponse.json({ message: "Request origin was refused." }, { status: 403 });
  let input: { continuation: string; candidateId: string };
  try { input = await inputFrom(req); } catch (error) {
    const known = error instanceof ResearchError ? error : new ResearchError("invalid_request", "Invalid proposal request.", 400);
    return NextResponse.json({ code: known.code, message: known.message }, { status: known.status });
  }
  const loaded = await loadUserFromRequest(req);
  if (!loaded.bound) return loaded.commit(NextResponse.json({ code: "sign_in_required", message: "Sign in to prepare a plan for your connected account." }, { status: 401 }));
  const secret = process.env.COPILOT_RESEARCH_SECRET?.trim() || copilotConfig.sessionSecret;
  const network = process.env.COPILOT_RESEARCH_NETWORK?.trim() || "testnet";
  if (process.env.COPILOT_RESEARCH_ENABLED === "false" || secret.length < 32 || network !== "testnet") {
    return loaded.commit(NextResponse.json({ code: "research_not_configured", message: "Investigation is not available on this deployment yet." }, { status: 503 }));
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 75_000);
  const bound = loaded.bound;
  try {
    const view = await withBoundUser(bound, () => proposeWorkflow({
      continuation: input.continuation, candidateId: input.candidateId, subject: bound.sub,
      secret, server: copilotConfig.mcpBaseUrl, network, mcp: getMcpClient(),
      signal: AbortSignal.any([req.signal, abort.signal]),
    }));
    return loaded.commit(NextResponse.json(view, { headers: { "Cache-Control": "no-store" } }));
  } catch (error) {
    const known = error instanceof ResearchError ? error : null;
    return loaded.commit(NextResponse.json({
      code: known?.code ?? "proposal_unavailable",
      message: known?.message ?? "A plan could not be prepared from the current investigation. Please try again.",
    }, { status: known?.status ?? 409 }));
  } finally {
    clearTimeout(timer);
  }
}
