/**
 * Freighter (non-Privy) wallet proof.
 *
 *   GET    /api/copilot/wallet-session     does this browser already have a proof
 *   POST   { action: "challenge", address } mint a one-time message to sign
 *   POST   { action: "verify", address, signature } seal the session cookie
 *   DELETE /api/copilot/wallet-session     drop the proof on disconnect
 *
 * Privy identity is not involved. A Privy request never hits this route from the
 * client; `loadUserFromRequest` still prefers `x-privy-token` when both exist.
 */

import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { cookieOptions, seal, unseal } from "@/lib/copilot/user-auth";
import {
  WALLET_CHALLENGE_COOKIE,
  WALLET_CHALLENGE_TTL_SECONDS,
  WALLET_SESSION_COOKIE,
  WALLET_SESSION_TTL_SECONDS,
  boundUserFromWalletSession,
  challengeIsFresh,
  challengeMessage,
  createWalletChallenge,
  createWalletProofSession,
  verifySep53Signature,
  type WalletChallenge,
  type WalletProofSession,
} from "@/lib/copilot/wallet-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status });
}

function secureFrom(req: NextRequest) {
  return req.nextUrl.protocol === "https:";
}

function readChallenge(req: NextRequest): WalletChallenge | null {
  return unseal<WalletChallenge>(req.cookies.get(WALLET_CHALLENGE_COOKIE)?.value);
}

function readSession(req: NextRequest): WalletProofSession | null {
  return unseal<WalletProofSession>(req.cookies.get(WALLET_SESSION_COOKIE)?.value);
}

function setCookie(
  res: NextResponse,
  name: string,
  value: string,
  maxAge: number,
  req: NextRequest,
) {
  res.cookies.set(name, value, cookieOptions(maxAge, secureFrom(req)));
}

function clearCookie(res: NextResponse, name: string) {
  res.cookies.delete(name);
}

export async function GET(req: NextRequest) {
  const user = boundUserFromWalletSession(readSession(req));
  if (!user?.wallet) return json({ ok: false });
  return json({ ok: true, wallet: user.wallet });
}

export async function DELETE(req: NextRequest) {
  const res = json({ ok: true });
  clearCookie(res, WALLET_SESSION_COOKIE);
  clearCookie(res, WALLET_CHALLENGE_COOKIE);
  void req;
  return res;
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, reason: "invalid_body" }, 400);
  }

  const action = typeof body.action === "string" ? body.action : "";
  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (!StrKey.isValidEd25519PublicKey(address)) {
    return json({ ok: false, reason: "invalid_wallet" }, 400);
  }

  if (action === "challenge") {
    const existing = boundUserFromWalletSession(readSession(req));
    if (existing?.wallet === address) {
      return json({ ok: true, already: true, wallet: address });
    }
    const challenge = createWalletChallenge(address);
    const res = json({
      ok: true,
      message: challengeMessage(challenge),
      expires_in: WALLET_CHALLENGE_TTL_SECONDS,
    });
    setCookie(res, WALLET_CHALLENGE_COOKIE, seal(challenge), WALLET_CHALLENGE_TTL_SECONDS, req);
    return res;
  }

  if (action === "verify") {
    const signature = typeof body.signature === "string" ? body.signature : "";
    const challenge = readChallenge(req);
    if (!challengeIsFresh(challenge, address)) {
      return json({ ok: false, reason: "challenge_expired" }, 400);
    }
    const message = challengeMessage(challenge);
    if (!verifySep53Signature(address, message, signature)) {
      return json({ ok: false, reason: "signature_invalid" }, 401);
    }
    const session = createWalletProofSession(address);
    const res = json({ ok: true, wallet: address });
    setCookie(res, WALLET_SESSION_COOKIE, seal(session), WALLET_SESSION_TTL_SECONDS, req);
    clearCookie(res, WALLET_CHALLENGE_COOKIE);
    return res;
  }

  return json({ ok: false, reason: "unknown_action" }, 400);
}
