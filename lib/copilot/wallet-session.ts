/**
 * Ownership proof for a Freighter (or any non-Privy) G-address.
 *
 * Privy already proves the person: the browser sends `x-privy-token`, we verify
 * it, and `identity_wallet_bindings` ties that `did:privy:…` to a G-address.
 * Freighter never mints that token. The navbar still shows the G-address because
 * that store is client-only, so investigation used to arrive as `subject=guest`
 * with a wallet in the body — which `resolveInvestigationScope` correctly refuses
 * as an unsigned session, or anyone could impersonate any wallet.
 *
 * This module is the missing third identity anchor. The wallet signs a
 * single-use challenge (SEP-53). The signature is verified here, then sealed
 * into an httpOnly cookie. Investigation reads that cookie as `sub=stellar:<G>`
 * and treats that G as the trader. Privy and WorkOS are tried first and are
 * unchanged. No assertion is forwarded to the Sign Service — Freighter cannot
 * auto-sign; writes still fall back to wallet-sign in the extension.
 */

import crypto from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type { BoundUser } from "./user-context";

export const WALLET_SESSION_COOKIE = "vanna_wallet_session";
export const WALLET_CHALLENGE_COOKIE = "vanna_wallet_challenge";
export const WALLET_SESSION_TTL_SECONDS = 24 * 60 * 60;
export const WALLET_CHALLENGE_TTL_SECONDS = 5 * 60;
export const STELLAR_SUB_PREFIX = "stellar:";

/** SHA-256 prefix from SEP-53. Wallets hash `prefix + message` before ed25519. */
export const SEP53_PREFIX = "Stellar Signed Message:\n";

export interface WalletChallenge {
  nonce: string;
  wallet: string;
  issuedAt: string;
  expiresAt: number;
}

export interface WalletProofSession {
  kind: "stellar";
  wallet: string;
  expiresAt: number;
}

export function stellarSubject(wallet: string): string {
  return `${STELLAR_SUB_PREFIX}${wallet}`;
}

export function stellarWalletFromSubject(subject: string): string | null {
  if (!subject.startsWith(STELLAR_SUB_PREFIX)) return null;
  const wallet = subject.slice(STELLAR_SUB_PREFIX.length);
  return StrKey.isValidEd25519PublicKey(wallet) ? wallet : null;
}

export function challengeMessage(challenge: Pick<WalletChallenge, "wallet" | "nonce" | "issuedAt">): string {
  return [
    "Vanna Copilot proves this wallet is yours.",
    `Wallet: ${challenge.wallet}`,
    `Nonce: ${challenge.nonce}`,
    `Issued: ${challenge.issuedAt}`,
  ].join("\n");
}

export function createWalletChallenge(wallet: string, now = Date.now()): WalletChallenge {
  if (!StrKey.isValidEd25519PublicKey(wallet)) {
    throw new Error("wallet must be a Stellar G-address");
  }
  return {
    nonce: crypto.randomBytes(24).toString("base64url"),
    wallet,
    issuedAt: new Date(now).toISOString(),
    expiresAt: now + WALLET_CHALLENGE_TTL_SECONDS * 1000,
  };
}

export function createWalletProofSession(wallet: string, now = Date.now()): WalletProofSession {
  if (!StrKey.isValidEd25519PublicKey(wallet)) {
    throw new Error("wallet must be a Stellar G-address");
  }
  return {
    kind: "stellar",
    wallet,
    expiresAt: now + WALLET_SESSION_TTL_SECONDS * 1000,
  };
}

export function boundUserFromWalletSession(
  session: WalletProofSession | null | undefined,
  now = Date.now(),
): BoundUser | null {
  if (!session || session.kind !== "stellar" || session.expiresAt <= now) return null;
  if (!StrKey.isValidEd25519PublicKey(session.wallet)) return null;
  return {
    sub: stellarSubject(session.wallet),
    accessToken: "",
    kind: "stellar",
    wallet: session.wallet,
  };
}

export function sep53Digest(message: string): Buffer {
  return crypto.createHash("sha256")
    .update(Buffer.concat([
      Buffer.from(SEP53_PREFIX, "utf8"),
      Buffer.from(message, "utf8"),
    ]))
    .digest();
}

function decodeSignature(signature: string): Buffer | null {
  const trimmed = signature.trim();
  if (!trimmed) return null;
  const fromBase64 = Buffer.from(trimmed, "base64");
  if (fromBase64.length === 64) return fromBase64;
  const hex = trimmed.replace(/^0x/, "");
  if (/^[0-9a-fA-F]+$/.test(hex) && hex.length === 128) return Buffer.from(hex, "hex");
  return null;
}

/** True when `signature` is a SEP-53 ed25519 signature of `message` by `wallet`. */
export function verifySep53Signature(wallet: string, message: string, signature: string): boolean {
  if (!StrKey.isValidEd25519PublicKey(wallet) || !message) return false;
  const sig = decodeSignature(signature);
  if (!sig) return false;
  try {
    return Keypair.fromPublicKey(wallet).verify(sep53Digest(message), sig);
  } catch {
    return false;
  }
}

export function challengeIsFresh(
  challenge: WalletChallenge | null | undefined,
  wallet: string,
  now = Date.now(),
): challenge is WalletChallenge {
  return Boolean(
    challenge &&
    challenge.wallet === wallet &&
    StrKey.isValidEd25519PublicKey(challenge.wallet) &&
    typeof challenge.nonce === "string" &&
    challenge.nonce.length >= 16 &&
    typeof challenge.issuedAt === "string" &&
    challenge.expiresAt > now,
  );
}
