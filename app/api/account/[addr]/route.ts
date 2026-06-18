import { NextResponse } from "next/server";

import { MarginAccountService } from "@/lib/margin-utils";
import { computeMarginSnapshot } from "@/lib/account-snapshot";

// Node runtime: the Stellar SDK reads need Node APIs. The Cache-Control header
// still gives CDN-level edge caching (s-maxage) regardless of runtime, so a
// burst of refreshes within the window is served from cache, not re-read.
export const runtime = "nodejs";

const CACHE = "public, s-maxage=15, stale-while-revalidate=60";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ addr: string }> },
) {
  const { addr } = await params;
  if (!addr || addr.length < 10) {
    return NextResponse.json(
      { error: "invalid_address" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    // `addr` may be a user G-address (resolve their margin account) or a margin
    // account C-address directly.
    const marginAccountAddress = addr.startsWith("C")
      ? addr
      : await MarginAccountService.discoverExistingAccount(addr);

    if (!marginAccountAddress) {
      return NextResponse.json(
        { hasMarginAccount: false },
        { headers: { "Cache-Control": CACHE } },
      );
    }

    const snapshot = await computeMarginSnapshot(marginAccountAddress);
    return NextResponse.json(
      { hasMarginAccount: true, marginAccountAddress, ...snapshot },
      { headers: { "Cache-Control": CACHE } },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : "snapshot failed";
    return NextResponse.json(
      { error: "snapshot_failed", detail },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
