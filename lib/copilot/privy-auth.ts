/**
 * Verify a Privy access token server-side, so the Privy session the browser
 * already has can act as the end-user assertion on the money path.
 *
 * Server-only. Never import from a client component.
 *
 * ## Why this exists
 *
 * The Sign Service will not accept a machine credential as "who is asking" — a
 * WorkOS M2M token's `sub` is the client id, one value shared by every user, so
 * accepting it would make `isBound(sub, wallet)` true for anybody against
 * anybody's wallet. That guard is correct and stays.
 *
 * The obvious way to satisfy it was a second, WorkOS end-user login. That cannot
 * be made invisible: a WorkOS token only carries the `aud` both verifiers check
 * when it comes out of an interactive Connect OAuth redirect, and JWT templates
 * cannot add `aud` to a headless AuthKit session token. So "log in with Privy,
 * then also log in with WorkOS" was structural, not a wiring bug.
 *
 * A Privy access token, on the other hand, is already a proper assertion:
 *
 *     iss = privy.io
 *     sub = did:privy:…      unique per user — what bindings key on
 *     aud = <the Privy app id>
 *     alg = ES256, exp ≈ 1h
 *
 * It is minted by the same system that holds the wallet, which makes it the
 * honest identity for a wallet operation: the thing that decides who owns the
 * key also says who is asking. This module verifies it the way any resource
 * server would, and the Sign Service verifies it again independently — this side
 * is never the authorization decision.
 *
 * ## Scope
 *
 * Dependency-free (Node `crypto` + `fetch`), same posture as user-auth.ts, so it
 * is unit-testable without a browser or a live Privy app.
 */

import crypto from "node:crypto";
import { copilotConfig } from "./config";

export class PrivyAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivyAuthError";
  }
}

/** The only issuer a Privy access token ever carries. */
export const PRIVY_ISSUER = "privy.io";

/** Every Privy subject starts with this — the shape the Sign Service keys on. */
export const PRIVY_SUBJECT_PREFIX = "did:privy:";

/**
 * Clock skew allowance, in seconds. Deliberately the same 30s the Sign Service
 * uses (USER_ASSERTION_CLOCK_TOLERANCE_SEC): if this side were stricter we would
 * reject tokens the authority accepts, and if it were looser we would forward
 * tokens it is about to refuse — either way the two hops disagree about the same
 * token, which is the class of bug that took a week to find the first time.
 */
export const PRIVY_CLOCK_TOLERANCE_SEC = 30;

/** JWKS cache TTL. Privy publishes two keys and rotates; a short TTL is enough. */
const JWKS_TTL_MS = 10 * 60 * 1000;

export interface PrivyIdentity {
  /** `did:privy:…` — stable per user, and what wallet bindings are keyed on. */
  sub: string;
  /** Privy session id (`sid`), when present. Useful for correlating logs. */
  sessionId?: string;
  /** Epoch ms at which the token expires. */
  expiresAt: number;
}

interface JsonWebKey {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  kid?: string;
  alg?: string;
  use?: string;
}

interface Jwks {
  keys?: JsonWebKey[];
}

const jwksCache = new Map<string, { jwks: Jwks; fetchedAt: number }>();

/** Test helper / hot-reload safety. */
export function resetPrivyJwksCache(): void {
  jwksCache.clear();
}

