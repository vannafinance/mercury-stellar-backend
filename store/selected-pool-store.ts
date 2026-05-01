import createNewStore from "@/zustand/index";
import { AssetType, ASSET_TYPES } from "@/lib/stellar-utils";

export interface SelectedPoolState {
  selectedAsset: AssetType;
  selectedPoolData: {
    id: string;
    chain: string;
    title: string;
    tag?: string;
  } | null;
}

const initialState: SelectedPoolState = {
  selectedAsset: ASSET_TYPES.XLM,
  selectedPoolData: null,
};

export const useSelectedPoolStore = createNewStore(initialState, {
  name: "selected-pool-store",
  devTools: true,
  persist: false,
});

// Helper functions
export const setSelectedPool = (
  asset: AssetType,
  poolData?: {
    id: string;
    chain: string;
    title: string;
    tag?: string;
  }
) => {
  useSelectedPoolStore.getState().set({
    selectedAsset: asset,
    selectedPoolData: poolData || {
      id: asset,
      chain: asset,
      title: asset,
      tag: "Active"
    }
  });
};

export const getSelectedAsset = (): AssetType => {
  return useSelectedPoolStore.getState().selectedAsset;
};