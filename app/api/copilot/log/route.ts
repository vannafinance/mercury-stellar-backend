// Forwards a write's on-chain outcome to the brain's /log endpoint so the
// execution shows up in the copilot log, tied to the turn's request_id.
// Fire-and-forget from the UI after Privy sign + submit. Never blocks the user.

import { NextRequest, NextResponse } from "next/server";

const COPILOT_URL = process.env.COPILOT_URL ?? "http://127.0.0.1:8000";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    await fetch(`${COPILOT_URL}/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    // logging must never surface an error to the user
  }
  return NextResponse.json({ ok: true });
}
