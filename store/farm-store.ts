import createNewStore from "@/zustand/index";

// Tracks the selected Farm table row and active tab (single- vs multi-asset), so
// a row click can open the matching detail view.

// Types
/** Display model for one Farm table row: an array of cells, each a loosely-typed bag of render fields. */
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

/** Slice shape: the selected row and which Farm tab it came from. */
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
//
// Not persisted — selection is transient view state.
export const useFarmStore = createNewStore(initialState, {
  name: "farm-store",
  devTools: true,
  persist: false, // Don't persist for now
});

