"use client";

// Bridges Privy's React hooks (only usable inside the PrivyProvider tree)
// into the plain-function wallet-adapter module and the zustand user store,
// both of which are consumed from outside React (lib/*.ts) or from
// components that don't otherwise touch Privy. Renders nothing.
//
// Stellar is a Privy "Tier 2" chain: creating the embedded wallet has no
// createOnLogin shorthand, so it's created imperatively here right after
// login, and signing only exposes raw-hash signing (useSignRawHash) which
// lib/wallet-adapter.ts turns into signed transaction XDR.

import { useCallback, useEffect, useRef } from "react";
import { usePrivy, type WalletWithMetadata } from "@privy-io/react-auth";
import { useCreateWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";
import toast from "react-hot-toast";
import {
  registerPrivyBridge,
  registerPrivyAuthControls,
  setActiveWalletKind,
} from "@/lib/wallet-adapter";
import { useUserStore } from "@/store/user";
import { clearMarginAccount } from "@/store/margin-account-info-store";

function findStellarWallet(user: ReturnType<typeof usePrivy>["user"]): WalletWithMetadata | undefined {
  return user?.linkedAccounts.find(
    (account): account is WalletWithMetadata =>
      account.type === "wallet" &&
      account.walletClientType === "privy" &&
      account.chainType === "stellar"
  );
}

export const PrivyWalletBridge = () => {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { createWallet } = useCreateWallet();
  const { signRawHash } = useSignRawHash();
  const creatingRef = useRef(false);

  /**
   * Point the adapter and the user store at the session's embedded Stellar
   * wallet. Idempotent, so it's safe both as the login effect's happy path and
   * as the `resync` escape hatch handed to the connect flow.
   */
  const syncStellarWallet = useCallback((): boolean => {
    const stellarWallet = findStellarWallet(user);
    if (!stellarWallet) return false;

    registerPrivyBridge({ address: stellarWallet.address, signRawHash });
    setActiveWalletKind("privy");

    useUserStore.getState().set({
      address: stellarWallet.address,
      isConnected: true,
      walletKind: "privy",
      manuallyDisconnected: false,
    });
    return true;
  }, [user, signRawHash]);

  // Expose login/logout to non-Privy UI (the navbar) via the adapter module.
  // getAccessToken rides along so server calls can carry the session's identity
  // as an end-user assertion without any component importing Privy's hooks.
  useEffect(() => {
    registerPrivyAuthControls({
      login,
      logout,
      authenticated,
      resync: syncStellarWallet,
      getAccessToken,
    });
    return () => registerPrivyAuthControls(null);
  }, [login, logout, authenticated, syncStellarWallet, getAccessToken]);

  useEffect(() => {
    if (!ready || !authenticated || !user) return;

    if (syncStellarWallet()) return;

    // No embedded Stellar wallet on the account yet — create one.
    if (creatingRef.current) return;
    creatingRef.current = true;
    createWallet({ chainType: "stellar" })
      .then(() => {
        // linkedAccounts updates asynchronously after create; retry sync shortly.
        setTimeout(() => {
          try {
            if (syncStellarWallet()) {
              const addr = useUserStore.getState().address;
              const short =
                addr && addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
              toast.success(
                short
                  ? `Vanna wallet created & saved · ${short}`
                  : "Vanna wallet created and saved to your account",
                { duration: 5000 },
              );
            }
          } catch {
            /* ignore */
          }
        }, 500);
        setTimeout(() => {
          try {
            syncStellarWallet();
          } catch {
            /* ignore */
          }
        }, 2000);
      })
      .catch((error) => {
        console.error("Failed to create Privy Stellar wallet:", error);
        toast.error("Could not create Vanna wallet — try again or use Freighter");
      })
      .finally(() => {
        creatingRef.current = false;
      });
  }, [ready, authenticated, user, createWallet, syncStellarWallet]);

  // Keep the adapter bridge warm whenever Privy reports a Stellar wallet —
  // covers hot reload (module state cleared) and late linkedAccounts updates.
  useEffect(() => {
    if (!ready || !authenticated || !user) return;
    syncStellarWallet();
  }, [ready, authenticated, user, user?.linkedAccounts, signRawHash, syncStellarWallet]);

  // Clear everything on logout so a stale Privy signer/address can't linger.
  useEffect(() => {
    if (ready && !authenticated) {
      registerPrivyBridge(null);
      const { walletKind } = useUserStore.getState();
      if (walletKind === "privy") {
        setActiveWalletKind(null);
        useUserStore.getState().set({
          address: null,
          isConnected: false,
          walletKind: null,
          balance: "0",
          tokenBalances: { XLM: "0", USDC: "0", BLEND_USDC: "0", AQUARIUS_USDC: "0", SOROSWAP_USDC: "0" },
          depositedBalances: { XLM: "0", USDC: "0", AQUARIUS_USDC: "0", SOROSWAP_USDC: "0" },
        });
        clearMarginAccount();
      }
    }
  }, [ready, authenticated]);

  return null;
};
