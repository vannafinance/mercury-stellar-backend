/**
 * The name of the header that carries the browser's Privy session to our API.
 *
 * Nothing but a constant lives here, and that is the point: both sides need it,
 * and they cannot share a richer module. The server side (request-user.ts) reaches
 * `node:crypto` through the verifier, and the client side reaches the wallet
 * adapter and the Stellar SDK — importing either into the other's bundle is a bug.
 * A dependency-free constant is safe in both.
 *
 * The client helper that attaches it is `copilot-request.ts`.
 *
 * ## Why the browser sends this at all
 *
 * A copilot write ends at the Sign Service, which will only act on a token that
 * speaks for a person. The session that proves the person is the Privy one the
 * user already has — so the browser hands its access token to our server, our
 * server verifies it, and it travels on to the MCP as the end-user assertion. No
 * second login, and no long-lived credential kept anywhere: Privy refreshes the
 * token, and each request carries whatever is current.
 */

/** Request header the Privy access token travels on. */
export const PRIVY_TOKEN_HEADER = "x-privy-token";
