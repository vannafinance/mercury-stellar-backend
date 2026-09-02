/**
 * Verify a real Privy access token against Privy's live JWKS.
 *
 * The unit tests sign their own tokens with a local key, which proves the crypto
 * but not the configuration. This proves the configuration: a token minted by the
 * actual browser session, checked against the actual published keys, with the
 * actual app id from .env.local. It is the fastest way to answer "will the Sign
 * Service accept what we are about to forward" without deploying anything.
 *
 * Get a token: sign in on the site, then in the browser console run
 *
 *     await (await fetch('/api/copilot', {method:'POST'})) && localStorage.getItem('privy:token')
 *
 * or simply copy the `x-privy-token` request header from a /api/copilot call in
 * the Network tab.
 *
 * Usage:
 *   npx tsx scripts/verify-privy-token.mts <token>
 *   npx tsx scripts/verify-privy-token.mts            # reads stdin
 */

import { verifyPrivyToken, peekPrivySubject, PrivyAuthError } from "../lib/copilot/privy-auth";
import { copilotConfig } from "../lib/copilot/config";

async function readToken(): Promise<string> {
  const arg = process.argv[2];
  if (arg && arg.trim()) return arg.trim();
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

function line(k: string, v: unknown): void {
  console.log(`  ${k.padEnd(18)} ${String(v)}`);
}

const token = await readToken();
if (!token) {
  console.error("No token given. Pass it as an argument or on stdin.");
  process.exit(2);
}

console.log("\nConfiguration this app will verify against");
line("app id", copilotConfig.privyAppId || "(NEXT_PUBLIC_PRIVY_APP_ID unset!)");
line("jwks", copilotConfig.privyJwksUri);
line("token subject", peekPrivySubject(token) ?? "(unreadable)");

try {
  const identity = await verifyPrivyToken(token);
  console.log("\n✓ VERIFIED — this token is a usable end-user assertion\n");
  line("sub", identity.sub);
  line("session", identity.sessionId ?? "(none)");
  line("expires", new Date(identity.expiresAt).toISOString());
  const minutesLeft = Math.round((identity.expiresAt - Date.now()) / 60000);
  line("valid for", `${minutesLeft} min`);
  console.log(
    "\nThe Sign Service will accept this if its PRIVY_APP_ID matches the app id above\n" +
      "and PRIVY_USER_ASSERTION is not set to off.\n",
  );
} catch (e) {
  const why = e instanceof PrivyAuthError ? e.message : String(e);
  console.error(`\n✗ REFUSED — ${why}\n`);
  console.error(
    "Common causes, in order of likelihood:\n" +
      "  • the token is older than an hour (Privy access tokens are short-lived)\n" +
      "  • NEXT_PUBLIC_PRIVY_APP_ID does not match the app that minted it\n" +
      "  • it is an identity token or an id token rather than the ACCESS token\n",
  );
  process.exit(1);
}
