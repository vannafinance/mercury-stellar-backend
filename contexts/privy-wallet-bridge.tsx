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

import { useEffect, useRef } from "react";
import { usePrivy, type WalletWithMetadata } from "@privy-io/react-auth";
import { useCreateWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";
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
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { createWallet } = useCreateWallet();
  const { signRawHash } = useSignRawHash();
  const creatingRef = useRef(false);

  // Expose login/logout to non-Privy UI (the navbar) via the adapter module.
  useEffect(() => {
    registerPrivyAuthControls({ login, logout });
    return () => registerPrivyAuthControls(null);
  }, [login, logout]);

  useEffect(() => {
    if (!ready || !authenticated || !user) return;

    const stellarWallet = findStellarWallet(user);

    if (!stellarWallet) {
      if (creatingRef.current) return;
      creatingRef.current = true;
      createWallet({ chainType: "stellar" })
        .catch((error) => {
          console.error("Failed to create Privy Stellar wallet:", error);
        })
        .finally(() => {
          creatingRef.current = false;
        });
      return;
    }

    registerPrivyBridge({ address: stellarWallet.address, signRawHash });
    setActiveWalletKind("privy");

    useUserStore.getState().set({
      address: stellarWallet.address,
      isConnected: true,
      walletKind: "privy",
      manuallyDisconnected: false,
    });
  }, [ready, authenticated, user, createWallet, signRawHash]);

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
          tokenBalances: { XLM: "0", USDC: "0" },
          depositedBalances: { XLM: "0", USDC: "0" },
        });
        clearMarginAccount();
      }
    }
  }, [ready, authenticated]);

  return null;
};
