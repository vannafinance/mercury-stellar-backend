// Server-side feature gate for the /stats (Hubble) surface.
//
// OFF by default: the /stats page and the /api/analytics/* routes 404 unless
// STATS_ENABLED="true". This is a server-only env var (NOT NEXT_PUBLIC), so the
// flag can't be flipped from the client and the page isn't even served when
// disabled. Keeps the not-yet-ready, mainnet-only stats surface out of public
// reach. Flip it on in .env.local to work on it locally; for production, layer
// a wallet/admin allowlist on top of this later.
export function isStatsEnabled(): boolean {
  return process.env.STATS_ENABLED === "true";
}
