import createNewStore from "@/zustand/index";

export type AppMode = "pro" | "lite";

export interface AppModeState {
  mode: AppMode;
}

const initialState: AppModeState = {
  mode: "pro",
};

export const useAppModeStore = createNewStore(initialState, {
  name: "app-mode-store",
  devTools: true,
  persist: true,
});
