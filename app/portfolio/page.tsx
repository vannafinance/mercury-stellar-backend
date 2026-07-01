"use client";

import { PortfolioSection } from "@/components/portfolio/portfolio-section";
import { Button } from "@/components/ui/button";
import { DepositModal } from "@/components/portfolio/deposit-modal";
import { WithdrawModal } from "@/components/portfolio/withdraw-modal";
import { HistoryModal } from "@/components/portfolio/history-modal";
import { useWallet } from "@/hooks/use-wallet";
import { useUserStore } from "@/store/user";
import { useTheme } from "@/contexts/theme-context";
import { useState, useEffect } from "react";

export default function PortfolioPage() {
  const { isDark } = useTheme();
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const { refreshBalances } = useWallet();
  const userAddress = useUserStore((s) => s.address);

  // Load the connected wallet's token balances so "Wallet Balance" is real on a
  // direct Portfolio visit (the margin page normally triggers this). One-shot on
  // connect — not polled; the Refresh button re-pulls on demand.
  useEffect(() => {
    if (userAddress) refreshBalances(userAddress).catch(() => {});
  }, [userAddress, refreshBalances]);

  return (
    <>
      <div className="px-4 sm:px-10 lg:px-30 pt-4 sm:pt-6 pb-8 lg:pb-0 w-full h-fit">
        <div className="flex flex-col gap-4 sm:gap-5 w-full h-fit">
          {/* Header */}
          <div className="flex flex-col sm:flex-row justify-between w-full gap-3 sm:items-center">
            <div className="flex items-center gap-3">
              <div className="w-1 h-6 sm:hidden rounded-full bg-[#703AE6]" />
              <h1 className={`text-[22px] sm:text-[24px] font-bold ${isDark ? "text-white" : "text-black"}`}>
                Portfolio
              </h1>
            </div>
            <div className="grid grid-cols-4 sm:flex gap-2 sm:gap-2 sm:justify-end">
              <Button
                text="Deposit"
                size="small"
                type="solid"
                disabled={false}
                onClick={() => setShowDepositModal(true)}
              />
              <Button
                text="Withdraw"
                size="small"
                type="solid"
                disabled={false}
                onClick={() => setShowWithdrawModal(true)}
              />
              <Button
                text="Refresh"
                size="small"
                type="solid"
                disabled={false}
                onClick={() => refreshBalances()}
              />
              <Button
                text="History"
                size="small"
                type="solid"
                disabled={false}
                onClick={() => setShowHistoryModal(true)}
              />
            </div>
          </div>

          <PortfolioSection />
        </div>
      </div>

      <DepositModal isOpen={showDepositModal} onClose={() => setShowDepositModal(false)} />
      <WithdrawModal isOpen={showWithdrawModal} onClose={() => setShowWithdrawModal(false)} />
      <HistoryModal isOpen={showHistoryModal} onClose={() => setShowHistoryModal(false)} />
    </>
  );
}
