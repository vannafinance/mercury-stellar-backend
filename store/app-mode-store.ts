import createNewStore from "@/zustand/index";

/** UI complexity tier: "pro" exposes the full feature set; "lite" hides advanced flows (e.g. Earn). */
export type AppMode = "pro" | "lite";

/** App-mode slice shape. */
export interface AppModeState {
  mode: AppMode;
}

const initialState: AppModeState = {
  mode: "pro",
};

/**
 * Global UI-mode store. Holds the pro/lite toggle that gates which features are
 * shown. Persisted so the user's chosen mode survives reloads.
 */
export const useAppModeStore = createNewStore(initialState, {
  name: "app-mode-store",
  devTools: true,
  persist: true,
});
