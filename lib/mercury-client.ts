// Thin GraphQL client for Mercury. Talks to our OWN /api/mercury proxy
// (same-origin) — the Mercury JWT lives only on the server (see
// app/api/mercury/route.ts), so it never reaches the browser bundle.
//
// Usage:
//   const data = await mercuryQuery<MyShape>(MY_QUERY, { contractId });

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
