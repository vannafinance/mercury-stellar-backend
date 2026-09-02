/**
 * GET /api/auth/session — who is signed in, for the UI.
 *
 * Never returns the access token. The browser has no use for it: every call that
 * needs it is made server-side, and shipping it to the client would put a
 * money-path credential somewhere any script on the page can read.
 */

import { NextRequest, NextResponse } from "next/server";
import { copilotConfig } from "@/lib/copilot/config";
import { loadUserFromRequest } from "@/lib/copilot/request-user";
import { acceptedUserAudiences, peekTokenClaims } from "@/lib/copilot/user-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const loaded = await loadUserFromRequest(req);
  const session = loaded.session;

  // A Privy session authenticates without a WorkOS cookie, so `session` is null
  // while `bound` is not. Reporting signedIn:false there would be wrong, and this
  // endpoint is exactly where someone looks to find out why auto-sign is refused.
  if (!session && loaded.bound?.kind === "privy") {
    return loaded.commit(
      NextResponse.json({
        signedIn: true,
        anchor: "privy",
        sub: loaded.bound.sub,
        subjectIsEndUser: loaded.bound.sub.startsWith("did:privy:"),
        privyAppId: copilotConfig.privyAppId || null,
        privyJwksUri: copilotConfig.privyJwksUri,
        /**
         * The Sign Service must have this app's Privy id as an accepted audience
         * (it does by default — same app whose wallets it signs) and must not be
         * running PRIVY_USER_ASSERTION=off.
         */
        note:
          "Writes carry this Privy token to the MCP as X-Vanna-User-Assertion. " +
          "No WorkOS login is needed.",
        /** The optional second anchor, for direct MCP clients. */
        workosLoginEnabled: copilotConfig.userLoginEnabled,
      }),
    );
  }

  if (!session) {
    return loaded.commit(
      NextResponse.json({
        signedIn: false,
        /**
         * Why a signed-out answer is not necessarily a problem: a visitor with no
         * Privy session reads everything on the shared M2M credential, and a write
         * still builds — it just falls back to signing in the wallet.
         */
        privyIdentityEnabled: copilotConfig.privyIdentityEnabled,
        /**
         * Two very different problems, told apart:
         *   tokenPresent false → the browser sent nothing (client wiring, or the
         *                        user genuinely has no Privy session)
         *   tokenPresent true + privyError → it arrived and was refused, and the
         *                        error says why (expired, wrong app, rotated key)
         */
        privyTokenSeen: loaded.privy.tokenPresent,
        privyTokenSource: loaded.privy.source ?? null,
        privyError: loaded.privy.error ?? null,
        loginEnabled: copilotConfig.userLoginEnabled,
        loginUrl: copilotConfig.userLoginEnabled ? "/api/auth/login" : null,
      }),
    );
  }

  // Surface the audience so a misconfigured client is visible here rather than
  // only as a 401 during someone's first auto-signed transaction.
  //
  // THREE audiences are legitimate — see acceptedUserAudiences(). Which one you
  // get depends on the client type, and for this hand-created Connect OAuth app
  // it is the WorkOS ENVIRONMENT client id, not the Connect app's own id.
  //
  // This endpoint is diagnostic only. `audienceMatchesMcp` answers "will the
  // Sign Service's WORKOS_AUDIENCE accept this token's aud" — it is NOT the
  // authorization decision, and a `true` here does not mean the caller is a
  // user. The M2M credential shares the environment audience, so `sub` is the
  // only thing that separates them; `subjectIsEndUser` below is that check, and
  // the Sign Service enforces the same rule server-side.
  const aud = peekTokenClaims(session.accessToken).aud ?? [];
  const accepted = acceptedUserAudiences();
  const matched = aud.filter((a) => accepted.includes(a));

  return loaded.commit(
    NextResponse.json({
      signedIn: true,
      anchor: "workos",
      loginEnabled: true,
      sub: session.sub,
      email: session.email ?? null,
      expiresAt: session.expiresAt,
      audience: aud,
      /**
       * False → the Sign Service will refuse this token on audience grounds.
       * Add whichever value appears in `audience` to its WORKOS_AUDIENCE.
       */
      audienceMatchesMcp: matched.length > 0,
      /** Which accepted audience(s) this token actually carries. */
      matchedAudiences: matched,
      acceptedAudiences: accepted,
      /**
       * The real gate. An M2M token would carry the same environment audience,
       * so this — not the audience — is what makes the token an end user's.
       */
      subjectIsEndUser: session.sub.startsWith("user_"),
      expectedResource: copilotConfig.mcpResource,
      connectClientId: copilotConfig.workosClientIdUser || null,
      envClientId: copilotConfig.workosEnvClientId || null,
      /** Whether this deployment sends the RFC 8707 resource indicator. */
      sendsResourceIndicator: copilotConfig.mcpSendResource,
    }),
  );
}
