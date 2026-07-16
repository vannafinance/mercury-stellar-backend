import { NextRequest, NextResponse } from "next/server";

// Server-side proxy for the Vanna Copilot Orchestrator (the "brain").
//
// WHY this exists: the orchestrator is a separate service (Python/FastAPI) that
// runs on its own host/port. The browser never talks to it directly — it calls
// this same-origin route, and we forward to the orchestrator server-side. This
// keeps CORS out of the picture and gives us one place to add auth/rate-limiting
// later, exactly like the Mercury proxy (see app/api/mercury/route.ts).
//
// Env (server-only — NO NEXT_PUBLIC_ prefix):
//   COPILOT_URL   Base URL of the orchestrator. Defaults to http://127.0.0.1:8000
//                 for local dev. Set it in .env.local to point at a deployed brain.
//                 NOTE: we use 127.0.0.1 (not "localhost") on purpose — Node can
//                 resolve "localhost" to IPv6 ::1 first, while uvicorn binds to
//                 IPv4 127.0.0.1, which would fail with ECONNREFUSED.

export const runtime = "nodejs";

const COPILOT_URL = process.env.COPILOT_URL ?? "http://127.0.0.1:8000";

// Shape the orchestrator's POST /chat expects (mirrors app/schemas.py ChatRequest).
interface ChatRequestBody {
  user_id?: unknown;
  message?: unknown;
  tier?: unknown;
}

export async function POST(req: NextRequest) {
  let body: ChatRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { kind: "error", message: "Invalid JSON body." },
      { status: 400 },
    );
  }

  if (typeof body.message !== "string" || body.message.trim() === "") {
    return NextResponse.json(
      { kind: "error", message: "Missing `message` string." },
      { status: 400 },
    );
  }

  const payload = {
    user_id: typeof body.user_id === "string" && body.user_id ? body.user_id : "guest",
    message: body.message,
    tier: body.tier === "paid" ? "paid" : "free",
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${COPILOT_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // The brain is a trusted first-party service; keep the request server-side.
      cache: "no-store",
    });
  } catch {
    // Orchestrator unreachable (not running / wrong URL). Return a friendly,
    // typed error so the UI renders a normal error bubble, never a crash.
    return NextResponse.json(
      {
        kind: "error",
        message:
          "Copilot is offline. Start the orchestrator (uvicorn app.main:app --port 8000) " +
          "or set COPILOT_URL, then try again.",
      },
      { status: 502 },
    );
  }

  const json = await upstream.json().catch(() => ({
    kind: "error",
    message: `Copilot returned a non-JSON response (HTTP ${upstream.status}).`,
  }));

  return NextResponse.json(json, { status: upstream.ok ? 200 : upstream.status });
}
