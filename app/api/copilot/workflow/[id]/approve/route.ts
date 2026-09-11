import { NextRequest, NextResponse } from "next/server";
import { loadUserFromRequest } from "@/lib/copilot/request-user";
import { withBoundUser } from "@/lib/copilot/user-context";
import { getMcpClient } from "@/lib/copilot/mcp-client";
import { copilotConfig } from "@/lib/copilot/config";
import { isRecord } from "@/lib/copilot/investigation/decision";
import { ResearchError, resolveInvestigationScope } from "@/lib/copilot/investigation/scope";
import { validateProposal, workflowJournal } from "@/lib/copilot/investigation/proposal";
import { WorkflowConflict } from "@/lib/copilot/workflow/journal";
import { workflowView } from "@/lib/copilot/workflow/types";
import { logUnexpected } from "@/lib/copilot/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function inputFrom(req: NextRequest): Promise<{ revision: number; digest: string }> {
  if (!req.body) throw new ResearchError("invalid_request", "Send the proposal revision and digest to approve.", 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4_096) { await reader.cancel(); throw new ResearchError("request_too_large", "This approval request is too large.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ResearchError("invalid_request", "Invalid approval request.", 400); }
  if (!isRecord(body) || Object.keys(body).some((key) => !["revision", "digest"].includes(key)) ||
    typeof body.revision !== "number" || !Number.isSafeInteger(body.revision) || body.revision < 1 ||
    typeof body.digest !== "string" || !/^[a-f0-9]{64}$/.test(body.digest)) {
    throw new ResearchError("invalid_request", "Send the proposal revision and digest only. This route cannot accept tools, amounts or signed envelopes.", 400);
  }
  return { revision: body.revision, digest: body.digest };
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) return NextResponse.json({ message: "Request origin was refused." }, { status: 403 });
  const { id } = await params;
  if (!/^[a-f0-9-]{36}$/.test(id)) {
    return NextResponse.json({ code: "invalid_request", message: "Send the proposal revision and digest only. This route cannot accept tools, amounts or signed envelopes." }, { status: 400 });
  }
  let input: { revision: number; digest: string };
  try { input = await inputFrom(req); } catch (error) {
    const known = error instanceof ResearchError ? error : new ResearchError("invalid_request", "Invalid approval request.", 400);
    return NextResponse.json({ code: known.code, message: known.message }, { status: known.status });
  }
  const loaded = await loadUserFromRequest(req);
  if (!loaded.bound) return loaded.commit(NextResponse.json({ code: "sign_in_required", message: "Sign in to approve a plan for your connected account." }, { status: 401 }));
  const secret = process.env.COPILOT_RESEARCH_SECRET?.trim() || copilotConfig.sessionSecret;
  const network = process.env.COPILOT_RESEARCH_NETWORK?.trim() || "testnet";
  if (process.env.COPILOT_RESEARCH_ENABLED === "false" || secret.length < 32 || network !== "testnet") {
    return loaded.commit(NextResponse.json({ code: "research_not_configured", message: "Investigation is not available on this deployment yet." }, { status: 503 }));
  }
  const bound = loaded.bound;
  try {
    const view = await withBoundUser(bound, async () => {
      const journal = workflowJournal(secret);
      const stored = await journal.lookup(id, bound.sub);
      const expected = stored.value.proposal.scope;
      if (stored.value.proposal.server !== copilotConfig.mcpBaseUrl || expected.network !== network)
        throw new ResearchError("context_expired", "The execution environment changed. Prepare a new proposal.");
      const scope = await resolveInvestigationScope({
        subject: bound.sub, wallet: expected.trader, network,
      }, getMcpClient(), AbortSignal.any([req.signal, AbortSignal.timeout(20_000)]));
      if (scope.subject !== expected.subject || scope.trader !== expected.trader ||
        scope.smartAccount !== expected.smartAccount || scope.network !== expected.network) {
        throw new ResearchError("context_expired", "This investigation has expired or the connected account changed. Start a new investigation to refresh its context.");
      }
      const record = await journal.approve(id, { scope, server: stored.value.proposal.server }, input.revision, input.digest, validateProposal);
      const { appendAudit } = await import("@/lib/copilot/audit-log");
      void appendAudit({
        at: Date.now(), subject: bound.sub,
        action: record.status === "approved" ? "approved" : "blocked",
        workflowId: record.proposal.id, digest: record.proposal.digest,
        floor: record.proposal.floor, reason: record.status === "blocked" ? record.message : undefined,
      });
      return workflowView(record);
    });
    return loaded.commit(NextResponse.json(view, { headers: { "Cache-Control": "no-store" } }));
  } catch (error) {
    if (error instanceof WorkflowConflict) {
      const message = error.message === "proposal_expired" ? "This proposal expired. Prepare a fresh plan before approving."
        : error.message === "proposal_changed" ? "This proposal changed. Refresh and approve the current plan."
          : error.message === "approval_already_consumed" ? "This proposal has already been approved or blocked. Prepare a new one."
            : "This proposal could not be approved. Prepare a new plan.";
      return loaded.commit(NextResponse.json({ code: error.message, message }, { status: 409 }));
    }
    const known = error instanceof ResearchError ? error : error instanceof Error && error.message === "workflow_not_found"
      ? new ResearchError("workflow_not_found", "This plan was not found for your account.", 404)
      : null;
    if (!known) {
      logUnexpected("approval failed", { subject: bound.sub, workflowId: id, network, error });
    }
    return loaded.commit(NextResponse.json({
      code: known?.code ?? "approval_unavailable",
      message: known?.message ?? "This plan could not be approved. Please try again.",
    }, { status: known?.status ?? 409 }));
  }
}
