import createNewStore from "@/zustand/index";

// Holds the vault the user is currently viewing on the Earn page, so a list row
// click can drive a detail panel without prop-drilling.

// Types
/** Display model for one earn vault row (title/tag pairs ready for the table UI). */
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

/** Slice shape: the currently selected vault, or null when none is open. */
export interface EarnVaultState {
  selectedVault: VaultData | null;
}

// Initial State
const initialState: EarnVaultState = {
  selectedVault: null,
};

// Export Store
//
// Not persisted — selection is transient view state.
export const useEarnVaultStore = createNewStore(initialState, {
  name: "earn-vault-store",
  devTools: true,
  persist: false, // Don't persist for now
});

