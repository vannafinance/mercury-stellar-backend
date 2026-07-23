// Copilot proxy → orchestrator "brain" (Phase 1: READ-only).
//
// The browser never talks to the brain directly; this server route forwards to
// it. Two operations:
//   GET  /api/copilot        → { health }          (is the brain up? which LLM/MCP?)
//   POST /api/copilot        → forwards a chat turn → { kind, message, intent }
//
// COPILOT_URL overrides the brain base URL. We default to 127.0.0.1 (NOT
// "localhost") on purpose — Node may resolve "localhost" to IPv6 ::1 first while
// uvicorn binds IPv4 127.0.0.1, which would fail with ECONNREFUSED.
//
// This route is intentionally READ-only for Phase 1: it forwards the message and
// returns the brain's answer. The brain declines write intents itself; no signing
// or on-chain path exists here yet.

import { NextRequest, NextResponse } from "next/server";

const COPILOT_URL = process.env.COPILOT_URL ?? "http://127.0.0.1:8000";
const OFFLINE = {
  message:
    "Copilot is offline. Start the orchestrator (uvicorn app.main:app --port 8000) " +
    "or set COPILOT_URL, then try again.",
};

export async function GET() {
  try {
    const res = await fetch(`${COPILOT_URL}/health`, { cache: "no-store" });
    const health = await res.json();
    return NextResponse.json({ health });
  } catch {
    return NextResponse.json({ health: null, error: OFFLINE.message }, { status: 200 });
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ kind: "error", message: "Invalid request body." }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json({ kind: "error", message: "Please type a question." }, { status: 400 });
  }

  const payload = {
    user_id: typeof body.user_id === "string" && body.user_id ? body.user_id : "guest",
    message,
    tier: body.tier === "paid" ? "paid" : "free",
    smart_account: typeof body.smart_account === "string" ? body.smart_account : null,
  };

  try {
    const upstream = await fetch(`${COPILOT_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    const data = await upstream.json();
    return NextResponse.json(data, { status: upstream.ok ? 200 : upstream.status });
  } catch {
    return NextResponse.json({ kind: "error", message: OFFLINE.message }, { status: 200 });
  }
}
