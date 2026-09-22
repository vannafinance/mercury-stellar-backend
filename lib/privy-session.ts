/**
 * Read a persisted Privy session without asking the SDK.
 *
 * Privy's SDK is the authority for `authenticated`, but it is also a network call
 * to `auth.privy.io`. When that fetch fails the SDK never authenticates, and the
 * app used to treat that identically to "signed out" — wiping the address and
 * showing Connect. An unexpired `privy:token` means the session is still locally
 * present; the provider is just unreachable.
 */

const TOKEN_KEYS = ["privy:token"];

function jwtExpMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function tokensFromWebStorage(): string[] {
  const tokens: string[] = [];
  if (typeof window === "undefined") return tokens;
  for (const storage of [window.localStorage, window.sessionStorage]) {
    if (!storage) continue;
    try {
      for (const key of TOKEN_KEYS) {
        const value = storage.getItem(key);
        if (value) tokens.push(value);
      }
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key && /^privy:.*token/i.test(key) && !TOKEN_KEYS.includes(key)) {
          const value = storage.getItem(key);
          if (value) tokens.push(value);
        }
      }
    } catch {
      /* storage blocked */
    }
  }
  try {
    const match = typeof document !== "undefined" ? document.cookie.match(/(?:^|; )privy-token=([^;]*)/) : null;
    if (match?.[1]) tokens.push(decodeURIComponent(match[1]));
  } catch {
    /* cookies blocked */
  }
  return tokens;
}

/** Expiry of the longest-lived persisted Privy token, or null when none is present. */
export function readPersistedPrivyExpiry(): number | null {
  let latest: number | null = null;
  for (const token of tokensFromWebStorage()) {
    const exp = jwtExpMs(token);
    if (exp != null && (latest == null || exp > latest)) latest = exp;
  }
  return latest;
}

export function hasUnexpiredPrivySession(now = Date.now()): boolean {
  const exp = readPersistedPrivyExpiry();
  return exp != null && exp > now;
}
