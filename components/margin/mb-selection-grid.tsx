"use client";

import { memo } from "react";
import Image from "next/image";
import { Checkbox } from "../ui/Checkbox";
import { Radio } from "../ui/radio-button";
import { iconPaths } from "@/lib/constants";
import { Collaterals } from "@/lib/types";
import { useTheme } from "@/contexts/theme-context";
import { formatTokenAmount, formatUsdValue } from "@/lib/utils/format-amount";

type Mode = "Deposit" | "Borrow";

interface MBSelectionGridProps {
  /** Margin-account collaterals available to leverage. Item id = `${asset}-${amount}`. */
  items: Collaterals[];
  /** Currently selected item ids. */
  selectedIds: Set<string>;
  /** "Deposit" renders multi-select checkboxes; "Borrow" renders single-select radios. */
  mode: Mode;
  /** Checkbox handler (Deposit mode); receives the item id and its prior selected state. */
  onToggle: (itemId: string, isSelected: boolean) => void;
  /** Radio handler (Borrow mode); receives the chosen item id. */
  onRadioSelect: (itemId: string) => void;
}

const MBSelectionGridComponent = ({
  items,
  selectedIds,
  mode,
  onToggle,
  onRadioSelect,
}: MBSelectionGridProps) => {
  const { isDark } = useTheme();
  
  return (
    <section className={`p-[10px] rounded-[12px] grid grid-cols-2 gap-[15px] ${
      isDark ? "bg-[#222222]" : "bg-[#F4F4F4]"
    }`}>
      {items.map((item, index) => {
        const itemId = `${item.asset}-${item.amount}`;
        const isSelected = selectedIds.has(itemId);

        return (
          <article key={index} className="flex gap-[10px] items-center">
            {mode === "Deposit" ? (
              <Checkbox
                checked={isSelected}
                onChange={() => onToggle(itemId, isSelected)}
              />
            ) : (
              <Radio
                name="mb-collateral-radio"
                value={`collateral-${index}`}
                checked={isSelected}
                onChange={() => onRadioSelect(itemId)}
              />
            )}
            <Image
              src={iconPaths[item.asset]}
              alt={item.asset}
              width={20}
              height={20}
            />
            <div className={`text-[16px] font-semibold ${
              isDark ? "text-white" : ""
            }`}>
              {formatTokenAmount(Number(item.amount) || 0)} {item.asset}
            </div>
            <div className={`rounded-[4px] py-[2px] px-[4px] text-[10px] font-medium ${
              isDark ? "bg-[#111111] text-white" : "bg-[#FFFFFF]"
            }`}>
              {formatUsdValue(Number(item.amountInUsd) || 0).replace("$", "")} USD
            </div>
          </article>
        );
      })}
    </section>
  );
};

/**
 * Two-column picker for selecting which margin-account (MB) collaterals to
 * leverage. Each cell shows the token icon, formatted amount, and USD value with
 * a checkbox (Deposit) or radio (Borrow) per {@link MBSelectionGridProps.mode}.
 *
 * Wrapped in {@link memo} with a custom comparator that deep-checks `items` and
 * the `selectedIds` set so it only re-renders on a real selection/data change.
 */
export const MBSelectionGrid = memo(MBSelectionGridComponent, (prevProps, nextProps) => {
  // Compare mode
  if (prevProps.mode !== nextProps.mode) return false;
  
  // Compare items array (reference check is fine if items don't change often)
  if (prevProps.items !== nextProps.items) {
    // Deep compare if reference changed
    if (prevProps.items.length !== nextProps.items.length) return false;
    for (let i = 0; i < prevProps.items.length; i++) {
      if (prevProps.items[i] !== nextProps.items[i]) return false;
    }
  }
  
  // Compare selectedIds Set
  if (prevProps.selectedIds !== nextProps.selectedIds) {
    if (prevProps.selectedIds.size !== nextProps.selectedIds.size) return false;
    for (const id of prevProps.selectedIds) {
      if (!nextProps.selectedIds.has(id)) return false;
    }
  }
  
  // Compare handlers (reference check)
  if (prevProps.onToggle !== nextProps.onToggle) return false;
  if (prevProps.onRadioSelect !== nextProps.onRadioSelect) return false;
  
  // All props are equal, skip re-render
  return true;
});

