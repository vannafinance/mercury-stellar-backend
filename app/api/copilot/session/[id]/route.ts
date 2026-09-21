import { NextRequest, NextResponse } from "next/server";
import { loadUserFromRequest } from "@/lib/copilot/request-user";
import { deleteConversation, openConversation, renameConversation, updateSessionExecutionReceipt } from "@/lib/copilot/session-store";
import type { ExecutionReceiptSnapshot } from "@/lib/copilot/execution-receipt";
import { WORKFLOW_OPS, type StepStatus, type WorkflowRecord } from "@/lib/copilot/workflow/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
const ID = /^[A-Za-z0-9-]{1,64}$/;
const WORKFLOW_STATUSES = new Set<WorkflowRecord["status"]>([
  "proposed", "validating", "approved", "running", "awaiting_signature", "completed", "blocked", "cancelled", "uncertain",
]);
const STEP_STATUSES = new Set<StepStatus>([
  "pending", "invoking", "awaiting_signature", "submitting", "submitted", "settled", "failed", "uncertain",
]);
const WORKFLOW_OPERATIONS = new Set<string>(WORKFLOW_OPS);
const TX_HASH = /^[a-f0-9]{64}$/i;

function isReceipt(value: unknown): value is ExecutionReceiptSnapshot {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  if (typeof receipt.workflowId !== "string" || !receipt.workflowId || receipt.workflowId.length > 128 ||
    typeof receipt.status !== "string" || !WORKFLOW_STATUSES.has(receipt.status as WorkflowRecord["status"]) ||
    typeof receipt.network !== "string" || receipt.network.length > 32 ||
    !Array.isArray(receipt.steps) || receipt.steps.length > 64) return false;
  return receipt.steps.every((value) => {
    if (!value || typeof value !== "object") return false;
    const step = value as Record<string, unknown>;
    return typeof step.operation === "string" && WORKFLOW_OPERATIONS.has(step.operation)
      && typeof step.asset === "string" && step.asset.length > 0 && step.asset.length <= 128
      && typeof step.amount === "string" && step.amount.length > 0 && step.amount.length <= 128
      && typeof step.status === "string" && STEP_STATUSES.has(step.status as StepStatus)
      && (step.txHash == null || typeof step.txHash === "string" && TX_HASH.test(step.txHash))
      && (step.settledLedger == null || typeof step.settledLedger === "number" && Number.isSafeInteger(step.settledLedger) && step.settledLedger > 0);
  });
}

/** Open one conversation: its transcript, evidence token and last view. Makes it the active one. */
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const loaded = await loadUserFromRequest(req);
  if (!loaded.bound) {
    return loaded.commit(NextResponse.json({ message: "Sign in to keep your conversations." }, { status: 401 }));
  }
  const { id } = await context.params;
  if (!ID.test(id)) return loaded.commit(NextResponse.json({ message: "That conversation does not exist." }, { status: 404 }));
  const conversation = await openConversation(loaded.bound.sub, id);
  if (!conversation) return loaded.commit(NextResponse.json({ message: "That conversation does not exist." }, { status: 404 }));
  return loaded.commit(NextResponse.json(conversation, NO_STORE));
}

/** Delete one conversation. A deleted conversation cannot be reopened; the plan journal is untouched. */
export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const loaded = await loadUserFromRequest(req);
  if (!loaded.bound) {
    return loaded.commit(NextResponse.json({ message: "Sign in to keep your conversations." }, { status: 401 }));
  }
  const { id } = await context.params;
  if (!ID.test(id) || !(await deleteConversation(loaded.bound.sub, id))) {
    return loaded.commit(NextResponse.json({ message: "That conversation does not exist." }, { status: 404 }));
  }
  return loaded.commit(NextResponse.json({ deleted: id }, NO_STORE));
}

/** Update the latest assistant turn with journal facts; repeated snapshots are idempotent. */
export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const loaded = await loadUserFromRequest(req);
  if (!loaded.bound) {
    return loaded.commit(NextResponse.json({ message: "Sign in to keep your conversations." }, { status: 401 }));
  }
  const { id } = await context.params;
  if (!ID.test(id)) return loaded.commit(NextResponse.json({ message: "That conversation does not exist." }, { status: 404 }));
  let body: unknown;
  try { body = await req.json(); } catch {
    return loaded.commit(NextResponse.json({ message: "Invalid receipt." }, { status: 400 }));
  }
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const receipt = payload?.receipt ?? payload?.executionReceipt ?? null;
  if (isReceipt(receipt)) {
    const updated = await updateSessionExecutionReceipt({ subject: loaded.bound.sub, conversationId: id, receipt });
    if (!updated) return loaded.commit(NextResponse.json({ message: "That conversation cannot accept this receipt update." }, { status: 409 }));
    return loaded.commit(NextResponse.json({ updated: true }, NO_STORE));
  }
  if (typeof payload?.title === "string") {
    if (!(await renameConversation(loaded.bound.sub, id, payload.title))) {
      return loaded.commit(NextResponse.json({ message: "That conversation does not exist." }, { status: 404 }));
    }
    return loaded.commit(NextResponse.json({ renamed: true }, NO_STORE));
  }
  return loaded.commit(NextResponse.json({ message: "Invalid receipt." }, { status: 400 }));
}
