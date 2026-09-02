/**
 * GET /api/auth/callback — finish the Connect OAuth flow.
 *
 * Verifies the PKCE transaction, exchanges the code (again passing `resource`),
 * and seals the resulting session into an httpOnly cookie.
 *
 * The exchange refuses any token whose `sub` is not `user_…` — see
 * sessionFromTokenResponse. That is the same rule the Sign Service enforces, so
 * a misconfigured client fails here, once, with a message naming the cause,
 * rather than three hops away in the middle of somebody's transaction.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  PKCE_COOKIE,
  SESSION_COOKIE,
  cookieOptions,
  exchangeCodeForSession,
  resolveRedirectUri,
  safeReturnTo,
  seal,
  unseal,
  type PkceTransaction,
} from "@/lib/copilot/user-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Session cookie lifetime. The refresh token, not this, decides real session length. */
const SESSION_COOKIE_MAX_AGE = 30 * 24 * 3600;

function fail(req: NextRequest, reason: string, detail?: string) {
  // Land the user back on the copilot with a readable reason rather than raw JSON.
  const url = new URL("/copilot", req.nextUrl.origin);
  url.searchParams.set("auth_error", reason);
  if (detail) url.searchParams.set("auth_error_detail", detail.slice(0, 200));
  const res = NextResponse.redirect(url);
  res.cookies.delete(PKCE_COOKIE);
  return res;
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  const oauthError = params.get("error");
  if (oauthError) {
    return fail(req, oauthError, params.get("error_description") ?? undefined);
  }

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) {
    return fail(req, "missing_code_or_state");
  }

  const tx = unseal<PkceTransaction>(req.cookies.get(PKCE_COOKIE)?.value);
  if (!tx) {
    // Expired, or the cookie never arrived (third-party-cookie blocking, a
    // different browser, a stale bookmarked callback URL).
    return fail(req, "no_pkce_transaction");
  }

  // Constant-time-ish comparison is overkill for a value we minted ourselves and
  // is about to be discarded; a mismatch here is CSRF, not a guessing oracle.
  if (tx.state !== state) {
    return fail(req, "state_mismatch");
  }

  try {
    const session = await exchangeCodeForSession({
      code,
      codeVerifier: tx.codeVerifier,
      redirectUri: resolveRedirectUri(req.url),
    });

    const res = NextResponse.redirect(new URL(safeReturnTo(tx.returnTo), req.nextUrl.origin));
    res.cookies.set(
      SESSION_COOKIE,
      seal(session),
      cookieOptions(SESSION_COOKIE_MAX_AGE, req.nextUrl.protocol === "https:"),
    );
    res.cookies.delete(PKCE_COOKIE);
    return res;
  } catch (e) {
    return fail(req, "token_exchange_failed", e instanceof Error ? e.message : String(e));
  }
}
