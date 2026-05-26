"use client";

import { useEffect } from "react";
import { useUserStore } from "@/store/user";
import { checkUserMarginAccount } from "@/store/margin-account-info-store";

/**
 * Hydrates the margin store's `marginAccountAddress` whenever the wallet
 * connects, so any page can read it on first render. Without this, direct
 * navigation to /farm, /trade or /portfolio leaves hooks like
 * useUserBlendPositions and useAllAquariusLpPositions querying with
 * marginAccountAddress = null — they return empty data even though the user
 * has a margin account on-chain. Visiting /margin first would hydrate the
 * store; this lifts that side-effect to the layout level so it always runs.
 *
 * `checkUserMarginAccount` is internally dedup-safe and rate-limited (see
 * inflightCheckByUser / lastCheckByUser in margin-account-info-store), so
 * mounting this component once and letting it fire on every connect is cheap.
 */
export function MarginAccountHydrator() {
  const address = useUserStore((s) => s.address);
  const isConnected = useUserStore((s) => s.isConnected);

  useEffect(() => {
    if (address && isConnected) {
      checkUserMarginAccount(address).catch(console.error);
    }
  }, [address, isConnected]);

  return null;
}
