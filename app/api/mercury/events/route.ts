import { NextRequest, NextResponse } from "next/server";
import { Address, xdr } from "@stellar/stellar-sdk";

// Server-side proxy for Mercury Classic's per-contract events endpoint.
//   GET /api/mercury/events?contract=<C>&account=<C>&limit=100&cursor=<id>
// forwards to {REST_BASE}/rest/events/by-contract/<contract> with the Bearer key
// attached server-side (JWT never reaches the browser).
//
// Per-account filtering is done BY MERCURY: passing `account` encodes it to an
// ScVal Address (base64 XDR) and sends it as `topics=` — Mercury matches it in
// any topic column (our account lives in topic2), returning only that account's
// events. No global pull + client/server filtering.
//
// Pagination: Mercury caps each response at `limit` and returns events newest→
// oldest (descending id). The client walks history by passing the last event's
// `id` as `cursor` on the next call (see lib/mercury-client.ts fetchContractEvents).

export const runtime = "nodejs";

const MERCURY_URL = process.env.MERCURY_URL;
const MERCURY_KEY = process.env.MERCURY_KEY;
const REST_BASE = MERCURY_URL?.replace(/\/graphql\/?$/, "");

const DEFAULT_LIMIT = "100";

// Encode an account/contract address as the base64-XDR ScVal Address Mercury
// stores in its topic columns. Returns null for malformed input.
function accountTopicXdr(account: string): string | null {
  try {
    return xdr.ScVal.scvAddress(new Address(account).toScAddress()).toXDR("base64");
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  if (!REST_BASE || !MERCURY_KEY) {
    return NextResponse.json(
      { error: "Mercury is not configured (MERCURY_URL / MERCURY_KEY missing)." },
      { status: 500 },
    );
  }

  const sp = req.nextUrl.searchParams;
  const contract = sp.get("contract");
  const account = sp.get("account");
  const limit = sp.get("limit") ?? DEFAULT_LIMIT;
  const cursor = sp.get("cursor");

  if (!contract) {
    return NextResponse.json({ error: "Missing `contract` query param." }, { status: 400 });
  }

  const url = new URL(`${REST_BASE}/rest/events/by-contract/${contract}`);
  url.searchParams.set("limit", limit);
  if (cursor) url.searchParams.set("cursor", cursor);
  if (account) {
    const topics = accountTopicXdr(account);
    if (!topics) {
      return NextResponse.json({ error: "Invalid `account` address." }, { status: 400 });
    }
    url.searchParams.set("topics", topics);
  }

  const upstream = await fetch(url, {
    headers: { Authorization: `Bearer ${MERCURY_KEY}` },
  });

  const json = await upstream.json().catch(() => null);
  if (!upstream.ok || json === null) {
    return NextResponse.json(
      { error: `Mercury returned ${upstream.status}.` },
      { status: upstream.ok ? 502 : upstream.status },
    );
  }

  return NextResponse.json(json, { status: 200 });
}
