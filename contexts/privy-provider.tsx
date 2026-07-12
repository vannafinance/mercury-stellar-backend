"use client";

// Wraps Privy's React SDK provider. Isolated in its own file (matching
// theme-context.tsx / query-provider.tsx) so the @privy-io/react-auth import
// stays contained to one place.

import React from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { PrivyWalletBridge } from "@/contexts/privy-wallet-bridge";

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

/**
 * Mounts Privy's provider when an app ID is configured. Login via
 * email/Google; Stellar embedded-wallet creation is triggered imperatively by
 * `PrivyWalletBridge` (Stellar has no `createOnLogin` shorthand — it's a
 * Tier 2 "extended chain" for Privy).
 *
 * Renders children unwrapped if `NEXT_PUBLIC_PRIVY_APP_ID` isn't set, so the
 * app still runs (Freighter-only) before Privy is configured.
 */
export const AppPrivyProvider = ({ children }: { children: React.ReactNode }) => {
  if (!PRIVY_APP_ID) {
    return <>{children}</>;
  }

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["email", "google"],
        appearance: {
          theme: "dark",
        },
      }}
    >
      {children}
      <PrivyWalletBridge />
    </PrivyProvider>
  );
};
