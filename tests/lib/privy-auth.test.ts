/**
 * The Privy access token is the end-user assertion on the money path, so this
 * verifier is a security boundary: everything downstream — which wallet may be
 * signed for, whose bindings are read — keys on the `sub` it returns.
 *
 * Tests drive the real crypto with a locally generated P-256 key and a real
 * JWKS document, so a signature that would not verify against Privy cannot pass
 * here either. No mocking of the verify step.
 */

import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  PRIVY_ISSUER,
  PrivyAuthError,
  peekPrivySubject,
  resetPrivyJwksCache,
  verifyPrivyToken,
} from "@/lib/copilot/privy-auth";

const APP_ID = "cmrdk67en003k0cjojj56n8mh";
const JWKS_URI = `https://auth.privy.io/api/v1/apps/${APP_ID}/jwks.json`;
const SUB = "did:privy:cmrx9k2p400abcd0lm12efgh";
const KID = "test-key-1";

const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
/** A second key, never published — for "signed by something else" cases. */
const foreign = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });

function jwksFor(key: crypto.KeyObject, kid = KID) {
  const jwk = key.export({ format: "jwk" }) as Record<string, string>;
  return { keys: [{ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid, use: "sig", alg: "ES256" }] };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function signToken(
  claims: Record<string, unknown>,
  opts: { alg?: string; kid?: string | null; key?: crypto.KeyObject; tamper?: boolean } = {},
): string {
  const header: Record<string, unknown> = { alg: opts.alg ?? "ES256", typ: "JWT" };
  if (opts.kid !== null) header.kid = opts.kid ?? KID;
  const body = `${b64(header)}.${b64(claims)}`;
  const sig = crypto.sign("sha256", Buffer.from(body), {
    key: opts.key ?? privateKey,
    dsaEncoding: "ieee-p1363",
  });
  if (opts.tamper) sig[0] ^= 0xff;
  return `${body}.${sig.toString("base64url")}`;
}

const NOW = 1_770_000_000_000; // fixed clock; tokens are minted relative to it
const nowSec = Math.floor(NOW / 1000);

function validClaims(over: Record<string, unknown> = {}) {
  return {
    iss: PRIVY_ISSUER,
    sub: SUB,
    aud: APP_ID,
    sid: "session-abc",
    iat: nowSec - 60,
    exp: nowSec + 3600,
    ...over,
  };
}

let jwksRequests = 0;

function fetchJwks(doc: unknown = jwksFor(publicKey)): typeof fetch {
  return (async (url: string | URL | Request) => {
    expect(String(url)).toBe(JWKS_URI);
    jwksRequests += 1;
    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const verify = (token: string, over: Parameters<typeof verifyPrivyToken>[1] = {}) =>
  verifyPrivyToken(token, {
    now: NOW,
    appId: APP_ID,
    jwksUri: JWKS_URI,
    fetchImpl: fetchJwks(),
    ...over,
  });

beforeEach(() => {
  resetPrivyJwksCache();
  jwksRequests = 0;
});

describe("a genuine Privy token is accepted", () => {
  it("returns the subject, session and expiry", async () => {
    const identity = await verify(signToken(validClaims()));
    expect(identity.sub).toBe(SUB);
    expect(identity.sessionId).toBe("session-abc");
    expect(identity.expiresAt).toBe((nowSec + 3600) * 1000);
  });

  it("accepts an array audience that includes this app", async () => {
    const identity = await verify(signToken(validClaims({ aud: ["other-app", APP_ID] })));
    expect(identity.sub).toBe(SUB);
  });

  it("tolerates a token that expired within the clock-skew window", async () => {
    // 30s, deliberately the same tolerance the Sign Service applies — the two
    // hops must not disagree about the same token.
    const identity = await verify(signToken(validClaims({ exp: nowSec - 20 })));
    expect(identity.sub).toBe(SUB);
  });

  it("caches the JWKS instead of fetching per call", async () => {
    await verify(signToken(validClaims()));
    await verify(signToken(validClaims()));
    expect(jwksRequests).toBe(1);
  });
});

describe("anything less than a valid signature is refused", () => {
  const cases: Array<[string, () => string]> = [
    ["a tampered signature", () => signToken(validClaims(), { tamper: true })],
    ["a token signed by another key", () => signToken(validClaims(), { key: foreign.privateKey })],
    ["alg: none", () => `${b64({ alg: "none", kid: KID })}.${b64(validClaims())}.`],
    ["alg swapped to RS256", () => signToken(validClaims(), { alg: "RS256" })],
    ["alg swapped to HS256", () => signToken(validClaims(), { alg: "HS256" })],
    ["no kid at all", () => signToken(validClaims(), { kid: null })],
    ["an unknown kid", () => signToken(validClaims(), { kid: "rotated-away" })],
    ["not a JWT", () => "not-a-token"],
    ["two segments", () => `${b64({ alg: "ES256" })}.${b64(validClaims())}`],
  ];

  for (const [name, make] of cases) {
    it(`rejects ${name}`, async () => {
      await expect(verify(make())).rejects.toBeInstanceOf(PrivyAuthError);
    });
  }
});

describe("claims are checked after the signature", () => {
  it("rejects an expired token", async () => {
    await expect(verify(signToken(validClaims({ exp: nowSec - 120 })))).rejects.toThrow(/expired/i);
  });

  it("rejects a missing exp", async () => {
    const { exp: _exp, ...noExp } = validClaims();
    await expect(verify(signToken(noExp))).rejects.toThrow(/`exp`/);
  });

  it("rejects a foreign issuer", async () => {
    await expect(verify(signToken(validClaims({ iss: "evil.example" })))).rejects.toThrow(
      /issuer/i,
    );
  });

  it("rejects a token minted for a different Privy app", async () => {
    await expect(verify(signToken(validClaims({ aud: "some-other-app" })))).rejects.toThrow(
      /audience/i,
    );
  });

  it("rejects a subject that is not a Privy DID", async () => {
    // The machine-credential shape the Sign Service exists to refuse.
    await expect(
      verify(signToken(validClaims({ sub: "client_01KX5H81JH2HWD2DHKYFYFXNS2" }))),
    ).rejects.toThrow(/does not start with did:privy:/);
  });

  it("names both audiences so a config mismatch is actionable", async () => {
    await expect(verify(signToken(validClaims({ aud: "app-B" })))).rejects.toThrow(
      /app-B.*cmrdk67en003k0cjojj56n8mh|cmrdk67en003k0cjojj56n8mh/,
    );
  });
});

describe("configuration and transport failures fail closed", () => {
  it("refuses to verify without an app id", async () => {
    await expect(verify(signToken(validClaims()), { appId: "" })).rejects.toThrow(
      /NEXT_PUBLIC_PRIVY_APP_ID/,
    );
  });

  it("surfaces an unreachable JWKS endpoint", async () => {
    const fetchImpl = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    await expect(verify(signToken(validClaims()), { fetchImpl })).rejects.toThrow(/JWKS/i);
  });

  it("surfaces a non-200 JWKS response", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(verify(signToken(validClaims()), { fetchImpl })).rejects.toThrow(/503/);
  });

  it("rejects an empty JWKS", async () => {
    await expect(
      verify(signToken(validClaims()), { fetchImpl: fetchJwks({ keys: [] }) }),
    ).rejects.toThrow(/no keys/i);
  });

  it("rejects a non-EC key", async () => {
    const doc = { keys: [{ kty: "RSA", n: "abc", e: "AQAB", kid: KID }] };
    await expect(
      verify(signToken(validClaims()), { fetchImpl: fetchJwks(doc) }),
    ).rejects.toThrow(/key type/i);
  });
});

describe("peekPrivySubject is for logs only", () => {
  it("reads the subject without verifying anything", () => {
    expect(peekPrivySubject(signToken(validClaims(), { tamper: true }))).toBe(SUB);
  });

  it("returns null on garbage rather than throwing", () => {
    expect(peekPrivySubject("nope")).toBeNull();
    expect(peekPrivySubject("a.b.c")).toBeNull();
  });
});
