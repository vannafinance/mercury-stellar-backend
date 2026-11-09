import { NextResponse } from "next/server";

import { fetchAllMarginAccountSnapshots } from "@/lib/analytics/stellar/allMarginAccounts";

// Node runtime (Stellar SDK). The protocol-wide margin-account scan is identical
// for every viewer, so it belongs behind a shared edge cache: the bounded RPC
// fan-out then runs ~once per 30s GLOBALLY instead of in every analytics
// visitor's browser. Mirrors /api/pools and /api/account/[addr] (the D25
// edge-cache pattern).
export const runtime = "nodejs";

/**
 * test.vanna.finance's Stellar app reads the SAME contracts and keeps a
 * ready-made snapshot of every funded margin account (scheduled scan +
 * Firestore + an event-driven positions table). A full scan here has to read
 * ~700 accounts × ~12 calls through rate-limited public RPCs inside one
 * request, which runs past Cloud Run's 300s timeout. So the snapshot comes
 * from there first — both sites then show exactly the same accounts and
 * totals — and this app's own scan is only the fallback.
 * Set STELLAR_ANALYTICS_UPSTREAM_URL="" to always scan locally.
 */
const UPSTREAM_URL =
  process.env.STELLAR_ANALYTICS_UPSTREAM_URL ?? "https://test.vanna.finance/api/stellar/analytics/accounts";

type UpstreamBody = { accounts: unknown[]; openCount?: number };

async function readUpstream(): Promise<UpstreamBody | null> {
  if (!UPSTREAM_URL) return null;
  try {
    const res = await fetch(UPSTREAM_URL, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<UpstreamBody>;
    if (!Array.isArray(body.accounts) || body.accounts.length === 0) return null;
    return { accounts: body.accounts, openCount: body.openCount };
  } catch (err) {
    console.warn("[analytics/accounts] upstream snapshot unavailable; scanning locally:", err);
    return null;
  }
}

export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get("force") === "1";
  const cacheControl = force ? "no-store" : "public, s-maxage=30, stale-while-revalidate=120";

  const upstream = await readUpstream();
  if (upstream) {
    // Already JSON-safe (no-debt health factors arrive as the "Infinity" marker).
    return new Response(JSON.stringify(upstream), {
      headers: { "Content-Type": "application/json", "Cache-Control": cacheControl, "X-Analytics-Source": "test.vanna.finance" },
    });
  }

  try {
    const { accounts } = await fetchAllMarginAccountSnapshots({ force });
    // JSON cannot represent Infinity — a no-debt account's health factor is
    // Number.POSITIVE_INFINITY — so wire it as a marker string; the client
    // restores it after parsing.
    const body = JSON.stringify({ accounts }, (_k, v) =>
      typeof v === "number" && !Number.isFinite(v) ? "Infinity" : v,
    );
    return new Response(body, {
      headers: { "Content-Type": "application/json", "Cache-Control": cacheControl, "X-Analytics-Source": "local-scan" },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "account scan failed";
    return NextResponse.json(
      { error: "analytics_accounts_failed", detail },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
