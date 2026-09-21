import { NextRequest, NextResponse } from "next/server";
import { loadUserFromRequest } from "@/lib/copilot/request-user";
import { withBoundUser } from "@/lib/copilot/user-context";
import { getMcpClient } from "@/lib/copilot/mcp-client";
import { copilotConfig } from "@/lib/copilot/config";
import { ResearchError, resolveInvestigationScope } from "@/lib/copilot/investigation/scope";
import { validateProposal, workflowJournal } from "@/lib/copilot/investigation/proposal";
import { logUnexpected } from "@/lib/copilot/log";

/**
 * Does the plan on screen still hold?
 *
 * A proposal is sized from reads taken at one moment and then waits for a person. While it
 * waits the world moves: the price the amount was converted at drops, the funds it spends
 * are spent elsewhere, the health projection stops clearing the floor. Approve already
 * re-checks all of that — but only at the click, which is too late to be information. This
 * route runs the same check while the card waits, so a plan that no longer holds can be
 * withdrawn with the reason instead of sitting there looking executable.
 *
 * It is a read. It never approves, never advances and never writes to the journal: the
 * answer is what the card should say, and Approve remains the only authority on what runs.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = req.headers.get("origin");
  if (origin && copilotConfig.publicOrigin && origin !== copilotConfig.publicOrigin) {
    return NextResponse.json({ message: "Request origin was refused." }, { status: 403 });
  }
  const { id } = await params;
  if (!/^[a-f0-9-]{36}$/.test(id)) {
    return NextResponse.json({ code: "invalid_request", message: "This route takes a plan id only." }, { status: 400 });
  }
  const loaded = await loadUserFromRequest(req);
  if (!loaded.bound) {
    return loaded.commit(NextResponse.json({ code: "sign_in_required", message: "Sign in to check a plan for your connected account." }, { status: 401 }));
  }
  const secret = process.env.COPILOT_RESEARCH_SECRET?.trim() || copilotConfig.sessionSecret;
  const network = process.env.COPILOT_RESEARCH_NETWORK?.trim() || "testnet";
  if (process.env.COPILOT_RESEARCH_ENABLED === "false" || secret.length < 32 || network !== "testnet") {
    return loaded.commit(NextResponse.json({ code: "research_not_configured", message: "Investigation is not available on this deployment yet." }, { status: 503 }));
  }
  const bound = loaded.bound;
  try {
    const outcome = await withBoundUser(bound, async () => {
      const journal = workflowJournal(secret);
      const stored = await journal.lookup(id, bound.sub);
      const record = stored.value;
      // Only a plan still waiting for a person can be withdrawn. Once it is approved the
      // journal owns what happens next, and a read here must not contradict it.
      if (record.status !== "proposed") return { fresh: true as const };
      const expected = record.proposal.scope;
      if (record.proposal.server !== copilotConfig.mcpBaseUrl || expected.network !== network) {
        return { fresh: false as const, reason: "The execution environment changed. Prepare a new plan." };
      }
      if (record.proposal.expiresAt <= Date.now()) {
        return { fresh: false as const, reason: "This plan expired before it was approved. Prepare a fresh one." };
      }
      const scope = await resolveInvestigationScope({
        subject: bound.sub, wallet: expected.trader, network,
      }, getMcpClient(), AbortSignal.any([req.signal, AbortSignal.timeout(20_000)]));
      if (scope.subject !== expected.subject || scope.trader !== expected.trader
        || scope.smartAccount !== expected.smartAccount || scope.network !== expected.network) {
        return { fresh: false as const, reason: "The connected account changed. Prepare a new plan for this account." };
      }
      const reason = await validateProposal(record.proposal);
      return reason ? { fresh: false as const, reason } : { fresh: true as const };
    });
    return loaded.commit(NextResponse.json(outcome, { headers: { "Cache-Control": "no-store" } }));
  } catch (error) {
    const known = error instanceof ResearchError ? error
      : error instanceof Error && error.message === "workflow_not_found"
        ? new ResearchError("workflow_not_found", "This plan was not found for your account.", 404)
        : null;
    if (!known) logUnexpected("plan recheck failed", { subject: bound.sub, workflowId: id, network, error });
    /**
     * A check that could not be made is not a plan that failed. Saying "fresh" here keeps a
     * transient read error from withdrawing a good plan; Approve re-checks for real anyway.
     */
    return loaded.commit(NextResponse.json({ fresh: true, unchecked: known?.code ?? "recheck_unavailable" }, {
      status: 200, headers: { "Cache-Control": "no-store" },
    }));
  }
}
