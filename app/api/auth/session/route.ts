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

  if (!session) {
    return loaded.commit(
      NextResponse.json({
        signedIn: false,
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
