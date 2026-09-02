/**
 * Headers for a browser POST to /api/copilot.
 *
 * Client-side only — it reaches the wallet adapter, so importing this from a
 * server module would drag the Stellar SDK into a server bundle. Server code
 * wants `PRIVY_TOKEN_HEADER` from ./identity-header instead.
 *
 * ## Why this is a static import and why failures are loud
 *
 * This shipped once with a dynamic `await import()` inside a bare `catch {}`. Both
 * halves of that were wrong, and together they produced a silent, invisible
 * failure: if the adapter chunk did not resolve, or getPrivyIdentityToken threw,
 * the request went out with no assertion and NOTHING said so. Downstream, the MCP
 * fell back to forwarding its own machine credential, and the Sign Service
 * refused it with "subject is not an end user" — an error that points at the
 * wrong hop entirely. It cost a deploy cycle to find.
 *
 * So: import statically, so the adapter is part of this chunk and cannot fail to
 * load separately; and if a token cannot be obtained, say so in the console.
 * Signing out is a normal, silent case — a Privy session that exists but will not
 * yield a token is not, and that difference has to be visible.
 */

import { getPrivyIdentityToken, getPrivyAuthControls } from "@/lib/wallet-adapter";
import { PRIVY_TOKEN_HEADER } from "./identity-header";

/**
 * JSON headers plus the Privy assertion when the user has a session.
 *
 * Returns plain JSON headers when signed out — every copilot read works for an
 * anonymous visitor and must keep working.
 *
 * Deliberately re-read per request rather than captured once: Privy rotates the
 * access token about hourly, and a stale one is refused mid-transaction, which is
 * the worst possible place to discover it.
 */
export async function copilotRequestHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const token = await getPrivyIdentityToken();
    if (token) {
      headers[PRIVY_TOKEN_HEADER] = token;
    } else if (getPrivyAuthControls()?.authenticated) {
      // The distinction that matters: Privy says this user IS signed in, yet no
      // token came back. Auto-sign is about to fail for a reason the server
      // cannot see, so name it here.
      console.warn(
        "[copilot] Privy reports an authenticated session but returned no access " +
          "token — this write will not be able to auto-sign. Try signing out and in.",
      );
    }
  } catch (e) {
    console.warn(
      `[copilot] could not read the Privy access token (${
        e instanceof Error ? e.message : String(e)
      }) — sending the request without an end-user assertion, so auto-sign will be unavailable.`,
    );
  }
  return headers;
}
