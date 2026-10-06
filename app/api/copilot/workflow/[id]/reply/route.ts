import { NextRequest, NextResponse } from "next/server";
import { loadUserFromRequest } from "@/lib/copilot/request-user";
import { copilotConfig } from "@/lib/copilot/config";
import { workflowJournal } from "@/lib/copilot/investigation/proposal";
import { workflowView } from "@/lib/copilot/workflow/types";
import { researchCodec } from "@/lib/copilot/investigation/continuation";
import { compareObservedRates } from "@/lib/copilot/investigation/rate-comparison";
import { completionReply } from "@/lib/copilot/investigation/completion";
import { composeCompletion } from "@/lib/copilot/investigation/compose";
import { computeAccountPosition } from "@/lib/copilot/investigation/capacity";
import { executionReceiptFromWorkflowView } from "@/lib/copilot/execution-receipt";
import { completionMatches, completionPlainText, receiptKey, settledTransactions, type WorkflowCompletionReply } from "@/lib/copilot/workflow-completion";
import { readConversation, updateSessionWorkflowCompletion } from "@/lib/copilot/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long the health factor read after a run may take before the reply goes without it. */
const HEALTH_READ_MS = 5_000;

/**
 * The finished run's reply, composed by the model around the run's own facts (compose.ts).
 *
 * Every figure is the server's: the settled steps come from the journal for the signed-in
 * account, rates from the sealed research evidence (read only after its seal and subject
 * are verified), and the health factor from a fresh Margin-page read. The browser sends no
 * figures. 204 means "keep the reply you already show".
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = req.headers.get("origin");
  if (origin && copilotConfig.publicOrigin && origin !== copilotConfig.publicOrigin) return NextResponse.json({ message: "Request origin was refused." }, { status: 403 });
  const { id } = await params;
  if (!/^[a-f0-9-]{36}$/.test(id)) return NextResponse.json({ message: "Invalid plan reference." }, { status: 400 });
  const loaded = await loadUserFromRequest(req);
  if (!loaded.bound) return loaded.commit(NextResponse.json({ message: "Sign in to see this plan." }, { status: 401 }));
  const body = await req.json().catch(() => ({})) as { continuation?: unknown; conversationId?: unknown };
  try {
    const secret = process.env.COPILOT_RESEARCH_SECRET?.trim() || copilotConfig.sessionSecret;
    const stored = await workflowJournal(secret).lookup(id, loaded.bound.sub);
    if (stored.value.proposal.server !== copilotConfig.mcpBaseUrl) throw new Error("environment_changed");
    const view = workflowView(stored.value);
    const receipt = executionReceiptFromWorkflowView(view, stored.value.proposal.scope.network);
    const transactions = settledTransactions(receipt);
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
    // This transition is optional for legacy callers; incomplete runs keep their recovery UI.
    if (conversationId) {
      if (!transactions) return loaded.commit(new NextResponse(null, { status: 204 }));
      const conversation = await readConversation(loaded.bound.sub, conversationId);
      const owner = conversation?.turns.find((turn) => turn.role === "assistant" && turn.executionReceipt?.workflowId === id);
      if (!owner?.executionReceipt || receiptKey(owner.executionReceipt) !== receiptKey(receipt)) {
        return loaded.commit(NextResponse.json({ message: "The receipt is not recorded on this conversation." }, { status: 409 }));
      }
      if (completionMatches(receipt, owner.completion) && owner.blocks?.length) {
        return loaded.commit(NextResponse.json({ message: owner.text, replyBlocks: owner.blocks, receipt, completion: owner.completion }, { headers: { "Cache-Control": "no-store" } }));
      }
    }

    let comparisons: ReturnType<typeof compareObservedRates> = [];
    if (typeof body.continuation === "string" && body.continuation.length < 200_000) {
      try {
        const prior = researchCodec(secret, copilotConfig.mcpBaseUrl).read(body.continuation);
        if (prior.scope.subject === loaded.bound.sub && prior.evidence) {
          comparisons = compareObservedRates(prior.evidence.observations, prior.evidence.capturedAt);
        }
      } catch { /* an expired or foreign continuation just means no rates */ }
    }
    const draft = completionReply(view, { comparisons });
    if (!draft) return loaded.commit(new NextResponse(null, { status: 204 }));

    const signal = req.signal;
    const finalTransaction = transactions?.reduce((latest, transaction) => transaction.ledger > latest.ledger ? transaction : latest);
    const position = await Promise.race([
      computeAccountPosition(stored.value.proposal.scope.smartAccount, AbortSignal.any([signal, AbortSignal.timeout(HEALTH_READ_MS)]), finalTransaction?.hash).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), HEALTH_READ_MS)),
    ]);
    const composed = await composeCompletion({
      view, request: view.objective, draft, comparisons, healthNow: position?.healthFactor ?? null,
      ...(position ? { positionNow: { grossCollateralUsd: position.grossCollateralUsd, debtUsd: position.debtUsd, observedAt: Date.now() } } : {}),
    }, signal);
    if (conversationId && transactions) {
      const reply: WorkflowCompletionReply = {
        message: completionPlainText(composed?.message ?? draft, receipt),
        replyBlocks: composed?.blocks ?? [{ type: "paragraph", segments: [{ text: draft }] }],
        receipt, completion: { workflowId: id, receiptKey: receiptKey(receipt), generatedAt: Date.now(), source: composed ? "model" : "fallback" },
      };
      // Recheck the journal after composition: a late result cannot replace a changed run.
      const current = await workflowJournal(secret).lookup(id, loaded.bound.sub);
      if (receiptKey(executionReceiptFromWorkflowView(workflowView(current.value), current.value.proposal.scope.network)) !== reply.completion.receiptKey ||
        !await updateSessionWorkflowCompletion({ subject: loaded.bound.sub, conversationId, reply })) {
        return loaded.commit(new NextResponse(null, { status: 409 }));
      }
      return loaded.commit(NextResponse.json(reply, { headers: { "Cache-Control": "no-store" } }));
    }
    if (!composed) return loaded.commit(new NextResponse(null, { status: 204 }));
    return loaded.commit(NextResponse.json({ message: composed.message, replyBlocks: composed.blocks }, { headers: { "Cache-Control": "no-store" } }));
  } catch {
    return loaded.commit(new NextResponse(null, { status: 204 }));
  }
}
