"use client";

import { useCallback, useEffect, useRef } from "react";
import toast from "react-hot-toast";
import { establishWalletSession } from "@/lib/copilot/establish-wallet-session";
import { useUserStore } from "@/store/user";

/**
 * After Freighter is in the navbar, prove the G-address to the copilot.
 *
 * WalletSignerAttach is Privy-only: `verifyQuorumIsSigner` cannot name Freighter.
 * This is the replacement ownership proof - a SEP-53 challenge the extension
 * signs once per day. It does not attach a Vanna signer and does not enable
 * auto-approve. Writes still pop Freighter.
 */
export function FreighterWalletSession() {
  const address = useUserStore((s) => s.address);
  const walletKind = useUserStore((s) => s.walletKind);
  const running = useRef<string | null>(null);

  const prove = useCallback(async (): Promise<void> => {
    if (!address || walletKind !== "freighter") return;
    if (running.current === address) return;
    running.current = address;
    const noticeId = `freighter-proof:${address}`;
    const needsRetry = () => {
      const current = useUserStore.getState();
      if (current.address !== address || current.walletKind !== "freighter") return;
      toast((notice) => <div role="alert">
        <p>Verify this Freighter wallet so Copilot can read it. This signs a message, with no transaction fee.</p>
        <button type="button" onClick={() => { toast.dismiss(notice.id); void prove(); }}>Verify wallet</button>
      </div>, { id: noticeId, duration: Infinity });
    };
      try {
        const ok = await establishWalletSession(address);
        if (!ok) needsRetry();
        else toast.dismiss(noticeId);
      } catch (error) {
        console.warn(
          `[copilot] Freighter wallet proof failed (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
        needsRetry();
      } finally {
        if (running.current === address) running.current = null;
      }
  }, [address, walletKind]);

  useEffect(() => {
    void prove();
    return () => { if (address) toast.dismiss(`freighter-proof:${address}`); };
  }, [prove]);

  return null;
}
