import { NextRequest, NextResponse } from "next/server";
import { loadUserFromRequest } from "@/lib/copilot/request-user";
import { withBoundUser } from "@/lib/copilot/user-context";
import { withTokenSubject } from "@/lib/copilot/token-budget";
import { getMcpClient } from "@/lib/copilot/mcp-client";
import { copilotConfig } from "@/lib/copilot/config";
import { createFlashResearchModel } from "@/lib/copilot/investigation/flash";
import { researchTurn, type ResearchInput } from "@/lib/copilot/investigation/service";
import { ResearchError } from "@/lib/copilot/investigation/scope";
import { isRecord } from "@/lib/copilot/investigation/decision";
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
  if (!isRecord(body) || Object.keys(body).some((key) => !["message", "wallet", "continuation", "history"].includes(key)) ||
    typeof body.message !== "string" || !body.message.trim() || body.message.length > 8000 ||
    !(body.wallet == null || typeof body.wallet === "string" && body.wallet.length <= 56) ||
    !(body.continuation == null || typeof body.continuation === "string" && body.continuation.length <= 65_536) ||
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
  return { message: body.message.trim(), wallet: body.wallet as string | null ?? null, continuation: body.continuation as string | null ?? null, history };
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) return NextResponse.json({ message: "Request origin was refused." }, { status: 403 });
  let input: ResearchInput;
  try { input = await inputFrom(req); } catch (error) {
    const known = error instanceof ResearchError ? error : new ResearchError("invalid_request", "Invalid research request.", 400);
    return NextResponse.json({ code: known.code, message: known.message }, { status: known.status });
  }
  const loaded = await loadUserFromRequest(req);
  const bound = loaded.bound;
  const subject = bound?.sub ?? "guest";
  const request_id = crypto.randomUUID();
  const secret = process.env.COPILOT_RESEARCH_SECRET?.trim() || copilotConfig.sessionSecret;
  const network = process.env.COPILOT_RESEARCH_NETWORK?.trim() || "testnet";
  if (process.env.COPILOT_RESEARCH_ENABLED === "false" || secret.length < 32 || network !== "testnet") {
    return loaded.commit(NextResponse.json({ code: "research_not_configured", message: "Investigation is not available on this deployment yet." }, { status: 503 }));
  }
  const abort = new AbortController();
  const signal = AbortSignal.any([req.signal, abort.signal]);
  // Reply guaranteed inside the client's window, so the client never times out first.
  const timer = setTimeout(() => onDeadline(), 75_000);
  /**
   * Assigned by the stream below. The deadline has to be able to SAY it expired:
   * `send` refuses to write once the signal is aborted, so aborting first swallowed the
   * error event and the client saw nothing but a closed stream — surfaced to the user as
   * "the connection closed before the investigation finished", which names the wrong
   * cause and suggests the wrong remedy. The message goes out first, then the cancel.
   */
  let onDeadline = () => abort.abort();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: ResearchStreamEvent) => {
        if (closed || signal.aborted) return;
        try { controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`)); } catch { closed = true; abort.abort(); }
      };
      onDeadline = () => {
        send({
          type: "error", code: "research_deadline",
          message: "The investigation ran out of time before it could finish. Nothing was executed — please try again.",
        });
        abort.abort();
      };
      void withBoundUser(bound, () => withTokenSubject(subject, async () => {
        try {
          const result = await researchTurn(input, {
            subject, server: copilotConfig.mcpBaseUrl, network, secret,
            mcp: getMcpClient(), model: createFlashResearchModel(), signal,
            onProgress: (event) => send({ type: "progress", event }),
          });
          send({ type: "result", result });
        } catch (error) {
          const known = error instanceof ResearchError ? error : null;
          if (!known) {
            console.error("[copilot] investigation failed", {
              request_id, subject, network,
              error: error instanceof Error
                ? { name: error.name, message: error.message, stack: error.stack }
                : String(error),
            });
          }
          send({ type: "error", code: known?.code ?? "research_unavailable", message: known?.message ?? "I couldn't reach the information needed for this investigation. Please try again." });
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
}
