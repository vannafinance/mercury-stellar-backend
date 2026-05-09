import { create } from "zustand";

export type Theme = "light" | "dark";

interface ThemeStore {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
}

export const useThemeStore = create<ThemeStore>((set) => ({
  theme: "light",
  toggle: () =>
    set((s) => ({ theme: s.theme === "light" ? "dark" : "light" })),
  setTheme: (theme) => set({ theme }),
}));

/** Theme-aware chart colors (Recharts takes inline strings, not CSS vars) */
export function useChartColors() {
  const theme = useThemeStore((s) => s.theme);

  return theme === "dark"
    ? {
        violet: "#8b5cf6",
        electric: "#10b981",
        imperial: "#ef4444",
        rose: "#f43f5e",
        accent2: "#a78bfa",
        axisText: "#64748b",
        tooltip: {
          background: "#0f172a",
          border: "1px solid #1e293b",
          borderRadius: 8,
          color: "#e2e8f0",
          fontSize: 12,
        },
        legendColor: "#94a3b8",
      }
    : {
        violet: "#703AE6",
        electric: "#32EEE2",
        imperial: "#FC5457",
        rose: "#FF007A",
        accent2: "#9F7BEE",
        axisText: "#949494",
        tooltip: {
          background: "#1E1E1E",
          border: "none",
          borderRadius: 8,
          color: "#ffffff",
          fontSize: 12,
        },
        legendColor: "#595959",
      };
}
