/**
 * Connect OAuth end-user login — the pieces that can be tested without a browser
 * or a live WorkOS tenant.
 *
 * The two that matter most:
 *   - `resource` is present on BOTH the authorize URL and the refresh, because a
 *     refresh that drops it silently turns a working session into one the Sign
 *     Service rejects, 30 minutes after login.
 *   - a `client_…` subject is refused at exchange, so a misconfigured client id
 *     fails here with a readable message instead of 401-ing mid-transaction.
 */

import { beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";

const ISSUER = "https://tenant.authkit.app";
const RESOURCE = "https://mcp.vanna.finance/mcp";
const REDIRECT = "https://app.vanna.finance/api/auth/callback";

beforeEach(() => {
  process.env.WORKOS_ISSUER = ISSUER;
  process.env.WORKOS_CLIENT_ID = "client_user_app";
  process.env.WORKOS_CLIENT_SECRET = "sk_test_secret";
  process.env.MCP_RESOURCE = RESOURCE;
  process.env.MCP_SEND_RESOURCE = "true";
  process.env.COPILOT_SESSION_SECRET = "0123456789abcdef0123456789abcdef";
  delete process.env.COPILOT_AUTH_REDIRECT_URI;
});

async function mod() {
  return import("@/lib/copilot/user-auth");
}

function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.${Buffer.from("sig").toString("base64url")}`;
}

const userClaims = (over: Record<string, unknown> = {}) => ({
  sub: "user_01KX5T71JJ7PY4RVV06K9SW04E",
  email: "aditya@vanna.finance",
  aud: RESOURCE,
  exp: Math.floor(Date.now() / 1000) + 1800,
  ...over,
});

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B vector", async () => {
    const { codeChallengeFor } = await mod();
    expect(codeChallengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("produces verifiers inside the 43-128 character range", async () => {
    const { createCodeVerifier } = await mod();
    for (let i = 0; i < 20; i++) {
      const v = createCodeVerifier();
      expect(v.length).toBeGreaterThanOrEqual(43);
      expect(v.length).toBeLessThanOrEqual(128);
      expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
    }
  });
});

describe("authorization URL", () => {
  it("carries the resource indicator — the whole reason for this flow", async () => {
    const { buildAuthorizationUrl } = await mod();
    const url = new URL(
      buildAuthorizationUrl({ redirectUri: REDIRECT, state: "st", codeChallenge: "cc" }),
    );
    expect(url.origin + url.pathname).toBe(`${ISSUER}/oauth2/authorize`);
    expect(url.searchParams.get("resource")).toBe(RESOURCE);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("cc");
    expect(url.searchParams.get("client_id")).toBe("client_user_app");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
  });

  it("requests offline_access so the session survives token expiry", async () => {
    const { buildAuthorizationUrl } = await mod();
    const url = new URL(
      buildAuthorizationUrl({ redirectUri: REDIRECT, state: "s", codeChallenge: "c" }),
    );
    expect(url.searchParams.get("scope")).toContain("offline_access");
  });

  it("refuses to build a URL when the user client id is missing", async () => {
    delete process.env.WORKOS_CLIENT_ID;
    const { buildAuthorizationUrl, UserAuthError } = await mod();
    expect(() =>
      buildAuthorizationUrl({ redirectUri: REDIRECT, state: "s", codeChallenge: "c" }),
    ).toThrow(UserAuthError);
  });
});

describe("token exchange", () => {
  function fakeToken(body: Record<string, unknown>, captured?: { form?: URLSearchParams }) {
    return (async (_url: string | URL | Request, init?: RequestInit) => {
      if (captured) captured.form = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  it("sends resource + code_verifier and returns the user session", async () => {
    const { exchangeCodeForSession } = await mod();
    const captured: { form?: URLSearchParams } = {};
    const session = await exchangeCodeForSession(
      { code: "abc", codeVerifier: "ver", redirectUri: REDIRECT },
      fakeToken(
        { access_token: makeJwt(userClaims()), refresh_token: "rt_1", expires_in: 1800 },
        captured,
      ),
    );

    expect(captured.form?.get("grant_type")).toBe("authorization_code");
    expect(captured.form?.get("resource")).toBe(RESOURCE);
    expect(captured.form?.get("code_verifier")).toBe("ver");
    expect(session.sub).toBe("user_01KX5T71JJ7PY4RVV06K9SW04E");
    expect(session.email).toBe("aditya@vanna.finance");
    expect(session.refreshToken).toBe("rt_1");
    expect(session.expiresAt).toBeGreaterThan(Date.now());
  });

  it("REFUSES an M2M subject — the misconfiguration fails here, not mid-transaction", async () => {
    const { exchangeCodeForSession, UserAuthError } = await mod();
    await expect(
      exchangeCodeForSession(
        { code: "abc", codeVerifier: "v", redirectUri: REDIRECT },
        fakeToken({
          access_token: makeJwt(userClaims({ sub: "client_01KXBNHSTPDZZ90370X7JEQ7HS" })),
        }),
      ),
    ).rejects.toThrow(UserAuthError);

    await expect(
      exchangeCodeForSession(
        { code: "abc", codeVerifier: "v", redirectUri: REDIRECT },
        fakeToken({
          access_token: makeJwt(userClaims({ sub: "client_01KXBNHSTPDZZ90370X7JEQ7HS" })),
        }),
      ),
    ).rejects.toThrow(/WORKOS_CLIENT_ID/);
  });

  it("surfaces an OAuth error body instead of a bare status", async () => {
    const { exchangeCodeForSession } = await mod();
    const failing = (async () =>
      new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "code already used" }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    await expect(
      exchangeCodeForSession({ code: "x", codeVerifier: "v", redirectUri: REDIRECT }, failing),
    ).rejects.toThrow(/invalid_grant.*code already used/);
  });

  it("REFRESH also sends resource, so the audience survives", async () => {
    // Without this the token comes back with no `aud` and every auto-sign after
    // the first 30 minutes fails — the original bug, re-introduced on a timer.
    const { refreshSession } = await mod();
    const captured: { form?: URLSearchParams } = {};
    const refreshed = await refreshSession(
      {
        sub: "user_1",
        accessToken: "old",
        refreshToken: "rt_1",
        expiresAt: Date.now() - 1000,
      },
      fakeToken({ access_token: makeJwt(userClaims()), expires_in: 1800 }, captured),
    );
    expect(captured.form?.get("grant_type")).toBe("refresh_token");
    expect(captured.form?.get("resource")).toBe(RESOURCE);
    expect(refreshed.accessToken).not.toBe("old");
  });

  it("keeps the previous refresh token when the response omits a rotated one", async () => {
    const { refreshSession } = await mod();
    const out = await refreshSession(
      { sub: "user_1", accessToken: "old", refreshToken: "rt_keep", expiresAt: 0 },
      fakeToken({ access_token: makeJwt(userClaims()) }),
    );
    expect(out.refreshToken).toBe("rt_keep");
  });
});

/**
 * MCP_SEND_RESOURCE off — the default, and what a hand-created Connect OAuth app
 * requires.
 *
 * Sending `resource` to such a client returns `400 invalid_target` even though
 * the URI is registered as the Default Resource Indicator, because the default
 * only applies to DCR/CIMD clients. That is what broke the first live login.
 *
 * All three legs must agree. Sending it on the exchange alone 400s; sending it on
 * the refresh alone silently changes the audience half an hour after login, which
 * is worse — the session works, then stops.
 */
describe("resource indicator OFF (hand-created Connect OAuth client)", () => {
  beforeEach(() => {
    process.env.MCP_SEND_RESOURCE = "false";
  });

  function fakeToken(body: Record<string, unknown>, captured?: { form?: URLSearchParams }) {
    return (async (_url: string | URL | Request, init?: RequestInit) => {
      if (captured) captured.form = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  it("is the default when MCP_SEND_RESOURCE is unset", async () => {
    delete process.env.MCP_SEND_RESOURCE;
    const { shouldSendResource } = await mod();
    expect(shouldSendResource()).toBe(false);
  });

  it("omits resource from the authorize URL entirely", async () => {
    const { buildAuthorizationUrl } = await mod();
    const url = new URL(
      buildAuthorizationUrl({ redirectUri: REDIRECT, state: "s", codeChallenge: "c" }),
    );
    expect(url.searchParams.has("resource")).toBe(false);
    // Everything else is unchanged — PKCE still applies.
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("omits resource from the code exchange — the call that was 400ing", async () => {
    const { exchangeCodeForSession } = await mod();
    const captured: { form?: URLSearchParams } = {};
    await exchangeCodeForSession(
      { code: "abc", codeVerifier: "ver", redirectUri: REDIRECT },
      fakeToken({ access_token: makeJwt(userClaims({ aud: "client_user_app" })) }, captured),
    );
    expect(captured.form?.has("resource")).toBe(false);
    expect(captured.form?.get("code_verifier")).toBe("ver");
  });

  it("omits resource from the refresh too", async () => {
    const { refreshSession } = await mod();
    const captured: { form?: URLSearchParams } = {};
    await refreshSession(
      { sub: "user_1", accessToken: "old", refreshToken: "rt_1", expiresAt: 0 },
      fakeToken({ access_token: makeJwt(userClaims({ aud: "client_user_app" })) }, captured),
    );
    expect(captured.form?.has("resource")).toBe(false);
  });

  it("ignores an explicit resource override rather than 400ing the client", async () => {
    const { buildAuthorizationUrl } = await mod();
    const url = new URL(
      buildAuthorizationUrl({
        redirectUri: REDIRECT,
        state: "s",
        codeChallenge: "c",
        resource: RESOURCE,
      }),
    );
    expect(url.searchParams.has("resource")).toBe(false);
  });

  it("accepts aud = client_id, because that is what this client type mints", async () => {
    // The audience changes; `sub` does not. `sub` is what closes the F3 hole,
    // what isBound keys on, and what the Sign Service's ^user_ guard checks.
    const { exchangeCodeForSession } = await mod();
    const session = await exchangeCodeForSession(
      { code: "abc", codeVerifier: "v", redirectUri: REDIRECT },
      fakeToken({ access_token: makeJwt(userClaims({ aud: "client_user_app" })) }),
    );
    expect(session.sub).toBe("user_01KX5T71JJ7PY4RVV06K9SW04E");
  });

  it("still refuses an M2M subject — the guard does not depend on the audience", async () => {
    const { exchangeCodeForSession, UserAuthError } = await mod();
    await expect(
      exchangeCodeForSession(
        { code: "abc", codeVerifier: "v", redirectUri: REDIRECT },
        fakeToken({
          access_token: makeJwt(
            userClaims({ sub: "client_01KXBNHSTPDZZ90370X7JEQ7HS", aud: "client_user_app" }),
          ),
        }),
      ),
    ).rejects.toThrow(UserAuthError);
  });
});

/**
 * Which audiences count as a legitimate end-user token.
 *
 * The live surprise: a hand-created Connect OAuth token carries the WorkOS
 * ENVIRONMENT client id, not the Connect app's own id — so /api/auth/session
 * reported audienceMatchesMcp:false on a perfectly good token.
 *
 * The uncomfortable part, recorded here so it is not rediscovered: that
 * environment id is ALSO the M2M token's audience (AUTOSIGN_AUDIENCE_BLOCKER.md
 * §1). Accepting it means `aud` no longer separates a user from the machine
 * credential — `sub` does, and only `sub` does.
 */
describe("accepted audiences", () => {
  const ENV_CLIENT_ID = "client_01KX5H81JH2HWD2DHKYFYFXNS2";

  beforeEach(() => {
    process.env.WORKOS_ENV_CLIENT_ID = ENV_CLIENT_ID;
  });

  it("accepts the environment client id — what this client type actually mints", async () => {
    const { acceptedUserAudiences } = await mod();
    expect(acceptedUserAudiences()).toContain(ENV_CLIENT_ID);
  });

  it("accepts all three: MCP resource, Connect client id, env client id", async () => {
    const { acceptedUserAudiences } = await mod();
    expect(acceptedUserAudiences().sort()).toEqual(
      [RESOURCE, "client_user_app", ENV_CLIENT_ID].sort(),
    );
  });

  it("drops unset entries instead of accepting an empty audience", async () => {
    // An empty string in the list would match a token with aud:"" — fail closed.
    delete process.env.WORKOS_ENV_CLIENT_ID;
    delete process.env.MCP_RESOURCE;
    process.env.MCP_BASE_URL = RESOURCE;
    const { acceptedUserAudiences } = await mod();
    const list = await acceptedUserAudiences();
    expect(list).not.toContain("");
    expect(list.every((a) => a.length > 0)).toBe(true);
  });

  it("a token with aud = env client id is accepted by the audience check", async () => {
    const { acceptedUserAudiences, peekTokenClaims } = await mod();
    const aud = peekTokenClaims(makeJwt(userClaims({ aud: ENV_CLIENT_ID }))).aud ?? [];
    expect(aud.some((a) => acceptedUserAudiences().includes(a))).toBe(true);
  });

  it("the audience check does NOT distinguish M2M — only the subject does", async () => {
    // Same audience, different subject. If this ever stops being true, the
    // ^user_ guard has been weakened and the M2M credential can act as a user.
    const { acceptedUserAudiences } = await mod();
    const m2mSub = "client_01KXBNHSTPDZZ90370X7JEQ7HS";
    const userSub = "user_01KX5T71JJ7PY4RVV06K9SW04E";
    expect(acceptedUserAudiences()).toContain(ENV_CLIENT_ID); // both share this
    expect(userSub.startsWith("user_")).toBe(true);
    expect(m2mSub.startsWith("user_")).toBe(false);
  });

  it("exchange still refuses an M2M subject carrying the env audience", async () => {
    // The end-to-end statement of the line above, through the real code path.
    const { exchangeCodeForSession, UserAuthError } = await mod();
    const failing = (async () =>
      new Response(
        JSON.stringify({
          access_token: makeJwt(
            userClaims({ sub: "client_01KXBNHSTPDZZ90370X7JEQ7HS", aud: ENV_CLIENT_ID }),
          ),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    await expect(
      exchangeCodeForSession({ code: "c", codeVerifier: "v", redirectUri: REDIRECT }, failing),
    ).rejects.toThrow(UserAuthError);
  });
});

describe("resource indicator ON (DCR/CIMD client)", () => {
  it("shouldSendResource reflects the flag", async () => {
    process.env.MCP_SEND_RESOURCE = "true";
    const { shouldSendResource } = await mod();
    expect(shouldSendResource()).toBe(true);
  });

  it("accepts 1/on/yes as well as true", async () => {
    for (const v of ["1", "on", "yes", "TRUE"]) {
      process.env.MCP_SEND_RESOURCE = v;
      const { shouldSendResource } = await mod();
      expect(shouldSendResource()).toBe(true);
    }
    for (const v of ["0", "off", "no", "", "nonsense"]) {
      process.env.MCP_SEND_RESOURCE = v;
      const { shouldSendResource } = await mod();
      expect(shouldSendResource()).toBe(false);
    }
  });
});

describe("needsRefresh", () => {
  it("is true inside the margin and false well before it", async () => {
    const { needsRefresh, REFRESH_MARGIN_MS } = await mod();
    const now = Date.now();
    const s = (expiresAt: number) => ({ sub: "user_1", accessToken: "t", expiresAt });
    expect(needsRefresh(s(now + REFRESH_MARGIN_MS - 1000), now)).toBe(true);
    expect(needsRefresh(s(now - 1), now)).toBe(true);
    expect(needsRefresh(s(now + REFRESH_MARGIN_MS + 60_000), now)).toBe(false);
  });
});

describe("sealed cookie", () => {
  it("round-trips", async () => {
    const { seal, unseal } = await mod();
    const value = { sub: "user_1", accessToken: "a".repeat(400), expiresAt: 123 };
    expect(unseal(seal(value))).toEqual(value);
  });

  it("does not store the token in plaintext", async () => {
    const { seal } = await mod();
    expect(seal({ accessToken: "SUPERSECRET" })).not.toContain("SUPERSECRET");
  });

  it("returns null on tampering rather than throwing into a request", async () => {
    const { seal, unseal } = await mod();
    const sealed = seal({ sub: "user_1" });
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(unseal(parts.join("."))).toBeNull();
  });

  it("returns null for a cookie sealed with a different secret", async () => {
    const { seal } = await mod();
    const sealed = seal({ sub: "user_1" });
    process.env.COPILOT_SESSION_SECRET = "ffffffffffffffffffffffffffffffff";
    const fresh = await import("@/lib/copilot/user-auth");
    expect(fresh.unseal(sealed)).toBeNull();
  });

  it("returns null for empty / malformed / wrong-version input", async () => {
    const { unseal } = await mod();
    expect(unseal(undefined)).toBeNull();
    expect(unseal("")).toBeNull();
    expect(unseal("not-a-cookie")).toBeNull();
    expect(unseal("v2.a.b.c")).toBeNull();
  });

  it("rejects a too-short secret rather than deriving a weak key", async () => {
    process.env.COPILOT_SESSION_SECRET = "short";
    const { seal, UserAuthError } = await mod();
    expect(() => seal({ a: 1 })).toThrow(UserAuthError);
  });

  it("refuses to emit a cookie over the browser's size budget", async () => {
    const { seal, MAX_COOKIE_BYTES } = await mod();
    // A silently-truncated cookie reads as "login worked but I'm logged out".
    expect(() => seal({ accessToken: crypto.randomBytes(4000).toString("base64") })).toThrow(
      /cookie budget/,
    );
    expect(MAX_COOKIE_BYTES).toBeLessThan(4096);
  });
});

describe("safeReturnTo", () => {
  it("keeps same-origin paths and rejects everything else", async () => {
    const { safeReturnTo } = await mod();
    expect(safeReturnTo("/portfolio")).toBe("/portfolio");
    expect(safeReturnTo(null)).toBe("/copilot");
    // An open redirect on a login callback is a phishing primitive.
    expect(safeReturnTo("//evil.example.com")).toBe("/copilot");
    expect(safeReturnTo("https://evil.example.com")).toBe("/copilot");
    expect(safeReturnTo("javascript:alert(1)")).toBe("/copilot");
  });
});

describe("resolveRedirectUri", () => {
  it("derives from the request origin when unset", async () => {
    const { resolveRedirectUri } = await mod();
    expect(resolveRedirectUri("http://localhost:3000/api/auth/login?return_to=/x")).toBe(
      "http://localhost:3000/api/auth/callback",
    );
  });

  it("prefers the configured value", async () => {
    process.env.COPILOT_AUTH_REDIRECT_URI = REDIRECT;
    const { resolveRedirectUri } = await mod();
    expect(resolveRedirectUri("http://localhost:3000/api/auth/login")).toBe(REDIRECT);
  });
});

describe("peekTokenClaims", () => {
  it("reads sub/email/exp/aud and survives junk", async () => {
    const { peekTokenClaims } = await mod();
    const c = peekTokenClaims(makeJwt(userClaims({ aud: [RESOURCE, "other"] })));
    expect(c.sub).toBe("user_01KX5T71JJ7PY4RVV06K9SW04E");
    expect(c.aud).toEqual([RESOURCE, "other"]);
    expect(peekTokenClaims("not.a.jwt")).toEqual({});
    expect(peekTokenClaims("")).toEqual({});
  });
});
