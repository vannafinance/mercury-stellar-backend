import { ActivePositionType, OpenOrderType } from "@/lib/types";
import createNewStore from "@/zustand";

export interface SpotTradeStateType {
  activePositions: ActivePositionType[];
  openOrders: OpenOrderType[];
}

const initialState: SpotTradeStateType = {
  activePositions: [],
  openOrders: [],
};

export const useSpotTradeStore = createNewStore(initialState, {
  name: "spot-trade-store",
  devTools: true,
  persist: true,
});
