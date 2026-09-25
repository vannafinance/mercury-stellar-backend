import { NextRequest, NextResponse } from "next/server";
import { loadUserFromRequest } from "@/lib/copilot/request-user";
import { withBoundUser } from "@/lib/copilot/user-context";
import { withTokenSubject } from "@/lib/copilot/token-budget";
import { getMcpClient } from "@/lib/copilot/mcp-client";
import { copilotConfig } from "@/lib/copilot/config";
import { createFlashResearchModel } from "@/lib/copilot/investigation/flash";
import { researchTurn, type ResearchInput } from "@/lib/copilot/investigation/service";
import "@/lib/copilot/investigation/proposal";
import { ResearchError } from "@/lib/copilot/investigation/scope";
import { INVESTIGATION_MESSAGE_LIMIT } from "@/lib/copilot/domain-classifier";
import { isRecord } from "@/lib/copilot/investigation/decision";
import { logUnexpected } from "@/lib/copilot/log";
import { appendSessionTurn } from "@/lib/copilot/session-store";
import type { ResearchStreamEvent } from "@/lib/copilot/investigation/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function inputFrom(req: NextRequest): Promise<ResearchInput> {
  if (!req.body) throw new ResearchError("invalid_request", "Enter a question to investigate.", 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 96_000) { await reader.cancel(); throw new ResearchError("request_too_large", "This research request is too large.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ResearchError("invalid_request", "Invalid research request.", 400); }
  const answers = body && isRecord(body) ? body.answers : undefined;
  const amountOk = (amount: unknown) => isRecord(amount) && (amount.kind === "fraction" || amount.kind === "literal" || amount.kind === "previous_leg");
  const sectionOk = (section: unknown) => isRecord(section) && typeof section.sectionId === "string" && typeof section.asset === "string"
    && (section.venue === null || typeof section.venue === "string") && amountOk(section.amount);
  const answersOk = answers == null || (isRecord(answers) && typeof answers.questionnaireId === "string"
    && typeof answers.summary === "string" && answers.summary.trim().length > 0 && answers.summary.length <= 2000
    && (Array.isArray(answers.sections)
      ? answers.sections.length > 0 && answers.sections.every(sectionOk)
      : typeof answers.asset === "string" && (answers.venue === null || typeof answers.venue === "string") && amountOk(answers.amount)));
  if (!answersOk) throw new ResearchError("invalid_answers", "The questionnaire answer is missing an option or an amount.", 400);
  const message = isRecord(body) && typeof body.message === "string" && body.message.trim()
    ? body.message.trim()
    : isRecord(answers) && typeof answers.summary === "string" ? answers.summary.trim() : "";
  if (!isRecord(body) || Object.keys(body).some((key) => !["message", "wallet", "continuation", "session", "history", "conversationId", "answers"].includes(key)) ||
    !message || message.length > INVESTIGATION_MESSAGE_LIMIT ||
    (answers != null && (typeof body.continuation !== "string" || !body.continuation.trim())) ||
    !(body.wallet == null || typeof body.wallet === "string" && body.wallet.length <= 56) ||
    !(body.continuation == null || typeof body.continuation === "string" && body.continuation.length <= 65_536) ||
    !(body.session == null || typeof body.session === "string" && body.session.length <= 65_536) ||
    !(body.conversationId == null || typeof body.conversationId === "string" && /^[A-Za-z0-9-]{1,64}$/.test(body.conversationId)) ||
    !(body.history == null || Array.isArray(body.history) && body.history.length <= 8 && body.history.every((entry) =>
      isRecord(entry) && (entry.role === "user" || entry.role === "assistant") &&
      typeof entry.text === "string" && entry.text.trim() && entry.text.length <= 2000))) {
    throw new ResearchError("invalid_request", "Send a question and the connected wallet only. Research cannot accept execution instructions or approval payloads.", 400);
  }
  const history = Array.isArray(body.history)
    ? (body.history as Array<{ role: "user" | "assistant"; text: string }>).map((entry) => ({
        role: entry.role, text: entry.text.trim().slice(0, 2000),
      }))
    : undefined;
  return {
    message,
    wallet: body.wallet as string | null ?? null,
    continuation: body.continuation as string | null ?? null,
    ...(isRecord(answers) ? { answers: answers as unknown as NonNullable<ResearchInput["answers"]> } : {}),
    session: body.session as string | null ?? null,
    history,
    conversationId: body.conversationId as string | null ?? null,
  };
}

function deadlineBody() {
  return {
    code: "research_deadline",
    message: "The investigation ran out of time before it could finish. Nothing was executed — please try again.",
  };
}

export async function POST(req: NextRequest) {
  const request_id = crypto.randomUUID();
  const startedAt = Date.now();
  console.info("[copilot] investigate start", { request_id });
  const abort = new AbortController();
  const signal = AbortSignal.any([req.signal, abort.signal]);
  // Covers body parse and auth, not only the stream. When this sat inside start(),
  // a hang before the stream opened left the client's 120s abort as the only backstop.
  let onDeadline = () => abort.abort();
  const timer = setTimeout(() => onDeadline(), 75_000);
  const elapsed = () => Date.now() - startedAt;
  try {
    const origin = req.headers.get("origin");
    if (origin && copilotConfig.publicOrigin && origin !== copilotConfig.publicOrigin) {
      clearTimeout(timer);
      return NextResponse.json({ message: "Request origin was refused." }, { status: 403 });
    }

    let input: ResearchInput;
    try { input = await inputFrom(req); } catch (error) {
      clearTimeout(timer);
      const known = error instanceof ResearchError ? error : new ResearchError("invalid_request", "Invalid research request.", 400);
      return NextResponse.json({ code: known.code, message: known.message }, { status: known.status });
    }
    if (abort.signal.aborted) {
      clearTimeout(timer);
      console.info("[copilot] investigate deadline", { request_id, phase: "pre_stream", ms: elapsed() });
      return NextResponse.json(deadlineBody(), { status: 504 });
    }
    const loaded = await loadUserFromRequest(req);
    if (abort.signal.aborted) {
      clearTimeout(timer);
      console.info("[copilot] investigate deadline", { request_id, phase: "pre_stream", ms: elapsed() });
      return loaded.commit(NextResponse.json(deadlineBody(), { status: 504 }));
    }
    const bound = loaded.bound;
    const subject = bound?.sub ?? "guest";
    const secret = process.env.COPILOT_RESEARCH_SECRET?.trim() || copilotConfig.sessionSecret;
    const network = process.env.COPILOT_RESEARCH_NETWORK?.trim() || "testnet";
    if (process.env.COPILOT_RESEARCH_ENABLED === "false" || secret.length < 32 || network !== "testnet") {
      clearTimeout(timer);
      return loaded.commit(NextResponse.json({ code: "research_not_configured", message: "Investigation is not available on this deployment yet." }, { status: 503 }));
    }
    console.info("[copilot] investigate accepted", {
      request_id,
      signed_in: !!bound,
      has_wallet: Boolean(input.wallet),
      privy_token_present: loaded.privy.tokenPresent,
      privy_token_source: loaded.privy.source ?? null,
      privy_error: loaded.privy.error ?? null,
      ms: elapsed(),
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const enqueue = (event: ResearchStreamEvent) => {
          if (closed) return;
          try { controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`)); } catch { closed = true; }
        };
        const send = (event: ResearchStreamEvent) => {
          if (closed || (signal.aborted && event.type !== "error")) return;
          enqueue(event);
        };
        onDeadline = () => {
          enqueue({
            type: "error", code: "research_deadline",
            message: deadlineBody().message,
          });
          abort.abort();
          if (!closed) {
            closed = true;
            try { controller.close(); } catch { /* cancelled reader */ }
          }
        };
        if (abort.signal.aborted) {
          onDeadline();
          closed = true;
          try { controller.close(); } catch { /* cancelled reader */ }
          return;
        }
        void withBoundUser(bound, () => withTokenSubject(subject, async () => {
          try {
            const result = await researchTurn(input, {
              subject, server: copilotConfig.mcpBaseUrl, network, secret,
              mcp: getMcpClient(), model: createFlashResearchModel(), signal,
              onProgress: (event) => send({ type: "progress", event }),
            });
            // The turn is recorded before the result goes out, so the client learns which
            // conversation it landed in and carries that id on the next turn.
            // A store that cannot record the turn must not cost the user their answer — but a
            // silent failure would mean history quietly stops working in prod, so it is logged.
            const recorded = bound
              ? await appendSessionTurn({ subject, conversationId: input.conversationId, user: input.message, result })
                .catch((error) => { logUnexpected("conversation not recorded", { request_id, subject, error }); return null; })
              : null;
            send({ type: "result", result, ...(recorded ? { conversationId: recorded.id } : {}) });
            console.info("[copilot] investigate done", { request_id, status: result.status, ms: elapsed() });
          } catch (error) {
            const known = error instanceof ResearchError ? error : null;
            if (!known) {
              logUnexpected("investigation failed", { request_id, subject, network, error });
            }
            send({ type: "error", code: known?.code ?? "research_unavailable", message: known?.message ?? "I couldn't reach the information needed for this investigation. Please try again." });
            console.info("[copilot] investigate done", { request_id, status: known?.code ?? "error", ms: elapsed() });
          } finally {
            clearTimeout(timer);
            if (!closed) { closed = true; try { controller.close(); } catch { /* cancelled reader */ } }
          }
        }));
      },
      cancel() { clearTimeout(timer); abort.abort(); },
    });
    return loaded.commit(new NextResponse(stream, { headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no",
    } }));
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}
