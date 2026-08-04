/**
 * Bridge between a Next.js request and the sealed user session.
 *
 * Kept separate from user-auth.ts so that module stays framework-free (and
 * therefore unit-testable without mocking NextRequest).
 *
 * ## Refresh happens here, once, at the edge of the request
 *
 * A route handler is the only place that holds both the incoming cookie and the
 * outgoing response, so it is the only place that can rotate a refresh token and
 * persist the result. Refreshing lazily deeper in the call stack would mint a new
 * token and then have nowhere to store it — the next request would come back with
 * the old one and refresh again, burning a rotation every call.
 *
 * So: refresh up front if the token is close to expiry, bind it for the request,
 * and let a token that lapses mid-turn be handled by session-scoped signing on
 * the Sign Service side rather than by racing it here.
 */

import type { NextRequest, NextResponse } from "next/server";
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

export interface LoadedUser {
  session: UserSession | null;
  /** The ambient identity to bind for this request, or null when signed out. */
  bound: BoundUser | null;
  /**
   * Write any cookie change onto the response: a rotated session after refresh,
   * or a cleared cookie when the refresh token is dead. Always call this, even
   * when `session` is null — that null may BE the change.
   */
  commit<T extends NextResponse>(res: T): T;
}

const noChange = <T extends NextResponse>(res: T): T => res;

export async function loadUserFromRequest(req: NextRequest): Promise<LoadedUser> {
  const stored = unseal<UserSession>(req.cookies.get(SESSION_COOKIE)?.value);
  if (!stored?.accessToken || !stored.sub) {
    return { session: null, bound: null, commit: noChange };
  }

  const secure = req.nextUrl.protocol === "https:";

  if (!needsRefresh(stored)) {
    return {
      session: stored,
      bound: { sub: stored.sub, email: stored.email, accessToken: stored.accessToken },
      commit: noChange,
    };
  }

  // Expiring or expired — try to refresh. `resource` is re-sent inside
  // refreshSession so the new token keeps the `aud` both verifiers require.
  try {
    const refreshed = await refreshSession(stored);
    return {
      session: refreshed,
      bound: { sub: refreshed.sub, email: refreshed.email, accessToken: refreshed.accessToken },
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
      commit: (res) => {
        res.cookies.delete(SESSION_COOKIE);
        return res;
      },
    };
  }
}
