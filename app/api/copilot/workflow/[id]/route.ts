import { NextRequest, NextResponse } from "next/server";
import { loadUserFromRequest } from "@/lib/copilot/request-user";
import { copilotConfig } from "@/lib/copilot/config";
import { workflowJournal } from "@/lib/copilot/investigation/proposal";
import { workflowView } from "@/lib/copilot/workflow/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One explicit read on reload or refresh. No background listener and no execution. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-f0-9-]{36}$/.test(id)) return NextResponse.json({ message: "Invalid plan reference." }, { status: 400 });
  const loaded = await loadUserFromRequest(req);
  if (!loaded.bound) return loaded.commit(NextResponse.json({ message: "Sign in to restore your plan." }, { status: 401 }));
  try {
    const secret = process.env.COPILOT_RESEARCH_SECRET?.trim() || copilotConfig.sessionSecret;
    const stored = await workflowJournal(secret).lookup(id, loaded.bound.sub);
    if (stored.value.proposal.server !== copilotConfig.mcpBaseUrl || stored.value.proposal.scope.network !== "testnet")
      throw new Error("environment_changed");
    return loaded.commit(NextResponse.json(workflowView(stored.value), { headers: { "Cache-Control": "no-store" } }));
  } catch {
    return loaded.commit(NextResponse.json({ message: "This plan could not be restored for the signed-in account." }, { status: 409 }));
  }
}

/** Cancels unsent steps only; the journal refuses to pretend an in-flight write vanished. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) return NextResponse.json({ message: "Request origin was refused." }, { status: 403 });
  const { id } = await params;
  if (!/^[a-f0-9-]{36}$/.test(id)) return NextResponse.json({ message: "Invalid plan reference." }, { status: 400 });
  const loaded = await loadUserFromRequest(req);
  if (!loaded.bound) return loaded.commit(NextResponse.json({ message: "Sign in to cancel this plan." }, { status: 401 }));
  try {
    const secret = process.env.COPILOT_RESEARCH_SECRET?.trim() || copilotConfig.sessionSecret;
    const journal = workflowJournal(secret);
    const stored = await journal.lookup(id, loaded.bound.sub);
    if (stored.value.proposal.server !== copilotConfig.mcpBaseUrl) throw new Error("environment_changed");
    const record = await journal.cancel(id, { scope: stored.value.proposal.scope, server: copilotConfig.mcpBaseUrl });
    const { appendAudit } = await import("@/lib/copilot/audit-log");
    void appendAudit({
      at: Date.now(), subject: loaded.bound.sub, action: "cancelled",
      workflowId: record.proposal.id, digest: record.proposal.digest,
      floor: record.proposal.floor,
    });
    return loaded.commit(NextResponse.json(workflowView(record), { headers: { "Cache-Control": "no-store" } }));
  } catch {
    return loaded.commit(NextResponse.json({ message: "This plan could not be cancelled. An in-flight transaction must be reconciled first." }, { status: 409 }));
  }
}
