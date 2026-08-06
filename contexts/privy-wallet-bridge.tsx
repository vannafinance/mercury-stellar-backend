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
import { usePrivy, useSigners, type WalletWithMetadata } from "@privy-io/react-auth";
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
  const { addSigners } = useSigners();
  const creatingRef = useRef(false);

  /**
   * Grant a Vanna signer quorum delegated signing on the user's own Stellar wallet.
   *
   * Same three-line consent the standalone connect page performs — locate the
   * embedded wallet, create it if the account somehow has none yet, then
   * `addSigners({ address, signers: [{ signerId }] })` with NO policyIds, because
   * Privy policies do not support Stellar. Doing it here rather than on a separate
   * page is the whole point: the user is already authenticated in this tab, so
   * turning auto-sign on can complete the binding in the same gesture.
   *
   * `addSigners` returns the updated user, so `delegated` is read back from that
   * rather than waiting for `linkedAccounts` to refresh — the caller needs a definite
   * answer before it asks the server to register the binding.
   */
  const authorizeVannaSigner = useCallback(
    async (signerId: string): Promise<{ address: string; delegated: boolean }> => {
      if (!signerId) throw new Error("No Vanna signer id was provided.");

      let wallet = findStellarWallet(user);
      if (!wallet) {
        await createWallet({ chainType: "stellar" });
        // linkedAccounts updates asynchronously; poll briefly rather than failing a
        // flow the user just started.
        for (let i = 0; i < 10 && !wallet; i += 1) {
          await new Promise((r) => setTimeout(r, 300));
          wallet = findStellarWallet(user);
        }
        if (!wallet) {
          throw new Error("Your Vanna wallet is still being created — try again in a moment.");
        }
      }
      // Already granted: return without prompting again.
      if (wallet.delegated) return { address: wallet.address, delegated: true };

      const { user: updated } = await addSigners({
        address: wallet.address,
        signers: [{ signerId }],
      });
      const after = findStellarWallet(updated);
      return {
        address: after?.address ?? wallet.address,
        delegated: after?.delegated === true,
      };
    },
    [user, createWallet, addSigners],
  );

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
      authorizeVannaSigner,
    });
    return () => registerPrivyAuthControls(null);
  }, [login, logout, authenticated, syncStellarWallet, getAccessToken, authorizeVannaSigner]);

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
