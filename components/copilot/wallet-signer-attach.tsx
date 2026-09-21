"use client";

import { useEffect, useRef } from "react";
import { copilotRequestHeaders } from "@/lib/copilot/copilot-request";
import { getPrivyAuthControls } from "@/lib/wallet-adapter";
import { useUserStore } from "@/store/user";

/**
 * Attach the Vanna signer and write the identity binding when a wallet connects.
 *
 * ## What this is for
 *
 * Attaching Vanna's signer quorum to the user's wallet is part of connecting, not part of
 * auto-approve. Auto-approve governs the signing SESSION — whether a write goes through
 * without a per-transaction prompt. Whether Vanna is a signer at all is what makes the
 * wallet usable by the protocol in the first place, and it belongs to the moment the user
 * connects.
 *
 * The app used to run the two together: the only code that ever attached the signer or
 * wrote `identity_wallet_bindings` lived behind the auto-sign enable gesture. With
 * auto-approve off, no binding could ever exist, so every copilot turn — reads included —
 * answered "I couldn't verify the wallet link this turn", and nothing in the product could
 * resolve it except granting the permission the user had just declined.
 *
 * So the bind runs here instead, on connect, through /api/copilot/wallet-bind, which
 * carries no auto-sign semantics at all.
 *
 * ## Why it is safe to run unattended
 *
 * Every step is already idempotent and already verified server-side. `authorizeVannaSigner`
 * returns immediately when Privy reports the wallet is delegated, so a connected user is
 * not re-prompted. `register` makes the Sign Service re-verify quorum-is-signer against
 * Privy before it writes anything, and the row itself is an upsert. Nothing here grants
 * authority: it completes a grant the architecture already assumes.
 *
 * ## Why Privy only
 *
 * `verifyQuorumIsSigner` resolves the wallet through Privy's own wallet list, so a wallet
 * Privy did not issue — Freighter — cannot pass it by construction, whatever the user
 * approves in the browser. Running this for an external wallet would produce a guaranteed
 * failure on every connect rather than a binding, so it is skipped. Freighter proves
 * ownership with a SEP-53 challenge instead (`FreighterWalletSession`); that path does
 * not attach a Vanna signer and does not enable auto-approve.
 */

/** Per-tab record of wallets already bound, so a reload does not redo the round trip. */
const BOUND_KEY = "vanna.signer-bound";

function alreadyBound(wallet: string): boolean {
  try {
    return sessionStorage.getItem(`${BOUND_KEY}:${wallet}`) === "1";
  } catch {
    // Private mode or blocked storage: re-running the flow is harmless, so treat an
    // unreadable cache as "unknown" rather than failing the connect.
    return false;
  }
}

function rememberBound(wallet: string): void {
  try {
    sessionStorage.setItem(`${BOUND_KEY}:${wallet}`, "1");
  } catch {
    /* the flow simply runs again next load */
  }
}

async function post(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const headers = await copilotRequestHeaders();
    const res = await fetch("/api/copilot/wallet-bind", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
    });
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function WalletSignerAttach() {
  const address = useUserStore((s) => s.address);
  const walletKind = useUserStore((s) => s.walletKind);
  const privyAuthenticated = useUserStore((s) => s.privyAuthenticated);
  /** The wallet a run is in flight for, so React re-renders cannot start a second one. */
  const running = useRef<string | null>(null);

  useEffect(() => {
    if (!address || walletKind !== "privy" || !privyAuthenticated) return;
    if (running.current === address || alreadyBound(address)) return;

    const controls = getPrivyAuthControls();
    // The bridge registers these in its own effect; on the render where it has not yet,
    // the wallet store changing again re-runs this.
    if (typeof controls?.authorizeVannaSigner !== "function") return;
    const authorize = controls.authorizeVannaSigner;

    running.current = address;
    void (async () => {
      try {
        const started = await post({ action: "start" });
        if (started?.ok !== true) return;
        const requestId = typeof started.request_id === "string" ? started.request_id : "";
        const signerId = typeof started.signer_id === "string" ? started.signer_id : "";
        if (!requestId || !signerId) return;

        const authorized = await authorize(signerId);
        if (!authorized?.delegated) return;

        // The address Privy confirms is the one that gets registered, and it is the one
        // the cache must be keyed on. Caching the store's address instead would mark a
        // different wallet as bound whenever the two disagree.
        const boundAddress = authorized.address || address;
        const done = await post({
          action: "register",
          request_id: requestId,
          wallet_address: boundAddress,
        });
        // Only a reported write earns the cache entry. `null` (an older Sign Service that
        // cannot say) and `false` both leave it unset, so the next load tries again
        // instead of assuming a binding that may not exist.
        if (done?.ok === true && done.bound === true) {
          rememberBound(boundAddress);
        } else {
          console.warn(
            "[copilot] the wallet connected but Vanna could not record the identity binding",
            { wallet: boundAddress, reason: done?.reason ?? null },
          );
        }
      } catch (e) {
        // Includes the user dismissing Privy's sheet — a legitimate "no", not an error
        // worth interrupting them over. Writes still work; they just ask each time.
        console.warn(
          `[copilot] could not attach the Vanna signer (${
            e instanceof Error ? e.message : String(e)
          })`,
        );
      } finally {
        if (running.current === address) running.current = null;
      }
    })();
  }, [address, walletKind, privyAuthenticated]);

  return null;
}
