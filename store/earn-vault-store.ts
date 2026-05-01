import createNewStore from "@/zustand/index";

// Types
export interface VaultData {
  id: string;
  chain: string;
  title: string;
  tag: string;
  assetsSupplied: {
    title: string;
    tag: string;
  };
  supplyApy: {
    title: string;
    tag: string;
  };
  assetsBorrowed: {
    title: string;
    tag: string;
  };
  borrowApy: {
    title: string;
    tag: string;
  };
  utilizationRate: {
    title: string;
    tag: string;
  };
  collateral: {
    onlyIcons: string[];
    tag: string;
  };
}

export interface EarnVaultState {
  selectedVault: VaultData | null;
}

// Initial State
const initialState: EarnVaultState = {
  selectedVault: null,
};

// Export Store
export const useEarnVaultStore = createNewStore(initialState, {
  name: "earn-vault-store",
  devTools: true,
  persist: false, // Don't persist for now
});

