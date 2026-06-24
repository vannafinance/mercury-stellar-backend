import { ActivePositionType, OpenOrderType } from "@/lib/types";
import createNewStore from "@/zustand";

// Spot-trading view state: the user's active positions and open orders.

/** Slice shape: active spot positions and outstanding open orders. */
export interface SpotTradeStateType {
  activePositions: ActivePositionType[];
  openOrders: OpenOrderType[];
}

const initialState: SpotTradeStateType = {
  activePositions: [],
  openOrders: [],
};

/**
 * Spot-trade store. Persisted so positions/orders survive reloads.
 */
export const useSpotTradeStore = createNewStore(initialState, {
  name: "spot-trade-store",
  devTools: true,
  persist: true,
});