async function loadJwks(uri: string, fetchImpl: typeof fetch, now: number): Promise<Jwks> {
  const cached = jwksCache.get(uri);
  if (cached && now - cached.fetchedAt < JWKS_TTL_MS) return cached.jwks;

  let res: Response;
  try {
    res = await fetchImpl(uri, { cache: "no-store" });
  } catch (e) {
    throw new PrivyAuthError(
      `Could not reach the Privy JWKS endpoint (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (!res.ok) {
    throw new PrivyAuthError(`Privy JWKS endpoint returned ${res.status}`);
  }
  const jwks = (await res.json()) as Jwks;
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
    throw new PrivyAuthError("Privy JWKS response contained no keys");
  }
  jwksCache.set(uri, { jwks, fetchedAt: now });
  return jwks;
}

/**
 * Pick the signing key for this token's `kid`.
 *
 * A missing `kid` is not tolerated. Privy always sets one, and "try every key"
 * on a rotation boundary would quietly accept a token signed by a key that is no
 * longer the one we asked for.
 */
function keyForKid(jwks: Jwks, kid: string | undefined): crypto.KeyObject {
  if (!kid) throw new PrivyAuthError("Privy token header has no `kid`");
  const jwk = (jwks.keys ?? []).find((k) => k.kid === kid);
  if (!jwk) {
    throw new PrivyAuthError(
      `No Privy signing key matches kid=${kid} — the key may have rotated; retry after the JWKS cache expires`,
    );
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") {
    throw new PrivyAuthError(`Unexpected Privy key type: kty=${jwk.kty} crv=${jwk.crv}`);
  }
  try {
    return crypto.createPublicKey({
      key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } as crypto.JsonWebKey,
      format: "jwk",
    });
  } catch (e) {
    throw new PrivyAuthError(
      `Could not import the Privy signing key (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

function decodeSegment(segment: string, what: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new PrivyAuthError(`Privy token ${what} is not valid base64url JSON`);
  }
}

/**
 * Read `sub` out of a token WITHOUT verifying it.
 *
 * Used only for log correlation and cache keys, never for a decision. Any code
 * path that acts on the identity must go through verifyPrivyToken.
 */
export function peekPrivySubject(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = decodeSegment(parts[1], "payload");
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

/**
 * Verify a Privy access token and return the identity it asserts.
 *
 * Checks, in order: shape, `alg`, signature, `exp`, `iss`, `aud`, subject shape.
 * Signature before claims, because a token whose claims look right but whose
 * signature is wrong is an attack, and validating claims first would put
 * attacker-controlled values into log lines as though they were facts.
 *
 * @throws PrivyAuthError on any failure. Callers treat that as "signed out" —
 *         reads and wallet-sign writes keep working exactly as they do today.
 */
export async function verifyPrivyToken(
  token: string,
  opts: {
    now?: number;
    fetchImpl?: typeof fetch;
    /** Override the app id (defaults to config). Tests use this. */
    appId?: string;
    /** Override the JWKS URI (defaults to config). Tests use this. */
    jwksUri?: string;
  } = {},
): Promise<PrivyIdentity> {
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const appId = opts.appId ?? copilotConfig.privyAppId;
  const jwksUri = opts.jwksUri ?? copilotConfig.privyJwksUri;

  if (!appId) {
    throw new PrivyAuthError(
      "NEXT_PUBLIC_PRIVY_APP_ID is not set — cannot verify a Privy token's audience",
    );
  }
  if (!token || typeof token !== "string") {
    throw new PrivyAuthError("No Privy token supplied");
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new PrivyAuthError("Privy token is not a three-part JWS");
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = decodeSegment(headerB64, "header");
  if (header.alg !== "ES256") {
    // Never negotiate the algorithm from the token. `alg: none` and an
    // RSA-for-EC confusion are both real attacks, and Privy only ever uses ES256.
    throw new PrivyAuthError(`Unexpected Privy token alg=${String(header.alg)} (expected ES256)`);
  }

  const jwks = await loadJwks(jwksUri, fetchImpl, now);
  const key = keyForKid(jwks, typeof header.kid === "string" ? header.kid : undefined);

  const signature = Buffer.from(signatureB64, "base64url");
  // ES256 signatures are the raw r‖s pair (64 bytes), not DER — `ieee-p1363`
  // tells Node to read them that way. Without it every valid token fails.
  const signatureValid = crypto.verify(
    "sha256",
    Buffer.from(`${headerB64}.${payloadB64}`),
    { key, dsaEncoding: "ieee-p1363" },
    signature,
  );
  if (!signatureValid) {
    throw new PrivyAuthError("Privy token signature is invalid");
  }

  const claims = decodeSegment(payloadB64, "payload");

  const exp = claims.exp;
  if (typeof exp !== "number") {
    throw new PrivyAuthError("Privy token has no `exp` claim");
  }
  const nowSec = Math.floor(now / 1000);
  if (exp + PRIVY_CLOCK_TOLERANCE_SEC < nowSec) {
    throw new PrivyAuthError("Privy token has expired");
  }

  if (claims.iss !== PRIVY_ISSUER) {
    throw new PrivyAuthError(
      `Unexpected Privy token issuer: ${String(claims.iss)} (expected ${PRIVY_ISSUER})`,
    );
  }

  const aud = claims.aud;
  const presented = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  if (!presented.includes(appId)) {
    // Name both sides: a token from a *different* Privy app is the interesting
    // case, and "invalid audience" alone gives an operator nothing to act on.
    throw new PrivyAuthError(
      `Privy token audience [${presented.join(", ") || "(none)"}] does not include this app (${appId})`,
    );
  }

  const sub = claims.sub;
  if (typeof sub !== "string" || !sub.startsWith(PRIVY_SUBJECT_PREFIX)) {
    throw new PrivyAuthError(
      `Privy token subject "${String(sub)}" does not start with ${PRIVY_SUBJECT_PREFIX}`,
    );
  }

  return {
    sub,
    sessionId: typeof claims.sid === "string" ? claims.sid : undefined,
    expiresAt: exp * 1000,
  };
}
