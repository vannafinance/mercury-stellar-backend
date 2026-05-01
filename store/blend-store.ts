import { create } from "zustand";

/**
 * Simple store used to coordinate cross-component Blend position refreshes.
 * When AddLiquidity or RemoveLiquidity completes a transaction, they call
 * `triggerRefresh()` which increments `refreshKey`. Any hook that depends on
 * `refreshKey` (useUserBlendPositions, useBlendEvents) will re-fetch.
 */
interface BlendStoreState {
  refreshKey: number;
  triggerRefresh: () => void;
}

export const useBlendStore = create<BlendStoreState>()((set) => ({
  refreshKey: 0,
  triggerRefresh: () => set((state) => ({ refreshKey: state.refreshKey + 1 })),
}));
