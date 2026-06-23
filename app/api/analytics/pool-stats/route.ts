import { NextResponse } from "next/server";

import { readAllPoolStats } from "@/lib/analytics/stellar/rpcReader";

// Node runtime (Stellar SDK). Analytics pool stats are protocol-wide (identical
// for every viewer), so the RPC read runs once per 30s globally behind the edge
// cache instead of in every visitor's browser. Same pattern as /api/pools and
// /api/analytics/accounts.
export const runtime = "nodejs";

export async function GET() {
  try {
    const pools = await readAllPoolStats();
    return NextResponse.json(pools, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "analytics pool stats failed";
    return NextResponse.json(
      { error: "analytics_pool_stats_failed", detail },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
