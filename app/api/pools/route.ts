import { NextResponse } from "next/server";

import { computeAllPoolStats } from "@/lib/pool-stats";

// Node runtime (Stellar SDK). Pool stats are identical for every user, so the
// edge cache hit-rate is high — longer TTL than the per-account snapshot.
export const runtime = "nodejs";

export async function GET() {
  try {
    const pools = await computeAllPoolStats();
    return NextResponse.json(pools, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "pool stats failed";
    return NextResponse.json(
      { error: "pool_stats_failed", detail },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
