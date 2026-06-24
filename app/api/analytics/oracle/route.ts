import { NextResponse } from "next/server";

import { readOracleSnapshot } from "@/lib/analytics/stellar/rpcReader";

// Node runtime (Stellar SDK). The oracle price snapshot is protocol-wide, so the
// RPC read runs once per 30s globally behind the edge cache rather than in every
// visitor's browser. Same pattern as /api/analytics/accounts.
export const runtime = "nodejs";

export async function GET() {
  try {
    const oracle = await readOracleSnapshot();
    return NextResponse.json(oracle, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "analytics oracle snapshot failed";
    return NextResponse.json(
      { error: "analytics_oracle_failed", detail },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
