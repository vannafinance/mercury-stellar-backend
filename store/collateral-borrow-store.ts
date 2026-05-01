import createNewStore from "@/zustand/index";
import { BorrowInfo, Collaterals, Position } from "@/lib/types";
import { POSITION } from "@/lib/constants/margin";

// Types
export interface CollateralBorrowStateType {
  collaterals: Collaterals[];
  borrowItems: BorrowInfo[];
  position: Position[];
}

// Initial State
const initialState: CollateralBorrowStateType = {
  collaterals: [
    {
      asset: "USDT",
      amount: 1500,
      amountInUsd: 1500,
      balanceType: "wb",
      unifiedBalance: 1500,
    },
    {
      asset: "USDC",
      amount: 1200,
      amountInUsd: 1200,
      balanceType: "mb",
      unifiedBalance: 1200,
    },
    {
      asset: "ETH",
      amount: 0.8,
      amountInUsd: 2200,
      balanceType: "wb",
      unifiedBalance: 2200,
    },
  ],
  borrowItems:[
    {
      assetData: { asset: "0xUSDC", amount: "1000" },
      percentage: 60,
      usdValue: 100,
    },
    {
      assetData: { asset: "0xETH", amount: "22000" }, // 0.022 ETH
      percentage: 40,
      usdValue: 403.67,
    },
  ] ,
  position: JSON.parse(JSON.stringify(POSITION)) as Position[],
};

// Export Store
export const useCollateralBorrowStore = createNewStore(initialState, {
  name: "collateral-borrow-store",
  devTools: true,
  persist: {
    name: "collateral-borrow-store",
    version: 2, // Increment version to clear old persisted data and load new POSITION data
    migrate: (persistedState: any, version: number) => {
      // Migrate from version 1 to version 2
      if (version === 1) {
        return {
          ...persistedState,
          position: JSON.parse(JSON.stringify(POSITION)) as Position[],
        };
      }
      // For any other version, return the persisted state as-is
      return persistedState;
    },
  },
});

