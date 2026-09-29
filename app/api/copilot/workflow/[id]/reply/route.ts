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
  const body = await req.json().catch(() => ({})) as { continuation?: unknown };
  try {
    const secret = process.env.COPILOT_RESEARCH_SECRET?.trim() || copilotConfig.sessionSecret;
    const stored = await workflowJournal(secret).lookup(id, loaded.bound.sub);
    if (stored.value.proposal.server !== copilotConfig.mcpBaseUrl) throw new Error("environment_changed");
    const view = workflowView(stored.value);

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
    const position = await Promise.race([
      computeAccountPosition(stored.value.proposal.scope.smartAccount, AbortSignal.any([signal, AbortSignal.timeout(HEALTH_READ_MS)])).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), HEALTH_READ_MS)),
    ]);
    const composed = await composeCompletion({
      view, request: view.objective, draft, comparisons, healthNow: position?.healthFactor ?? null,
    }, signal);
    if (!composed) return loaded.commit(new NextResponse(null, { status: 204 }));
    return loaded.commit(NextResponse.json({ message: composed.message, replyBlocks: composed.blocks }, { headers: { "Cache-Control": "no-store" } }));
  } catch {
    return loaded.commit(new NextResponse(null, { status: 204 }));
  }
}
