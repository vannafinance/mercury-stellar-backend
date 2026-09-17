import { NextRequest, NextResponse } from "next/server";
import { loadUserFromRequest } from "@/lib/copilot/request-user";
import { deleteConversation, openConversation } from "@/lib/copilot/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
const ID = /^[A-Za-z0-9-]{1,64}$/;

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
