import { NextRequest, NextResponse } from "next/server";
import { loadUserFromRequest } from "@/lib/copilot/request-user";
import { loadSession } from "@/lib/copilot/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Restore transcript + last evidence token after a tab close on this host. */
export async function GET(req: NextRequest) {
  const loaded = await loadUserFromRequest(req);
  if (!loaded.bound) {
    return loaded.commit(NextResponse.json({ message: "Sign in to restore this thread." }, { status: 401 }));
  }
  const session = await loadSession(loaded.bound.sub);
  if (!session) {
    return loaded.commit(NextResponse.json({ turns: [], continuation: null, result: null }, {
      headers: { "Cache-Control": "no-store" },
    }));
  }
  return loaded.commit(NextResponse.json({
    turns: session.turns,
    continuation: session.continuation,
    result: session.result,
  }, { headers: { "Cache-Control": "no-store" } }));
}
