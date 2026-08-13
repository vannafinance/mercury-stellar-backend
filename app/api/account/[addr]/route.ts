import { NextResponse } from "next/server";

import { MarginAccountService } from "@/lib/margin-utils";
import { computeMarginSnapshot } from "@/lib/account-snapshot";

// Node runtime: the Stellar SDK reads need Node APIs. Responses are explicitly
// no-store because balances are mutation-sensitive and user-specific.
export const runtime = "nodejs";

// Account balances are mutation-sensitive and user-specific. CDN caching made
// a confirmed transaction appear stale for up to 15 seconds after invalidation.
const CACHE = "private, no-store, max-age=0";

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
