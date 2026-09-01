/**
 * End-user login for the Copilot — Connect OAuth (authorization code + PKCE)
 * with an RFC 8707 `resource` indicator.
 *
 * Server-only. Never import from a client component.
 *
 * ## Why this exists
 *
 * The app authenticates to the MCP with a WorkOS M2M credential. That works for
 * reads, but an M2M token's `sub` is the CLIENT id — one value shared by every
 * user of this app — so it cannot stand in as "who is asking" on a money path.
 * The Sign Service now refuses it outright (a user assertion's `sub` must start
 * with `user_`), which is what closes the F3 impersonation hole.
 *
 * ## Why an OAuth flow, and what `aud` comes out of it
 *
 * A plain AuthKit session token has the right `sub` but **no `aud` claim at all**,
 * so it clears neither the MCP's verifier nor the Sign Service's. An OAuth
 * authorization-code flow is what produces a token with an audience — which is
 * why this is a real login flow rather than "read the AuthKit session and forward
 * it". Which audience depends on the client type:
 *
 *   hand-created Connect OAuth app (what we have)
 *     aud = <the Copilot's client_id>      resource must NOT be sent — see below
 *     sub = user_…
 *
 *   DCR / CIMD client
 *     aud = https://mcp.vanna.finance/mcp  resource IS sent (MCP_SEND_RESOURCE=true)
 *     sub = user_…
 *
 * `sub` is identical either way, and `sub` is the part that matters: it is what
 * closes the F3 impersonation hole, what `isBound` keys on, and what the Sign
 * Service's `^user_` guard checks. The audience only says which client the token
 * was minted for, and the verifying side is configured to accept both.
 *
 * `resource` is therefore CONDITIONAL (copilotConfig.mcpSendResource, default
 * off). A hand-created Connect OAuth app answers an explicit `resource` on the
 * token endpoint with `400 invalid_target` even when the URI is registered as
 * Default — that error is exactly what broke the first live login attempt.
 *
 * ## Scope of this module
 *
 * Pure-ish and dependency-free (Node `crypto` + `fetch`, same posture as the Sign
 * Service's verifier). It builds URLs, exchanges/refreshes codes, and seals the
 * session cookie. It does NOT touch Next.js request objects — the route handlers
 * in app/api/auth/* own that, so everything here is unit-testable.
 */

import crypto from "node:crypto";
import { copilotConfig } from "./config";

export class UserAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserAuthError";
  }
}

/** Cookie holding the sealed session. */
export const SESSION_COOKIE = "vanna_user_session";
/** Short-lived cookie holding PKCE verifier + state between /login and /callback. */
export const PKCE_COOKIE = "vanna_oauth_tx";
/** PKCE transactions are abandoned far more often than completed — keep it short. */
export const PKCE_TTL_SECONDS = 600;

/** Refresh this many ms before `exp` so a token cannot expire mid-request. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface UserSession {
  /** WorkOS `sub` — always `user_…`; this is the identity bindings are keyed on. */
  sub: string;
  email?: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms at which accessToken expires. */
  expiresAt: number;
}

export interface PkceTransaction {
  state: string;
  codeVerifier: string;
  /** Where to send the browser after a successful callback. */
  returnTo: string;
  createdAt: number;
}

// ── PKCE ────────────────────────────────────────────────────────────────────

export function createCodeVerifier(): string {
  // 32 bytes → 43 base64url chars, inside RFC 7636's 43–128 range.
  return crypto.randomBytes(32).toString("base64url");
}

