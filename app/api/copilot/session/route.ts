import { NextRequest, NextResponse } from "next/server";
import { loadUserFromRequest } from "@/lib/copilot/request-user";
import { appendDirectSessionTurn, closeActiveConversation, listConversations, readConversation } from "@/lib/copilot/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/**
 * The conversation list and the one that is open — what the page paints on load. The
 * open conversation's transcript, evidence token and last view come along so the thread
 * is restored in one round-trip, as it was when the store held a single thread.
 */
export async function GET(req: NextRequest) {
  const loaded = await loadUserFromRequest(req);
  if (!loaded.bound) {
    return loaded.commit(NextResponse.json({ message: "Sign in to keep your conversations." }, { status: 401 }));
  }
  try {
    const { conversations, activeId } = await listConversations(loaded.bound.sub);
    const active = activeId ? await readConversation(loaded.bound.sub, activeId) : null;
    return loaded.commit(NextResponse.json({
      conversations,
      activeId,
      turns: active?.turns ?? [],
      continuation: active?.continuation ?? null,
      result: active?.result ?? null,
    }, NO_STORE));
  } catch (error) {
    console.warn("[copilot/session] failed to read conversations:", error instanceof Error ? error.message : error);
    return loaded.commit(NextResponse.json({
      conversations: [],
      activeId: null,
      turns: [],
      continuation: null,
      result: null,
    }, NO_STORE));
  }
}

/** "New chat": close the open conversation. Nothing is created until the first turn. */
export async function DELETE(req: NextRequest) {
  const loaded = await loadUserFromRequest(req);
  if (!loaded.bound) {
    return loaded.commit(NextResponse.json({ message: "Sign in to keep your conversations." }, { status: 401 }));
  }
  try {
    await closeActiveConversation(loaded.bound.sub);
  } catch (error) {
    console.warn("[copilot/session] failed to close conversation:", error instanceof Error ? error.message : error);
  }
  return loaded.commit(NextResponse.json({ activeId: null }, NO_STORE));
}

/** Store a direct Copilot exchange without touching the model or execution pipeline. */
export async function POST(req: NextRequest) {
  const loaded = await loadUserFromRequest(req);
  if (!loaded.bound) {
    return loaded.commit(NextResponse.json({ message: "Sign in to keep your conversations." }, { status: 401 }));
  }
  let body: unknown;
  try { body = await req.json(); } catch {
    return loaded.commit(NextResponse.json({ message: "Invalid conversation turn." }, { status: 400 }));
  }
  const payload = body && typeof body === "object" ? body as Record<string, unknown> : null;
  const user = typeof payload?.user === "string" ? payload.user.trim() : "";
  const assistant = typeof payload?.assistant === "string" ? payload.assistant.trim() : "";
  const conversationId = typeof payload?.conversationId === "string" ? payload.conversationId : null;
  if (!user || !assistant || user.length > 8_000 || assistant.length > 32_000) {
    return loaded.commit(NextResponse.json({ message: "Invalid conversation turn." }, { status: 400 }));
  }
  try {
    const recorded = await appendDirectSessionTurn({ subject: loaded.bound.sub, conversationId, user, assistant });
    return loaded.commit(NextResponse.json({ conversationId: recorded.id }, NO_STORE));
  } catch (error) {
    console.warn("[copilot/session] failed to append turn:", error instanceof Error ? error.message : error);
    return loaded.commit(NextResponse.json({ conversationId: null }, NO_STORE));
  }
}
