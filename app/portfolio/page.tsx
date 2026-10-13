"use client";

import { useEffect } from "react";
import { PortfolioV3 } from "@/components/portfolio/portfolio-v3";
import { useWallet } from "@/hooks/use-wallet";
import { useUserStore } from "@/store/user";

/**
 * Portfolio route: the V3 design page (components/portfolio/portfolio-v3.tsx).
 */
export default function PortfolioPage() {
  const { refreshBalances } = useWallet();
  const userAddress = useUserStore((s) => s.address);

  // Load the connected wallet's token balances so "Wallet" is real on a
  // direct Portfolio visit (the margin page normally triggers this).
  useEffect(() => {
    if (userAddress) refreshBalances(userAddress).catch(() => {});
  }, [userAddress, refreshBalances]);

  return (
    <div className="v3 page">
      <PortfolioV3 />
    </div>
  );
}
