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
 * Runtime-only view state. Real orders/positions must be rebuilt from chain
 * data; browser persistence can never be their source of truth.
 */
export const useSpotTradeStore = createNewStore(initialState, {
  name: "spot-trade-store",
  devTools: true,
});
