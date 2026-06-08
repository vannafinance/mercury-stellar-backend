// Thin client for Mercury. Talks to our OWN /api/mercury* proxies
// (same-origin) — the Mercury JWT lives only on the server, so it never
// reaches the browser bundle.
//
// Two paths:
//   - mercuryQuery()        → GraphQL via /api/mercury        (general queries)
//   - fetchContractEvents() → REST via /api/mercury/events    (contract events,
//     Mercury Classic — no subscription needed, full history)

import { xdr, scValToNative } from "@stellar/stellar-sdk";

export interface MercuryGraphQLError {
  message: string;
}

interface MercuryResponse<T> {
  data?: T;
  errors?: MercuryGraphQLError[];
}

/** True when the env is wired (used to gate Mercury-backed hooks). */
export const isMercuryEnabled = (): boolean =>
  // The proxy reports misconfig as a 500 with an error; this is a cheap
  // client-side hint so callers can fall back to RPC without a round-trip.
  typeof window !== "undefined";

export async function mercuryQuery<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch("/api/mercury", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });

  const json = (await res.json().catch(() => null)) as MercuryResponse<T> | null;

  if (!json) {
    throw new Error(`Mercury proxy returned non-JSON (HTTP ${res.status}).`);
  }
  if (json.errors?.length) {
    throw new Error(`Mercury query failed: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (json.data === undefined) {
    throw new Error("Mercury query returned no data.");
  }
  return json.data;
}

// ─── Contract events (Mercury Classic REST) ──────────────────────────────────

/** Raw event row as returned by /rest/events/by-ledger/contracts. */
export interface RawMercuryEvent {
  id: number;
  contract_id: string;
  topic1?: string;
  topic2?: string;
  topic3?: string;
  topic4?: string;
  topic5?: string;
  topic6?: string;
  topic7?: string;
  topic8?: string;
  topic9?: string;
  topic10?: string;
  data?: string;
  tx?: string;
}

export interface DecodedMercuryEvent {
  id: number;
  contractId: string;
  tx?: string;
  /** topic1 decoded — the event name, e.g. "Trader_Borrow". */
  eventName: string | null;
  /** topic2 decoded — usually the account/address the event is keyed by. */
  account: string | null;
  /** all non-empty topics, decoded from XDR. */
  topics: unknown[];
  /** the event payload (data), decoded from XDR (object, symbol, bigint…). */
  data: unknown;
}

const decodeScVal = (b64?: string): unknown => {
  if (!b64) return undefined;
  try {
    return scValToNative(xdr.ScVal.fromXDR(b64, "base64"));
  } catch {
    return undefined;
  }
};

/** Decode one raw Mercury event row (base64 XDR topics + data) into natives. */
export const decodeMercuryEvent = (e: RawMercuryEvent): DecodedMercuryEvent => {
  const topics = [
    e.topic1, e.topic2, e.topic3, e.topic4, e.topic5,
    e.topic6, e.topic7, e.topic8, e.topic9, e.topic10,
  ]
    .filter((t): t is string => Boolean(t))
    .map(decodeScVal);
  return {
    id: e.id,
    contractId: e.contract_id,
    tx: e.tx,
    eventName: typeof topics[0] === "string" ? topics[0] : null,
    account: typeof topics[1] === "string" ? topics[1] : null,
    topics,
    data: decodeScVal(e.data),
  };
};

async function fetchEventsPage(
  params: URLSearchParams,
): Promise<RawMercuryEvent[]> {
  const res = await fetch(`/api/mercury/events?${params.toString()}`);
  const json = (await res.json().catch(() => null)) as
    | RawMercuryEvent[]
    | { events?: RawMercuryEvent[]; data?: RawMercuryEvent[]; error?: string }
    | null;
  if (!json) throw new Error(`Mercury events: non-JSON response (HTTP ${res.status}).`);
  if (!Array.isArray(json) && json.error) {
    throw new Error(`Mercury events failed: ${json.error}`);
  }
  return Array.isArray(json) ? json : json.events ?? json.data ?? [];
}

/**
 * Fetch + decode a contract's events from Mercury Classic, scoped to one
 * `account` server-side (Mercury matches the encoded address in any topic
 * column) and walking the FULL history via cursor pagination.
 *
 * No subscription needed. Goes through our /api/mercury/events proxy (JWT
 * server-side). Mercury returns newest→oldest, capped at `limit`; we pass the
 * last event's `id` as `cursor` until a short/empty page (no more history).
 */
export async function fetchContractEvents(opts: {
  /** Single contract whose events to read (path param to /rest/events/by-contract). */
  contract: string;
  /** Filter to one account server-side (encoded → `topics` by the proxy). */
  account?: string;
  /** Page size (default 100). */
  limit?: number;
  /** Safety cap on pages walked (default 50 → up to limit*50 events). */
  maxPages?: number;
}): Promise<DecodedMercuryEvent[]> {
  const limit = opts.limit ?? 100;
  const maxPages = opts.maxPages ?? 50;
  const all: DecodedMercuryEvent[] = [];
  let cursor: number | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({ contract: opts.contract, limit: String(limit) });
    if (opts.account) params.set("account", opts.account);
    if (cursor != null) params.set("cursor", String(cursor));

    const raw = await fetchEventsPage(params);
    all.push(...raw.map(decodeMercuryEvent));

    if (raw.length < limit) break; // short page → end of history
    cursor = raw[raw.length - 1].id; // bookmark = oldest id in this page
  }

  return all;
}
