import createNewStore from "@/zustand/index";

// Types
export interface FarmRowData {
  cell: {
    chain?: string;
    icon?: string;
    title?: string;
    titles?: string[];
    description?: string;
    tag?: string | number;
    tags?: (string | number)[];
    clickable?: string;
    onlyIcons?: string[];
    percentage?: number;
    value?: string;
  }[];
}

export interface FarmState {
  selectedRow: FarmRowData | null;
  tabType: "single" | "multi" | null;
}

// Initial State
const initialState: FarmState = {
  selectedRow: null,
  tabType: null,
};

// Export Store
export const useFarmStore = createNewStore(initialState, {
  name: "farm-store",
  devTools: true,
  persist: false, // Don't persist for now
});

