/**
 * Bridge between a Next.js request and the end-user identity it carries.
 *
 * Kept separate from user-auth.ts / privy-auth.ts so those modules stay
 * framework-free (and therefore unit-testable without mocking NextRequest).
 *
 * ## Two anchors, one mechanism
 *
 * Either identity system can prove the caller, and whichever does, its token
 * leaves this app the same way: as `X-Vanna-User-Assertion`, alongside the
 * unchanged M2M bearer.
 *
 *   Privy  (default)  the session the user already has from getting a wallet.
 *                     Nothing extra to click — the browser sends its access
 *                     token, this verifies it, and `sub` is `did:privy:…`.
 *   WorkOS (optional) the Connect OAuth login in app/api/auth/*. Still supported,
 *                     no longer required.
 *
 * Privy is tried FIRST when both are present. The Privy session is the one tied
 * to the wallet the transaction actually spends from, so if the two ever
 * disagree, the wallet's own identity is the truthful answer.
 *
 * ## Refresh happens here, once, at the edge of the request
 *
 * A route handler is the only place that holds both the incoming cookie and the
 * outgoing response, so it is the only place that can rotate a WorkOS refresh
 * token and persist the result. Refreshing lazily deeper in the call stack would
 * mint a new token and then have nowhere to store it — the next request would
 * come back with the old one and refresh again, burning a rotation every call.
 *
 * Privy needs none of that: the browser owns that session and sends a live token
 * with each turn, so there is nothing for this side to refresh or store.
 */

import type { NextRequest, NextResponse } from "next/server";
import { copilotConfig } from "./config";
import { PRIVY_TOKEN_HEADER } from "./identity-header";
import { PrivyAuthError, verifyPrivyToken } from "./privy-auth";
import {
  SESSION_COOKIE,
  cookieOptions,
  needsRefresh,
  refreshSession,
  seal,
  unseal,
  type UserSession,
} from "./user-auth";
import type { BoundUser } from "./user-context";

const SESSION_COOKIE_MAX_AGE = 30 * 24 * 3600;

/** Cookie Privy sets when cookie storage is enabled — a fallback for callers
 * that post to this API without going through the client helper. */
export const PRIVY_TOKEN_COOKIE = "privy-token";

/**
 * What happened to the Privy token on this request — for diagnostics only.
 *
 * Exists because "not signed in" has two completely different causes and they need
 * completely different fixes: the browser never sent a token (client wiring), or it
 * sent one that was refused (expired, wrong app, rotated key). A single boolean
 * cannot tell them apart, and that ambiguity is what makes an identity bug take a
 * week instead of a minute.
 */
export interface PrivyAttempt {
  tokenPresent: boolean;
  /** Where it came from, when it was present. */
  source?: "header" | "cookie";
  /** Why it was refused. Absent when it verified, or when none was sent. */
  error?: string;
}

export interface LoadedUser {
  /** The WorkOS session, when that is what authenticated this request. */
  session: UserSession | null;
  /** The ambient identity to bind for this request, or null when signed out. */
  bound: BoundUser | null;
  /** Diagnostic trace of the Privy attempt. Never contains the token itself. */
  privy: PrivyAttempt;
  /**
   * Write any cookie change onto the response: a rotated WorkOS session after
   * refresh, or a cleared cookie when the refresh token is dead. Always call
   * this, even when `session` is null — that null may BE the change.
   */
  commit<T extends NextResponse>(res: T): T;
}

const noChange = <T extends NextResponse>(res: T): T => res;

/** The Privy token on this request, from the header or Privy's own cookie. */
function privyTokenFrom(req: NextRequest): { token: string; source: "header" | "cookie" } | null {
  const header = req.headers.get(PRIVY_TOKEN_HEADER);
  if (header && header.trim()) return { token: header.trim(), source: "header" };
  const cookie = req.cookies.get(PRIVY_TOKEN_COOKIE)?.value;
  if (cookie && cookie.trim()) return { token: cookie.trim(), source: "cookie" };
  return null;
}

async function loadPrivyUser(
  req: NextRequest,
): Promise<{ user: BoundUser | null; attempt: PrivyAttempt }> {
  if (!copilotConfig.privyIdentityEnabled) {
    return { user: null, attempt: { tokenPresent: false, error: "privy_not_configured" } };
  }
  const found = privyTokenFrom(req);
  if (!found) return { user: null, attempt: { tokenPresent: false } };

  try {
    const identity = await verifyPrivyToken(found.token);
    return {
      user: { sub: identity.sub, accessToken: found.token, kind: "privy" },
      attempt: { tokenPresent: true, source: found.source },
    };
  } catch (e) {
    // Never throw into a request path. An unverifiable token means "signed out":
    // reads still work on the M2M credential and writes still fall back to
    // wallet-sign, which is exactly the behaviour before this existed.
    //
    // Logged at warn because in production this should be rare, and when it is
    // not rare it is the single most useful line for diagnosing why auto-sign
    // stopped working — an expired token, a rotated key, or the wrong app id.
    const detail = e instanceof PrivyAuthError ? e.message : String(e);
    console.warn(
      `[privy-auth] ${JSON.stringify({ event: "assertion_rejected", source: found.source, detail })}`,
    );
    return { user: null, attempt: { tokenPresent: true, source: found.source, error: detail } };
  }
}

export async function loadUserFromRequest(req: NextRequest): Promise<LoadedUser> {
  const { user: privyUser, attempt: privy } = await loadPrivyUser(req);
  if (privyUser) {
    return { session: null, bound: privyUser, privy, commit: noChange };
  }

  const stored = unseal<UserSession>(req.cookies.get(SESSION_COOKIE)?.value);
  if (!stored?.accessToken || !stored.sub) {
    return { session: null, bound: null, privy, commit: noChange };
  }

  const secure = req.nextUrl.protocol === "https:";

  if (!needsRefresh(stored)) {
    return {
      session: stored,
      bound: {
        sub: stored.sub,
        email: stored.email,
        accessToken: stored.accessToken,
        kind: "workos",
      },
      privy,
      commit: noChange,
    };
  }

  // Expiring or expired — try to refresh. `resource` is re-sent inside
  // refreshSession so the new token keeps the `aud` both verifiers require.
  try {
    const refreshed = await refreshSession(stored);
    return {
      session: refreshed,
      bound: {
        sub: refreshed.sub,
        email: refreshed.email,
        accessToken: refreshed.accessToken,
        kind: "workos",
      },
      privy,
      commit: (res) => {
        res.cookies.set(
          SESSION_COOKIE,
          seal(refreshed),
          cookieOptions(SESSION_COOKIE_MAX_AGE, secure),
        );
        return res;
      },
    };
  } catch (e) {
    // Refresh token revoked or expired. Drop the cookie so the UI shows signed
    // out and offers a fresh login, instead of retrying a dead token every call.
    console.warn(
      `[user-auth] refresh failed for ${stored.sub}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return {
      session: null,
      bound: null,
      privy,
      commit: (res) => {
        res.cookies.delete(SESSION_COOKIE);
        return res;
      },
    };
  }
}