export function codeChallengeFor(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function createState(): string {
  return crypto.randomBytes(16).toString("base64url");
}

// ── Authorization URL ───────────────────────────────────────────────────────

/**
 * Audiences that a legitimate end-user token may carry, in this deployment.
 *
 * Three, because three things can mint one:
 *
 *   MCP_RESOURCE          a DCR/CIMD client that was sent `resource`
 *   WORKOS_CLIENT_ID      the Connect app's own client id
 *   WORKOS_ENV_CLIENT_ID  the WorkOS environment client id — what a hand-created
 *                         Connect OAuth token ACTUALLY carries, observed live
 *
 * ⚠️ The third is also the M2M token's audience. `aud` therefore does not
 * separate a user from the machine credential in this environment — `sub` does,
 * and only `sub` does. This list is a diagnostic aid and a mirror of the Sign
 * Service's WORKOS_AUDIENCE; it is NOT an authorization decision. The decision
 * is the `^user_` subject check, enforced server-side in
 * sign-service/src/api/auth-user.ts and mirrored at exchange time below.
 */
export function acceptedUserAudiences(): string[] {
  return [
    copilotConfig.mcpResource,
    copilotConfig.workosClientIdUser,
    copilotConfig.workosEnvClientId,
  ].filter(Boolean);
}

/**
 * Should this deployment send `resource`? Single source of truth for all three
 * legs of the flow — authorize, exchange, refresh — because sending it on some
 * but not others is how you get a token whose audience changes after the first
 * refresh.
 */
export function shouldSendResource(): boolean {
  return copilotConfig.mcpSendResource;
}

/** The resource value, or undefined when this client must not send one. */
function resourceParam(override?: string): string | undefined {
  if (!shouldSendResource()) return undefined;
  return override ?? copilotConfig.mcpResource;
}

/**
 * Build the authorization URL.
 *
 * `resource` is included only when MCP_SEND_RESOURCE is on. A hand-created
 * Connect OAuth client rejects it (`invalid_target`) and mints
 * `aud = client_id` instead; a DCR/CIMD client wants it and mints
 * `aud = <the MCP resource URI>`.
 */
export function buildAuthorizationUrl(input: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  /** Override the resource indicator (ignored when MCP_SEND_RESOURCE is off). */
  resource?: string;
  /** Extra scopes beyond the defaults. */
  scopes?: string[];
}): string {
  const clientId = copilotConfig.workosClientIdUser;
  if (!clientId) {
    throw new UserAuthError(
      "WORKOS_CLIENT_ID is not set — end-user login is not configured. " +
        "This is the Connect OAuth client id, not WORKOS_M2M_CLIENT_ID.",
    );
  }

  const url = new URL(copilotConfig.workosAuthorizeUrl);
  const params = url.searchParams;
  params.set("response_type", "code");
  params.set("client_id", clientId);
  params.set("redirect_uri", input.redirectUri);
  params.set("state", input.state);
  params.set("code_challenge", input.codeChallenge);
  params.set("code_challenge_method", "S256");
  // offline_access is what yields a refresh token; without it the user is thrown
  // back to a login screen every time the 30-minute access token lapses.
  params.set("scope", (input.scopes ?? ["openid", "profile", "email", "offline_access"]).join(" "));
  const resource = resourceParam(input.resource);
  if (resource) params.set("resource", resource);
  return url.toString();
}

// ── Token endpoint ──────────────────────────────────────────────────────────

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postToken(
  body: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenResponse> {
  const res = await fetchImpl(copilotConfig.workosUserTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    cache: "no-store",
  });
  let parsed: TokenResponse;
  try {
    parsed = (await res.json()) as TokenResponse;
  } catch {
    const text = await res.text().catch(() => "");
    throw new UserAuthError(
      `WorkOS token endpoint returned non-JSON (${res.status}): ${text.slice(0, 200)}`,
    );
  }
  if (!res.ok || parsed.error) {
    throw new UserAuthError(
      `WorkOS token endpoint returned ${res.status}: ${parsed.error ?? "error"}` +
        (parsed.error_description ? ` — ${parsed.error_description}` : ""),
    );
  }
  if (!parsed.access_token) {
    throw new UserAuthError("WorkOS token response has no access_token");
  }
  return parsed;
}

/** Read `sub`/`email`/`exp` out of a JWT WITHOUT verifying it.
 *
 * Safe here and only here: this token came straight from the token endpoint over
 * TLS, and it is never trusted as an authorization decision on this side — the
 * MCP and the Sign Service verify it properly. We decode purely to know which
 * user we are holding a token for and when to refresh it.
 */
export function peekTokenClaims(token: string): {
  sub?: string;
  email?: string;
  expUnix?: number;
  aud?: string[];
} {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return {};
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const rawAud = claims.aud;
    return {
      sub: typeof claims.sub === "string" ? claims.sub : undefined,
      email: typeof claims.email === "string" ? claims.email : undefined,
      expUnix: typeof claims.exp === "number" ? claims.exp : undefined,
      aud:
        typeof rawAud === "string"
          ? [rawAud]
          : Array.isArray(rawAud)
            ? rawAud.filter((a): a is string => typeof a === "string")
            : undefined,
    };
  } catch {
    return {};
  }
}

function sessionFromTokenResponse(body: TokenResponse, previous?: UserSession): UserSession {
  const accessToken = body.access_token as string;
  const claims = peekTokenClaims(accessToken);

  const sub = claims.sub ?? previous?.sub;
  if (!sub) {
    throw new UserAuthError("WorkOS access token has no `sub` claim — cannot identify the user");
  }
  if (!sub.startsWith("user_")) {
    // Catch a misconfigured client early and locally, with a message that names the
    // cause. The Sign Service would refuse this token anyway, but a 401 three hops
    // away during a transaction is a much worse place to discover it.
    throw new UserAuthError(
      `Logged in as "${sub}", which is not an end-user subject. This looks like an ` +
        "M2M/client-credentials client — check that WORKOS_CLIENT_ID is the Connect " +
        "OAuth client, not WORKOS_M2M_CLIENT_ID.",
    );
  }

  const expiresAt =
    typeof claims.expUnix === "number"
      ? claims.expUnix * 1000
      : Date.now() + (body.expires_in ?? 1800) * 1000;

  return {
    sub,
    email: claims.email ?? previous?.email,
    accessToken,
    // WorkOS may rotate the refresh token; keep the newest, fall back to the old.
    refreshToken: body.refresh_token ?? previous?.refreshToken,
    expiresAt,
  };
}

