/**
 * Prove a Freighter G-address to the copilot without a Privy session.
 *
 * Client-only. The server issues a one-time message; Freighter signs it (SEP-53);
 * the response sets an httpOnly cookie. Investigate then sees `kind: "stellar"`
 * instead of `guest`. Call this after Freighter connect, and again if the cookie
 * expired. Privy connect never calls it.
 */

import { signMessage } from "@/lib/wallet-adapter";

function signatureFrom(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return null;
}

export async function walletSessionStatus(address: string): Promise<boolean> {
  try {
    const res = await fetch("/api/copilot/wallet-session", { cache: "no-store" });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; wallet?: string };
    return body.ok === true && body.wallet === address;
  } catch {
    return false;
  }
}

export async function clearWalletSession(): Promise<void> {
  try {
    await fetch("/api/copilot/wallet-session", { method: "DELETE", cache: "no-store" });
  } catch {
    /* disconnect still clears the in-memory wallet */
  }
}

export async function establishWalletSession(address: string): Promise<boolean> {
  if (await walletSessionStatus(address)) return true;

  const started = await fetch("/api/copilot/wallet-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ action: "challenge", address }),
  });
  const challenge = (await started.json()) as {
    ok?: boolean;
    already?: boolean;
    message?: string;
    reason?: string;
  };
  if (challenge.already === true) return true;
  if (!started.ok || challenge.ok !== true || typeof challenge.message !== "string") {
    return false;
  }

  const signed = await signMessage(challenge.message, { address });
  if (signed.error) return false;
  const signature = signatureFrom(signed.signedMessage);
  if (!signature) return false;
  if (signed.signerAddress && signed.signerAddress !== address) return false;

  const verified = await fetch("/api/copilot/wallet-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      action: "verify",
      address,
      signature,
    }),
  });
  const body = (await verified.json()) as { ok?: boolean; wallet?: string };
  return verified.ok && body.ok === true && body.wallet === address;
}
