/**
 * GET /api/auth/login — start the Connect OAuth flow.
 *
 * Redirects to WorkOS with PKCE and, critically, `resource=<MCP resource URI>`.
 * That parameter is what makes the resulting access token carry
 * `aud = https://mcp.vanna.finance/mcp`, the audience the MCP and the Sign
 * Service both verify. Without it the token has no `aud` and auto-sign 401s.
 *
 * ?return_to=/some/path — where to land after login (same-origin only).
 */

import { NextRequest, NextResponse } from "next/server";
import { copilotConfig } from "@/lib/copilot/config";
import {
  PKCE_COOKIE,
  PKCE_TTL_SECONDS,
  buildAuthorizationUrl,
  cookieOptions,
  createCodeVerifier,
  createState,
  codeChallengeFor,
  resolveRedirectUri,
  safeReturnTo,
  seal,
  type PkceTransaction,
} from "@/lib/copilot/user-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!copilotConfig.userLoginEnabled) {
    return NextResponse.json(
      {
        error: "login_not_configured",
        message:
          "End-user login is not configured. Set WORKOS_CLIENT_ID, WORKOS_CLIENT_SECRET " +
          "and COPILOT_SESSION_SECRET. Reads and wallet-sign writes work without it.",
      },
      { status: 503 },
    );
  }

  try {
    const codeVerifier = createCodeVerifier();
    const state = createState();
    const returnTo = safeReturnTo(req.nextUrl.searchParams.get("return_to"));
    const redirectUri = resolveRedirectUri(req.url);

    const authorizeUrl = buildAuthorizationUrl({
      redirectUri,
      state,
      codeChallenge: codeChallengeFor(codeVerifier),
    });

    const tx: PkceTransaction = { state, codeVerifier, returnTo, createdAt: Date.now() };
    const res = NextResponse.redirect(authorizeUrl);
    res.cookies.set(
      PKCE_COOKIE,
      seal(tx),
      cookieOptions(PKCE_TTL_SECONDS, req.nextUrl.protocol === "https:"),
    );
    return res;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "login_failed", message }, { status: 500 });
  }
}
