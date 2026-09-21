"use client";

import { useEffect, useRef } from "react";
import toast from "react-hot-toast";
import { establishWalletSession } from "@/lib/copilot/establish-wallet-session";
import { useUserStore } from "@/store/user";

/**
 * After Freighter is in the navbar, prove the G-address to the copilot.
 *
 * WalletSignerAttach is Privy-only: `verifyQuorumIsSigner` cannot name Freighter.
 * This is the replacement ownership proof — a SEP-53 challenge the extension
 * signs once per day. It does not attach a Vanna signer and does not enable
 * auto-approve. Writes still pop Freighter.
 */
export function FreighterWalletSession() {
  const address = useUserStore((s) => s.address);
  const walletKind = useUserStore((s) => s.walletKind);
  const running = useRef<string | null>(null);

  useEffect(() => {
    if (!address || walletKind !== "freighter") return;
    if (running.current === address) return;
    running.current = address;
    void (async () => {
      try {
        const ok = await establishWalletSession(address);
        if (!ok && useUserStore.getState().address === address) {
          toast.error(
            "Approve the Freighter signature so Copilot can read this wallet. The navbar is connected, but the request is not signed in until you do.",
          );
        }
      } catch (error) {
        console.warn(
          `[copilot] Freighter wallet proof failed (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
      } finally {
        if (running.current === address) running.current = null;
      }
    })();
  }, [address, walletKind]);

  return null;
}
