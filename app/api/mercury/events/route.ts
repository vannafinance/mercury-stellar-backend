import { NextRequest, NextResponse } from "next/server";
import { Address, xdr } from "@stellar/stellar-sdk";

// Server-side proxy for Mercury Classic's REST events endpoint.
//   GET /api/mercury/events?contracts=<csv>&from=<ledger>&to=<ledger>&account=<C…>&limit=<n>
// forwards to {REST_BASE}/rest/events/by-ledger/contracts with the Bearer key
// attached server-side (JWT never reaches the browser).
//
// Scale/scope hardening:
//   - `limit` is passed through (Mercury caps responses ~100; we raise it so
//     full history is returned). Default 1000.  TODO: real pagination / Mercury
//     `by-topics` endpoint when volume outgrows a single high-limit page.
//   - `account` filters events to a single account SERVER-SIDE (Mercury's
//     by-ledger endpoint ignores topic filters), so the browser only ever
//     receives that account's events — smaller payload + no other accounts' data
//     on the client. The account lives in topic2 as a base64-XDR Address ScVal.

export const runtime = "nodejs";

const MERCURY_URL = process.env.MERCURY_URL;
const MERCURY_KEY = process.env.MERCURY_KEY;
const REST_BASE = MERCURY_URL?.replace(/\/graphql\/?$/, "");

const DEFAULT_LIMIT = "1000";

// Encode a contract/account address as the base64-XDR ScVal Address that Mercury
// stores in topic2. Returns null for malformed input.
function accountTopicXdr(account: string): string | null {
  try {
    return xdr.ScVal.scvAddress(new Address(account).toScAddress()).toXDR("base64");
  } catch {
    return null;
  }
}

interface RawEvent {
  topic2?: string;
  [k: string]: unknown;
}

export async function GET(req: NextRequest) {
  if (!REST_BASE || !MERCURY_KEY) {
    return NextResponse.json(
      { error: "Mercury is not configured (MERCURY_URL / MERCURY_KEY missing)." },
      { status: 500 },
    );
  }

  const sp = req.nextUrl.searchParams;
  const contracts = sp.get("contracts");
  const from = sp.get("from");
  const to = sp.get("to");
  const account = sp.get("account");
  const limit = sp.get("limit") ?? DEFAULT_LIMIT;

  if (!contracts) {
    return NextResponse.json({ error: "Missing `contracts` query param." }, { status: 400 });
  }

  const url = new URL(`${REST_BASE}/rest/events/by-ledger/contracts`);
  url.searchParams.set("contracts", contracts);
  if (from) url.searchParams.set("from", from);
  if (to) url.searchParams.set("to", to);
  url.searchParams.set("limit", limit);

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

  // Server-side account filter (Mercury can't filter by topic on this endpoint).
  if (account && Array.isArray(json)) {
    const want = accountTopicXdr(account);
    if (want) {
      const filtered = (json as RawEvent[]).filter((e) => e.topic2 === want);
      return NextResponse.json(filtered, { status: 200 });
    }
  }

  return NextResponse.json(json, { status: 200 });
}
