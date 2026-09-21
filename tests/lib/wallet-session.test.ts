import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  boundUserFromWalletSession,
  challengeIsFresh,
  challengeMessage,
  createWalletChallenge,
  createWalletProofSession,
  sep53Digest,
  stellarSubject,
  stellarWalletFromSubject,
  verifySep53Signature,
} from "@/lib/copilot/wallet-session";

/** Official SEP-53 vector 1. */
const SEP53 = {
  message: "Hello, World!",
  seed: "SAKICEVQLYWGSOJS4WW7HZJWAHZVEEBS527LHK5V4MLJALYKICQCJXMW",
  address: "GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L",
  signature:
    "fO5dbYhXUhBMhe6kId/cuVq/AfEnHRHEvsP8vXh03M1uLpi5e46yO2Q8rEBzu3feXQewcQE5GArp88u6ePK6BA==",
};

const OTHER = "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5";

describe("SEP-53 wallet proof", () => {
  it("accepts the published Hello, World! vector", () => {
    expect(verifySep53Signature(SEP53.address, SEP53.message, SEP53.signature)).toBe(true);
  });

  it("rejects a signature for a different message", () => {
    expect(verifySep53Signature(SEP53.address, "Hello, World?", SEP53.signature)).toBe(false);
  });

  it("rejects a signature for a different wallet", () => {
    expect(verifySep53Signature(OTHER, SEP53.message, SEP53.signature)).toBe(false);
  });

  it("matches a signature produced by the same key as Freighter will", () => {
    const keypair = Keypair.fromSecret(SEP53.seed);
    const produced = keypair.sign(sep53Digest(SEP53.message)).toString("base64");
    expect(produced).toBe(SEP53.signature);
    expect(keypair.publicKey()).toBe(SEP53.address);
  });

  it("verifies a challenge message the way connect will sign it", () => {
    const keypair = Keypair.fromSecret(SEP53.seed);
    const challenge = createWalletChallenge(keypair.publicKey(), Date.parse("2026-09-21T12:00:00Z"));
    const message = challengeMessage(challenge);
    const signature = keypair.sign(sep53Digest(message)).toString("base64");
    expect(challengeIsFresh(challenge, keypair.publicKey(), Date.parse("2026-09-21T12:00:30Z"))).toBe(true);
    expect(verifySep53Signature(keypair.publicKey(), message, signature)).toBe(true);
  });
});

describe("stellar subject", () => {
  it("round-trips a G-address and ignores anything else", () => {
    expect(stellarWalletFromSubject(stellarSubject(SEP53.address))).toBe(SEP53.address);
    expect(stellarWalletFromSubject("guest")).toBeNull();
    expect(stellarWalletFromSubject("did:privy:abc")).toBeNull();
    expect(stellarWalletFromSubject("user_01ABC")).toBeNull();
  });

  it("mints a bound Freighter user from a live session cookie payload", () => {
    const session = createWalletProofSession(SEP53.address, 1_000);
    const user = boundUserFromWalletSession(session, 1_001);
    expect(user).toEqual({
      sub: `stellar:${SEP53.address}`,
      accessToken: "",
      kind: "stellar",
      wallet: SEP53.address,
    });
    expect(boundUserFromWalletSession(session, session.expiresAt)).toBeNull();
  });
});
