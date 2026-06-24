import { NextResponse } from "next/server";

import { readLiveEventFeed } from "@/lib/analytics/stellar/eventFeed";

// Node runtime (Stellar SDK). The live liquidation/whale event feed is
// protocol-wide, so the ~7 RPC getEvents reads run once per 30s globally behind
// the edge cache rather than in every visitor's browser. Same pattern as
// /api/analytics/accounts.
export const runtime = "nodejs";

export async function GET() {
  try {
    const feed = await readLiveEventFeed();
    return NextResponse.json(feed, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "analytics event feed failed";
    return NextResponse.json(
      { error: "analytics_events_failed", detail },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
