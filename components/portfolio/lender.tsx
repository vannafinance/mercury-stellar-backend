import { useMemo } from "react";
import { AccountStatsGhost } from "../earn/account-stats-ghost";
import { RewardsTable } from "../earn/rewards-table";
import { useTheme } from "@/contexts/theme-context";
import { useWallet } from "@/hooks/use-wallet";

export const Lender = () => {
    const { isDark } = useTheme();
    const { address, balance, depositedBalances } = useWallet();

    const accountStatsItems = useMemo(() => {
        if (!address) {
          return [
            { id: "1", name: "Total Assets", amount: "Connect Wallet" },
            { id: "2", name: "Net P&L", amount: "Connect Wallet" },
            { id: "3", name: "Total Volume", amount: "Connect Wallet" },
          ];
        }

        const xlmValue = parseFloat(depositedBalances.XLM || '0');
        const usdcValue = parseFloat(depositedBalances.USDC || '0');
        const totalDeposited = xlmValue + usdcValue;

        return [
          { id: "1", name: "Total Assets", amount: `$${totalDeposited.toFixed(2)}` },
          { id: "2", name: "Wallet Balance", amount: `${parseFloat(String(balance || '0')).toFixed(2)} XLM` },
          { id: "3", name: "XLM Deposited", amount: `${parseFloat(String(depositedBalances.XLM || '0')).toFixed(2)} XLM` },
          { id: "4", name: "USDC Deposited", amount: `${parseFloat(String(depositedBalances.USDC || '0')).toFixed(2)} USDC` },
        ];
      }, [address, balance, depositedBalances]);

  return (
    <div className="w-full h-fit flex flex-col gap-6 sm:gap-[40px]">
      <div className="w-full h-fit flex flex-col lg:flex-row gap-4 lg:gap-[20px]">
        <div className="w-full lg:w-[422px] h-fit flex flex-col gap-[14px]">
          <AccountStatsGhost items={accountStatsItems} type="background" gridCols="grid-cols-2" gridRows="grid-rows-2" />
          <RewardsTable />
        </div>

        <div className={`w-full h-[300px] sm:h-[551px] rounded-[20px] border-[1px] p-4 sm:p-[20px] ${isDark ? "bg-[#222222]" : "bg-[#F7F7F7]"}`}>
        </div>
      </div>
    </div>
  );
}
