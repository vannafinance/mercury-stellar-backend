/**
 * The header that carries the browser's Privy session to our own API, and the
 * one helper that attaches it.
 *
 * Isolated in its own module because BOTH sides need it and they cannot share a
 * file: the server side (request-user.ts) imports `node:crypto` through the
 * verifier, and pulling that into a client component would break the bundle.
 * Everything here is dependency-free and safe on either side.
 *
 * ## Why the browser sends this at all
 *
 * A copilot write ends at the Sign Service, which will only act on a token that
 * speaks for a person. The session that proves the person is the Privy one the
 * user already has — so the browser hands its access token to our server, our
 * server verifies it, and it travels on to the Sign Service as the end-user
 * assertion. No second login, and no long-lived credential kept anywhere: Privy
 * refreshes the token, and each request carries whatever is current.
 */

/** Request header the Privy access token travels on. */
export const PRIVY_TOKEN_HEADER = "x-privy-token";

/**
 * Headers for a POST to /api/copilot, including the Privy assertion when the
 * user has a session.
 *
 * Resolves to plain JSON headers when signed out — every copilot read works for
 * an anonymous visitor and must keep working.
 *
 * Deliberately re-read per request rather than captured once: Privy rotates the
 * access token about hourly, and a stale one is rejected by the Sign Service in
 * the middle of a transaction, which is the worst possible place to discover it.
 */
export async function copilotRequestHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    // Imported lazily so this module stays safe to import from server code paths
    // that must never pull in the wallet adapter.
    const { getPrivyIdentityToken } = await import("@/lib/wallet-adapter");
    const token = await getPrivyIdentityToken();
    if (token) headers[PRIVY_TOKEN_HEADER] = token;
  } catch {
    /* No Privy session, or the adapter isn't loaded — send plain headers. */
  }
  return headers;
}
