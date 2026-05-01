import { useTheme } from "@/contexts/theme-context";

interface AccountStatsItem {
  id: string;
  name: string;
  amount: string;
  amountInToken?: string;
}

interface AccountStatsGhostProps {
  items: AccountStatsItem[];
  type?: "standard" | "background" | "background-light";
  gridCols?: string; // e.g., "grid-cols-3", "grid-cols-2", etc.
  gridRows?: string; // e.g., "grid-rows-1", "grid-rows-2", etc.
}

export const AccountStatsGhost = ({ items, type = "standard", gridCols, gridRows }: AccountStatsGhostProps) => {
  const { isDark } = useTheme();

  // Determine if we should use grid layout
  const useGrid = type === "background" || type === "background-light" || (gridCols && gridRows);

  // Default grid classes if not provided
  const defaultGridCols = gridCols || "grid-cols-3";
  const defaultGridRows = gridRows || "grid-rows-1";

  // Build container class
  let containerClass = "w-full h-fit rounded-xl p-3 border transition-colors";
  containerClass += isDark
    ? " bg-[#1A1A1A] border-[#2A2A2A] hover:border-[#333333]"
    : " bg-white border-[#E8E8E8] hover:border-[#E2E2E2]";

  if (useGrid) {
    containerClass += ` grid ${defaultGridCols} ${defaultGridRows} gap-x-3 gap-y-5`;
  } else {
    containerClass += " grid grid-cols-2 sm:flex sm:items-stretch sm:justify-between gap-x-3 gap-y-4";
  }

  return (
    <section className={containerClass} aria-label="Statistics Overview">
      {items.map((item, index) => {
        const articleClass = useGrid
          ? "w-full h-fit flex flex-col gap-1.5"
          : "flex-1 min-w-0 flex flex-col gap-1.5 justify-center";

        const borderClass = "";

        return (
          <article
            key={item.id}
            className={`${articleClass} ${borderClass} ${useGrid ? "" : "px-2 sm:px-4"}`}
          >
            <h3 className={`text-[11px] sm:text-[12px] font-medium sm:whitespace-nowrap ${
              isDark ? "text-[#A7A7A7]" : "text-[#777777]"
            }`}>
              {item.name}
            </h3>
            <div className="w-full h-fit flex flex-col gap-0.5">
              <p className={`text-[18px] sm:text-[20px] font-semibold leading-tight ${
                isDark ? "text-white" : "text-[#111111]"
              }`}>
                {item.amount}
              </p>
              {item.amountInToken && (
                <p className={`text-[12px] font-medium ${
                  isDark ? "text-[#777777]" : "text-[#A7A7A7]"
                }`}>
                  {item.amountInToken}
                </p>
              )}
            </div>
          </article>
        );
      })}
    </section>
  );
};