/** Exchange an authorization code for a user session. */
export async function exchangeCodeForSession(
  input: { code: string; codeVerifier: string; redirectUri: string; resource?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<UserSession> {
  const resource = resourceParam(input.resource);
  const body = await postToken(
    {
      grant_type: "authorization_code",
      client_id: copilotConfig.workosClientIdUser,
      client_secret: copilotConfig.workosClientSecretUser,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      // Omitted entirely for hand-created Connect OAuth clients: sending it there
      // returns 400 invalid_target and login never completes.
      ...(resource ? { resource } : {}),
    },
    fetchImpl,
  );
  return sessionFromTokenResponse(body);
}

/**
 * Refresh an expiring session.
 *
 * Whatever the exchange did about `resource`, this does the same — via the one
 * shared resourceParam(). The two legs must agree: sending it only on the
 * exchange would 400 here, and sending it only here would silently change the
 * audience 30 minutes after login, which is the harder failure to diagnose
 * because the session starts out working.
 */
export async function refreshSession(
  session: UserSession,
  fetchImpl: typeof fetch = fetch,
  resourceOverride?: string,
): Promise<UserSession> {
  if (!session.refreshToken) {
    throw new UserAuthError("Session has no refresh token — the user must sign in again");
  }
  const resource = resourceParam(resourceOverride);
  const body = await postToken(
    {
      grant_type: "refresh_token",
      client_id: copilotConfig.workosClientIdUser,
      client_secret: copilotConfig.workosClientSecretUser,
      refresh_token: session.refreshToken,
      ...(resource ? { resource } : {}),
    },
    fetchImpl,
  );
  return sessionFromTokenResponse(body, session);
}

/** True when the access token is expired or close enough that a call could outlive it. */
export function needsRefresh(session: UserSession, now: number = Date.now()): boolean {
  return session.expiresAt - now <= REFRESH_MARGIN_MS;
}

// ── Sealed cookie ───────────────────────────────────────────────────────────
//
// AES-256-GCM with a key derived from COPILOT_SESSION_SECRET. The cookie holds a
// live access token and a refresh token, so it is encrypted rather than merely
// signed: an httpOnly cookie is still readable by anything that can read the
// browser profile off disk, and a refresh token is a long-lived credential.

const SEAL_VERSION = "v1";

function sealKey(): Buffer {
  const secret = copilotConfig.sessionSecret;
  if (!secret) {
    throw new UserAuthError(
      "COPILOT_SESSION_SECRET is not set — cannot seal the user session cookie. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
    );
  }
  if (secret.length < 32) {
    throw new UserAuthError(
      `COPILOT_SESSION_SECRET is ${secret.length} characters; use at least 32.`,
    );
  }
  const salt = process.env.COPILOT_SESSION_SALT?.trim() || "vanna-copilot-session";
  return crypto.scryptSync(secret, salt, 32);
}

/** Largest sealed payload we will emit. Browsers cap a cookie at ~4096 bytes. */
export const MAX_COOKIE_BYTES = 3800;

export function seal(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sealKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = [
    SEAL_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");

  if (out.length > MAX_COOKIE_BYTES) {
    // Fail loudly rather than emit a cookie the browser will silently truncate or
    // drop, which would look like "login succeeded but the user is logged out".
    throw new UserAuthError(
      `Sealed session is ${out.length} bytes, over the ${MAX_COOKIE_BYTES}-byte cookie budget. ` +
        "The access token is unusually large — reduce requested scopes.",
    );
  }
  return out;
}

export function unseal<T>(sealed: string | undefined | null): T | null {
  if (!sealed) return null;
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== SEAL_VERSION) return null;
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", sealKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch {
    // Wrong key, tampering, or an older format — treat as no session, never throw
    // into a request path. The user simply appears logged out and can sign in again.
    return null;
  }
}

/** Cookie attributes shared by both cookies. */
export function cookieOptions(maxAgeSeconds: number, secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/**
 * Resolve the redirect URI for this request.
 * Configured value wins; otherwise derive from the request origin so local dev
 * and preview deploys work without another env var.
 */
export function resolveRedirectUri(requestUrl: string): string {
  const configured = copilotConfig.authRedirectUri;
  if (configured) return configured;
  return new URL("/api/auth/callback", new URL(requestUrl).origin).toString();
}

/**
 * Keep post-login redirects on this site. An open redirect on a login callback is
 * a phishing primitive: an attacker sends a victim through a genuine Vanna login
 * that lands on a page they control.
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw) return "/copilot";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/copilot";
  return raw;
}
