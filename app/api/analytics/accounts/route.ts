import { NextResponse } from "next/server";

import { fetchAllMarginAccountSnapshots } from "@/lib/analytics/stellar/allMarginAccounts";

// Node runtime (Stellar SDK). The protocol-wide margin-account scan is identical
// for every viewer, so it belongs behind a shared edge cache: the bounded RPC
// fan-out (concurrency 8, 200-account cap) then runs ~once per 30s GLOBALLY
// instead of in every analytics visitor's browser. Mirrors /api/pools and
// /api/account/[addr] (the D25 edge-cache pattern).
export const runtime = "nodejs";

export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get("force") === "1";
  try {
    const { accounts } = await fetchAllMarginAccountSnapshots({ force });
    // JSON cannot represent Infinity — a no-debt account's health factor is
    // Number.POSITIVE_INFINITY — so wire it as a marker string; the client
    // restores it after parsing.
    const body = JSON.stringify({ accounts }, (_k, v) =>
      typeof v === "number" && !Number.isFinite(v) ? "Infinity" : v,
    );
    return new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": force
          ? "no-store"
          : "public, s-maxage=30, stale-while-revalidate=120",
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "account scan failed";
    return NextResponse.json(
      { error: "analytics_accounts_failed", detail },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
