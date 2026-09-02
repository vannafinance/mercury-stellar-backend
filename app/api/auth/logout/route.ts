/**
 * POST /api/auth/logout — drop the local session.
 *
 * Clears this app's cookie only. It does not end the WorkOS session, so a
 * subsequent /api/auth/login may complete without a password prompt — that is
 * WorkOS's session, and ending it is a hosted-logout redirect we deliberately do
 * not perform here (it would sign the user out of every Vanna surface at once).
 */

import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/copilot/user-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
