import { NextRequest, NextResponse } from "next/server";

import { getAllPoolStats } from "@/lib/pool-stats";

// Node runtime (Stellar SDK). Pool stats are identical for every user, so the
// edge cache hit-rate is high — short TTL so post-supply/withdraw UIs catch up
// within ~1–2s instead of waiting on a 30s CDN window.
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const pools = await getAllPoolStats();
    // `?fresh=1` is used by post-tx resync — bypass CDN so the client sees
    // the just-confirmed supply/withdraw totals immediately.
    const fresh = req.nextUrl.searchParams.get("fresh") === "1";
    return NextResponse.json(pools, {
      headers: {
        "Cache-Control": fresh
          ? "no-store"
          : "public, s-maxage=5, stale-while-revalidate=30",
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "pool stats failed";
    return NextResponse.json(
      { error: "pool_stats_failed", detail },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
