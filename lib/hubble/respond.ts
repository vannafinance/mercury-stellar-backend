import { NextResponse } from "next/server";

import { isHubbleConfigured, runQuery } from "./client";
import { isStatsEnabled } from "./gate";

// Shared handler for the Hubble analytics routes: returns a cached JSON array
// on success, a clean 503 while the credential is missing, and a 502 on query
// failure. The cache header lets Vercel's CDN serve the heavy query's result
// for 5 min (and a stale copy for 15 more) so the SQL runs ~once per window.
export async function hubbleJson(
  query: string,
  params?: Record<string, unknown>,
): Promise<NextResponse> {
  // Feature gate: the analytics routes don't exist unless explicitly enabled.
  if (!isStatsEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!isHubbleConfigured()) {
    return NextResponse.json(
      { error: "hubble_not_configured", detail: "GOOGLE_CREDS_JSON is not set" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const rows = await runQuery(query, params);
    return NextResponse.json(rows, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900" },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "query failed";
    return NextResponse.json(
      { error: "hubble_query_failed", detail },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
