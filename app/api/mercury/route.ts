import { NextRequest, NextResponse } from "next/server";

// Server-side proxy for Mercury's GraphQL API.
// WHY this exists: the Mercury JWT must never reach the browser bundle. The
// client calls this route (same-origin) and we attach the token here, so the
// secret stays server-side. It's also the natural place to add caching /
// rate-limiting later. See CLAUDE.md "Mercury" notes.
//
// Env (server-only — NO NEXT_PUBLIC_ prefix):
//   MERCURY_URL  e.g. https://api.mercurydata.app/graphql
//   MERCURY_KEY  the JWT, sent as `Authorization: Bearer <key>`

export const runtime = "nodejs";

const MERCURY_URL = process.env.MERCURY_URL;
const MERCURY_KEY = process.env.MERCURY_KEY;

export async function POST(req: NextRequest) {
  if (!MERCURY_URL || !MERCURY_KEY) {
    return NextResponse.json(
      { errors: [{ message: "Mercury is not configured (MERCURY_URL / MERCURY_KEY missing)." }] },
      { status: 500 },
    );
  }

  let body: { query?: unknown; variables?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ errors: [{ message: "Invalid JSON body." }] }, { status: 400 });
  }

  if (typeof body.query !== "string") {
    return NextResponse.json({ errors: [{ message: "Missing `query` string." }] }, { status: 400 });
  }

  const upstream = await fetch(MERCURY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MERCURY_KEY}`,
    },
    body: JSON.stringify({ query: body.query, variables: body.variables ?? {} }),
  });

  const json = await upstream.json().catch(() => ({
    errors: [{ message: `Mercury returned non-JSON (HTTP ${upstream.status}).` }],
  }));

  return NextResponse.json(json, { status: upstream.ok ? 200 : upstream.status });
}
