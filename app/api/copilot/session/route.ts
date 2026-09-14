import { NextRequest, NextResponse } from "next/server";
import { loadUserFromRequest } from "@/lib/copilot/request-user";
import { closeActiveConversation, listConversations, readConversation } from "@/lib/copilot/session-store";

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
  const { conversations, activeId } = await listConversations(loaded.bound.sub);
  const active = activeId ? await readConversation(loaded.bound.sub, activeId) : null;
  return loaded.commit(NextResponse.json({
    conversations,
    activeId,
    turns: active?.turns ?? [],
    continuation: active?.continuation ?? null,
    result: active?.result ?? null,
  }, NO_STORE));
}

/** "New chat": close the open conversation. Nothing is created until the first turn. */
export async function DELETE(req: NextRequest) {
  const loaded = await loadUserFromRequest(req);
  if (!loaded.bound) {
    return loaded.commit(NextResponse.json({ message: "Sign in to keep your conversations." }, { status: 401 }));
  }
  await closeActiveConversation(loaded.bound.sub);
  return loaded.commit(NextResponse.json({ activeId: null }, NO_STORE));
}
