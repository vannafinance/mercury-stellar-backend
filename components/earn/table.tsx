import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  memo,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AnimatedTabs } from "../ui/animated-tabs";
import { FilterDropdown } from "../ui/filter-dropdown";
import { SearchBar } from "../ui/search-bar";
import Image from "next/image";
import { iconPaths } from "@/lib/constants";
import { useDebounce } from "@/hooks/use-debounce";
import { SupplyApy } from "./supply-apy";
import { PieChart } from "../ui/pie-chart";
import { ProgressBar } from "../ui/progress-bar";
import { useTheme } from "@/contexts/theme-context";
import { Dropdown } from '../ui/dropdown';

const ITEMS_PER_PAGE = 4;

const FILTER_OPTIONS = {
  collateral: ["XLM", "USDC"],
  collateralFilters: ["All", "XLM", "USDC"],
  deposit: ["XLM", "USDC"],
  depositFilters: ["All"],
  allChains: ["XLM", "USDC"],
  allChainsFilters: ["All", "XLM", "USDC"],
  all: ["XLM", "USDC"],
  allFilters: ["All", "XLM", "USDC"],
  vaults: ["XLM", "USDC"],
  vaultsFilters: ["All", "XLM", "USDC"],
  curator: ["Vanna"],
  curatorFilters: ["All"],
  provider: ["Stellar"],
  providerFilters: ["All"],
  protocol: ["v1"]
};

interface TableProps {
  tableBodyBackground?: string;
  tableHeadingTextColor?: string;
  heading: {
    tabsItems?: { label: string; id: string }[];
    heading?: string;
    tabType?: "solid" | "underline";
  };
  activeTab?: string;
  onTabChange?: (tabId: string) => void;
  filters?: {
    filters?: string[];
    customizeDropdown?: boolean;
    supplyApyTab?: boolean;
    supplyApyLabel?: string; // Custom label for "Supply APY is"
    anythingLabel?: string; // Custom label for "Anything"
    allChainDropdown?: boolean;
    filterTabType?: "solid" | "underline" | "ghost"; // For Lending/LP tabs
  };
  filterTabTypeOptions?: { id: string; label: string }[]; // e.g., ["Lending/Single Assets", "LP/Multiple Assets"]
  activeFilterTab?: string;
  onFilterTabTypeChange?: (filterTabId: string) => void;
  filterDropdownPosition?: "left" | "right"; // Control dropdown position (default: "left")
  tableHeadings: { label: string; id: string; icon?: boolean }[];
  tableBody: {
    rows: {
      cell: {
        chain?: string;
        icon?: string;
        title?: string;
        titles?: string[]; // Multiple titles separated by slash (e.g., ["USDT", "BNB"]) - icons auto-derived from iconPaths
        description?: string;
        tag?: string | number;
        tags?: (string | number)[]; // Multiple tags
        clickable?: string;
        onlyIcons?: string[];
        percentage?: number;
        value?: string;
      }[];
    }[];
  };
  onRowClick?: (row: any, rowIndex: number) => void;
  hoverBackground?: string;
  showPieChart?: boolean;
  showProgressBar?: boolean;
}

type FiltersState = {
  allChains: string[];
  collateral: string[];
  deposit: string[];
  all: string[];
  customize: string[];
  vaults: string[];
  curator: string[];
  provider: string[];
  protocol: string[];
};

type SupplyApyFilter = {
  percentage: number;
  greaterThan: boolean;
};

/* ---------- FILTER LOGIC (unchanged behavior) ---------- */

const applyFilters = (
  rows: TableProps["tableBody"]["rows"],
  searchLower: string,
  filtersState: FiltersState,
  supplyApyFilter: SupplyApyFilter,
  hasSupplyApyColumn: boolean,
  supplyApyColumnIndex: number,
  tableHeadings: TableProps["tableHeadings"]
) => {
  const hasAllChainsFilter =
    filtersState.allChains.length > 0 &&
    !filtersState.allChains.includes("All");
  const hasDepositFilter = filtersState.deposit.length > 0;
  const hasCollateralFilter =
    filtersState.collateral.length > 0 &&
    !filtersState.collateral.includes("All");
  const hasSupplyApyFilter =
    hasSupplyApyColumn && supplyApyFilter.percentage > 0;
  const hasAllFilter =
    filtersState.all.length > 0 && !filtersState.all.includes("All");
  const hasVaultsFilter =
    filtersState.vaults.length > 0 && !filtersState.vaults.includes("All");
  const hasCuratorFilter =
    filtersState.curator.length > 0 && !filtersState.curator.includes("All");
  const hasProviderFilter =
    filtersState.provider.length > 0 && !filtersState.provider.includes("All");
  const hasProtocolFilter =
    filtersState.protocol.length > 0 && !filtersState.protocol.includes("All");

  if (
    !searchLower &&
    !hasAllChainsFilter &&
    !hasDepositFilter &&
    !hasCollateralFilter &&
    !hasSupplyApyFilter &&
    !hasAllFilter &&
    !hasVaultsFilter &&
    !hasCuratorFilter &&
    !hasProviderFilter &&
    !hasProtocolFilter
  ) {
    return rows;
  }

  const typeColumnIndex = tableHeadings.findIndex(
    (h) => h.id === "type" || h.label.toLowerCase() === "type"
  );

  return rows.filter((row) => {
    if (
      searchLower &&
      !row.cell.some((cell) => cell.title?.toLowerCase().includes(searchLower))
    ) {
      return false;
    }

    if (hasAllChainsFilter) {
      const poolTitle = row.cell[0]?.title?.toUpperCase() || "";
      if (!poolTitle || !filtersState.allChains.some((c) => poolTitle.includes(c.toUpperCase())))
        return false;
    }

    if (hasDepositFilter) {
      const poolName = row.cell[0]?.title?.toUpperCase() || "";
      if (!filtersState.deposit.some((d) => poolName.includes(d.toUpperCase())))
        return false;
    }

    if (hasCollateralFilter) {
      const collateralIcons = row.cell[row.cell.length - 1]?.onlyIcons || [];
      if (!filtersState.collateral.some((c) => collateralIcons.includes(c)))
        return false;
    }

    if (hasSupplyApyFilter) {
      const supplyApyCell = row.cell[supplyApyColumnIndex];
      if (!supplyApyCell?.title) return false;

      let cellValue = 0;
      const cellTitle = supplyApyCell.title;

      // Check for percentage (e.g., "5.5%")
      const percentageMatch = cellTitle.match(/(\d+\.?\d*)%/);
      if (percentageMatch) {
        cellValue = parseFloat(percentageMatch[1]);
      } else {
        // Check for Million (e.g., "$1.2M" or "1.2M")
        const millionMatch = cellTitle.match(/\$?(\d+\.?\d*)\s*M/i);
        if (millionMatch) {
          cellValue = parseFloat(millionMatch[1]);
        } else {
          // Check for Billion (e.g., "$1.2B" or "1.2B")
          const billionMatch = cellTitle.match(/\$?(\d+\.?\d*)\s*B/i);
          if (billionMatch) {
            cellValue = parseFloat(billionMatch[1]);
          } else {
            // Check for Thousand (e.g., "$1.2K" or "1.2K")
            const thousandMatch = cellTitle.match(/\$?(\d+\.?\d*)\s*K/i);
            if (thousandMatch) {
              cellValue = parseFloat(thousandMatch[1]);
            } else {
              // Check for plain numbers (e.g., "$1000" or "1000")
              const numberMatch = cellTitle.match(/\$?(\d+\.?\d*)/);
              if (numberMatch) {
                cellValue = parseFloat(numberMatch[1]);
              } else {
                return false; // No valid number found
              }
            }
          }
        }
      }

      const isValid =
        supplyApyFilter.greaterThan
          ? cellValue > supplyApyFilter.percentage
          : cellValue < supplyApyFilter.percentage;

      if (!isValid) return false;
    }

    if (hasAllFilter) {
      const matchSource = (
        typeColumnIndex !== -1
          ? row.cell[typeColumnIndex]?.title
          : row.cell[0]?.title
      )?.toUpperCase() || "";
      const matches = filtersState.all.some((f) => {
        const filterUpper = f.toUpperCase();
        return (
          matchSource.includes(filterUpper) || filterUpper.includes(matchSource)
        );
      });
      if (!matches) return false;
    }

    // Vaults filter - checks if vault name matches
    if (hasVaultsFilter) {
      const vaultName = row.cell[0]?.title?.toUpperCase() || "";
      if (!filtersState.vaults.some((v) => vaultName.includes(v.toUpperCase())))
        return false;
    }

    // Protocol filter - checks first tag (index 0) for protocol match
    if (hasProtocolFilter) {
      let protocolFound = false;
      for (const cell of row.cell) {
        if (cell.tags && cell.tags.length > 0) {
          const protocolTag = String(cell.tags[0]).toLowerCase();
          if (filtersState.protocol.some((p) => protocolTag.includes(p.toLowerCase()))) {
            protocolFound = true;
            break;
          }
        }
      }
      if (!protocolFound) return false;
    }

    // Curator filter - checks third tag (index 2) for curator match
    if (hasCuratorFilter) {
      let curatorFound = false;
      for (const cell of row.cell) {
        if (cell.tags && cell.tags.length > 2) {
          const curatorTag = String(cell.tags[2]).toLowerCase();
          if (filtersState.curator.some((c) => curatorTag.includes(c.toLowerCase()))) {
            curatorFound = true;
            break;
          }
        }
      }
      if (!curatorFound) return false;
    }

    // Provider filter - checks fourth tag (index 3) or third tag (index 2) if only 3 tags exist
    if (hasProviderFilter) {
      let providerFound = false;
      for (const cell of row.cell) {
        if (cell.tags) {
          let providerTag: string | null = null;
          
          // If 4 or more tags, provider is at index 3
          if (cell.tags.length >= 4) {
            providerTag = String(cell.tags[3]).toLowerCase();
          }
          // If only 3 tags, provider is at index 2
          else if (cell.tags.length === 3) {
            providerTag = String(cell.tags[2]).toLowerCase();
          }
          
          if (providerTag && filtersState.provider.some((p) => providerTag.includes(p.toLowerCase()))) {
            providerFound = true;
            break;
          }
        }
      }
      if (!providerFound) return false;
    }

    return true;
  });
};

/* ---------- SIMPLE CELL RENDER HELPERS ---------- */

// Status words render as pills; numeric/value strings render as muted secondary text
const isStatusTag = (tag: string | number): boolean => {
  return /^(active|inactive|stable|paused|deprecated|live|closed|pending|liquidated)$/i.test(String(tag).trim());
};

const CellContent = ({
  cell,
  showPieChart,
  showProgressBar,
  isDark,
  hasHover,
}: {
  cell: any;
  showPieChart?: boolean;
  showProgressBar?: boolean;
  isDark?: boolean;
  hasHover?: boolean;
}) => {
  const hasPercentage = cell.percentage !== undefined;
  const hasLink = Boolean(cell.link);
  const showValueBlock =
    cell.title || cell.titles || (showPieChart && hasPercentage) || (showProgressBar && hasPercentage);

  if (!showValueBlock && !cell.onlyIcons && !cell.tag && !cell.tags) return null;

  if (cell.onlyIcons) {
    return (
      <div className="w-fit h-fit flex justify-start items-center">
        {cell.onlyIcons.map((icon: string, iconIdx: number) => (
          <Image
            key={iconIdx}
            className={`${iconIdx > 0 ? "-ml-[10px]" : ""} rounded-full ${
              isDark ? "border-[1px] border-black" : "border-[1px] border-white"
            }`}
            src={iconPaths[icon]}
            alt={icon}
            width={20}
            height={20}
          />
        ))}
      </div>
    );
  }

  // Separate status tags from value tags
  const allTags: (string | number)[] = cell.tags ? cell.tags : cell.tag ? [cell.tag] : [];
  const statusTags = allTags.filter((t) => isStatusTag(t));
  const valueTags = allTags.filter((t) => !isStatusTag(t));

  return (
    <>
      {showValueBlock && (
        <div
          className={`${
            showProgressBar && hasPercentage ? "w-full" : "w-fit"
          } h-fit flex flex-col gap-[2px]`}
        >
          {showProgressBar && hasPercentage && (
            <div className="w-full h-fit">
              <ProgressBar
                percentage={cell.percentage}
                height={34}
                progressColor="#703AE6"
                backgroundColor="#FFFFFF"
                showPercentage={true}
                value={cell.value}
              />
            </div>
          )}

          <div className="w-fit h-fit flex gap-[8px] items-center">
            {cell.chain && (
              <Image
                src={iconPaths[cell.chain]}
                alt={cell.chain}
                width={10}
                height={10}
              />
            )}

            {showPieChart && hasPercentage ? (
              <div className="w-[24px] h-[24px]">
                <PieChart
                  percentage={cell.percentage}
                  strokeWidth={10}
                  showPercentage={false}
                  textSize="text-[8px]"
                />
              </div>
            ) : cell.titles && cell.titles.length > 0 ? (
              // Multiple icons derived from titles - half-half display
              <div className="flex items-center -space-x-[8px]">
                {cell.titles.map((titleName: string, iconIdx: number) => {
                  const iconPath = iconPaths[titleName];
                  if (!iconPath) return null;
                  return (
                    <Image
                      key={iconIdx}
                      src={iconPath}
                      alt={titleName}
                      width={16}
                      height={16}
                      className={`rounded-full ${
                        isDark ? "border-[1px] border-black" : "border-[1px] border-white"
                      }`}
                    />
                  );
                })}
              </div>
            ) : iconPaths[cell.title] || cell.icon ? (
              <Image
                src={cell.icon || iconPaths[cell.title]}
                alt={cell.title}
                width={16}
                height={16}
                className="rounded-full"
              />
            ) : null}

            {(!showProgressBar || cell.title || cell.titles) && (
              <div className={`w-fit h-fit flex flex-row items-baseline gap-1.5 xl:flex-col xl:items-start xl:gap-1`}>
                {hasLink ? (
                  <a
                    href={cell.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className={`whitespace-nowrap text-[14px] font-medium flex items-center gap-1.5 hover:underline ${
                      isDark ? "text-white" : "text-[#111111]"
                    }`}
                  >
                    {cell.titles ? (
                      cell.titles.join(" / ")
                    ) : (
                      cell.title ?? (hasPercentage ? `${cell.percentage}%` : "")
                    )}
                    {/* Status tags inline on mobile */}
                    {statusTags.length > 0 && (
                      <span className="xl:hidden flex items-center gap-1">
                        {statusTags.map((tag, i) => (
                          <span key={i} className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold bg-[#703AE6] text-white">
                            {tag}
                          </span>
                        ))}
                      </span>
                    )}
                  </a>
                ) : (
                  <span className={`whitespace-nowrap text-[14px] font-medium flex items-center gap-1.5 ${
                    isDark ? "text-white" : "text-[#111111]"
                  }`}>
                    {cell.titles ? (
                      cell.titles.join(" / ")
                    ) : (
                      cell.title ?? (hasPercentage ? `${cell.percentage}%` : "")
                    )}
                    {/* Status tags inline on mobile */}
                    {statusTags.length > 0 && (
                      <span className="xl:hidden flex items-center gap-1">
                        {statusTags.map((tag, i) => (
                          <span key={i} className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold bg-[#703AE6] text-white">
                            {tag}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                )}
                {cell.description && (
                  <span className={`text-[12px] font-medium ${
                    isDark ? "text-[#777777]" : "text-[#A7A7A7]"
                  }`}>
                    {cell.description}
                  </span>
                )}
              </div>
            )}

            {cell.clickable && (
              hasLink ? (
                <a
                  href={cell.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="cursor-pointer w-[20px] h-[20px] flex flex-col justify-center items-center"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path
                      d="M9.29169 4.95838L0.625 4.95838M9.29169 4.95838L4.95829 0.625M9.29169 4.95838L4.95829 9.29162"
                      stroke="#434C53"
                      strokeOpacity="0.95"
                      strokeWidth="1.25"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </a>
              ) : (
                <button
                  type="button"
                  className="cursor-pointer w-[20px] h-[20px] flex flex-col justify-center items-center"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path
                      d="M9.29169 4.95838L0.625 4.95838M9.29169 4.95838L4.95829 0.625M9.29169 4.95838L4.95829 9.29162"
                      stroke="#434C53"
                      strokeOpacity="0.95"
                      strokeWidth="1.25"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )
            )}
          </div>
        </div>
      )}

      {/* Status tags: hidden on mobile (shown inline with title), visible on desktop */}
      {statusTags.length > 0 && !cell.onlyIcons && (
        <div className="hidden xl:flex flex-wrap gap-1 mt-0.5">
          {statusTags.map((tag, idx) => (
            <div key={idx} className="w-fit h-fit rounded-md px-1.5 py-0.5 text-[11px] font-semibold bg-[#703AE6] text-white">
              {tag}
            </div>
          ))}
        </div>
      )}
      {/* Value tags: always visible */}
      {valueTags.length > 0 && !cell.onlyIcons && (
        <div className="w-fit h-fit flex flex-wrap gap-1 mt-0.5">
          {valueTags.map((tag, idx) => (
            <div key={idx} className={`w-fit h-fit rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${isDark ? "bg-[#2A2A2A] text-[#A7A7A7]" : "bg-[#F0F0F0] text-[#555555]"}`}>
              {tag}
            </div>
          ))}
        </div>
      )}
    </>
  );
};

const TableRow = memo(
  ({
    row,
    visibleHeadings,
    tableBodyBackground,
    tableHeadings,
    onRowClick,
    hoverBackground,
    rowIndex,
    showPieChart,
    showProgressBar,
    isDark,
  }: {
    row: any;
    visibleHeadings: any[];
    tableBodyBackground?: string;
    tableHeadings: TableProps["tableHeadings"];
    onRowClick?: (row: any, rowIndex: number) => void;
    hoverBackground?: string;
    rowIndex: number;
    showPieChart?: boolean;
    showProgressBar?: boolean;
    isDark?: boolean;
  }) => {
    const hasHover = Boolean(hoverBackground);
    const [mobileExpanded, setMobileExpanded] = useState(false);
    const visibleCells = row.cell.filter((_: any, cellIdx: number) => {
      const heading = tableHeadings[cellIdx];
      return heading && visibleHeadings.some((vh) => vh.label === heading.label);
    });

    const handleClick = useCallback(() => {
      onRowClick?.(row, rowIndex);
    }, [onRowClick, row, rowIndex]);

    return (
      <tr
        className={`group w-full h-fit rounded-xl border transition-colors ${
          isDark
            ? "bg-[#1A1A1A] border-[#2A2A2A] hover:bg-[#222222]"
            : "bg-[#F7F7F7] border-[#EEEEEE] hover:bg-[#EFEFEF]"
        }`}
      >
        {/* Desktop: horizontal row */}
        <td
          onClick={onRowClick ? handleClick : undefined}
          className={`hidden xl:flex gap-4 items-center w-full px-4 py-3 ${onRowClick ? "cursor-pointer" : ""}`}
        >
          {visibleCells.map((cell: any, idx: number) => (
            <div
              key={idx}
              className="flex flex-col gap-1.5 h-full w-full min-w-0 items-start"
            >
              <CellContent
                cell={cell}
                showPieChart={showPieChart}
                showProgressBar={showProgressBar}
                isDark={isDark}
                hasHover={hasHover}
              />
            </div>
          ))}
        </td>

        {/* Mobile: accordion */}
        <td className="flex flex-col xl:hidden">
          {/* Header — always visible, tappable */}
          <div
            className="flex items-center justify-between px-4 py-3 cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              setMobileExpanded(!mobileExpanded);
            }}
          >
            <div className="flex-1 min-w-0">
              {visibleCells[0] && (
                <CellContent
                  cell={visibleCells[0]}
                  showPieChart={showPieChart}
                  showProgressBar={showProgressBar}
                  isDark={isDark}
                  hasHover={hasHover}
                />
              )}
            </div>
            <motion.svg
              width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke={isDark ? "#777777" : "#AAAAAA"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className="shrink-0 ml-2"
              animate={{ rotate: mobileExpanded ? 180 : 0 }}
              transition={{ duration: 0.2 }}
            >
              <path d="m6 9 6 6 6-6"/>
            </motion.svg>
          </div>

          {/* Expandable stats */}
          <AnimatePresence>
            {mobileExpanded && visibleCells.length > 1 && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                className="overflow-hidden"
              >
                <div className={`flex flex-col mx-4 mb-3 rounded-xl overflow-hidden ${isDark ? "bg-[#111111]" : "bg-white"}`}>
                  {visibleCells.slice(1).map((cell: any, idx: number) => (
                    <div key={idx} className="flex items-baseline justify-between gap-3 px-3 py-2">
                      <span className={`text-[12px] font-medium shrink-0 ${isDark ? "text-[#888888]" : "text-[#777777]"}`}>
                        {visibleHeadings[idx + 1]?.label}
                      </span>
                      <div className="flex items-baseline gap-1.5 flex-wrap justify-end">
                        {/* Main value */}
                        {cell.link ? (
                          <a
                            href={cell.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className={`text-[13px] font-medium hover:underline ${isDark ? "text-white" : "text-[#111111]"}`}
                          >
                            {cell.title || cell.value || (cell.percentage !== undefined ? `${cell.percentage}%` : "")}
                          </a>
                        ) : (
                          <span className={`text-[13px] font-medium ${isDark ? "text-white" : "text-[#111111]"}`}>
                            {cell.title || cell.value || (cell.percentage !== undefined ? `${cell.percentage}%` : "")}
                          </span>
                        )}
                        {/* Sub value inline */}
                        {cell.description && (
                          <span className={`text-[11px] font-medium ${isDark ? "text-[#666666]" : "text-[#AAAAAA]"}`}>
                            {cell.description}
                          </span>
                        )}
                        {/* Icons */}
                        {cell.onlyIcons && (
                          <span className="flex items-center -space-x-[6px]">
                            {cell.onlyIcons.map((icon: string, i: number) => (
                              <Image key={i} src={iconPaths[icon]} alt={icon} width={16} height={16} className={`rounded-full ${isDark ? "border border-black" : "border border-white"}`} />
                            ))}
                          </span>
                        )}
                        {/* Tags */}
                        {(cell.tag || cell.tags) && (
                          <span className="flex items-center gap-1">
                            {(cell.tags || [cell.tag]).map((tag: string | number, i: number) => (
                              <span key={i} className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${
                                isStatusTag(tag)
                                  ? "bg-[#703AE6] text-white"
                                  : isDark ? "bg-[#2A2A2A] text-[#A7A7A7]" : "bg-[#F0F0F0] text-[#555555]"
                              }`}>{tag}</span>
                            ))}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                {/* Row action on mobile */}
                {onRowClick && (
                  <div
                    onClick={handleClick}
                    className={`mx-4 mb-3 py-2 text-center text-[12px] font-semibold text-[#703AE6] cursor-pointer rounded-lg transition-colors ${isDark ? "bg-[#1A1A2A] hover:bg-[#222233]" : "bg-[#F1EBFD] hover:bg-[#E8DFFA]"}`}
                  >
                    View Details →
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </td>
      </tr>
    );
  }
);

TableRow.displayName = "TableRow";

/* ---------- MAIN TABLE COMPONENT ---------- */

export const Table = memo((props: TableProps) => {
  const { isDark } = useTheme();
  const activeTab = props.activeTab || props.heading.tabsItems?.[0]?.id || "";

  const [searchValue, setSearchValue] = useState("");
  const [debouncedSearchValue, setDebouncedSearchValue] = useState("");
  const [filtersState, setFiltersState] = useState<FiltersState>({
    allChains: [],
    collateral: [],
    deposit: [],
    all: [],
    customize: [],
    vaults: [],
    curator: [],
    provider: [],
    protocol: [],
  });
  const [supplyApyFilter, setSupplyApyFilter] = useState<SupplyApyFilter>({
    percentage: 0,
    greaterThan: false,
  });
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [sortConfig, setSortConfig] = useState<{
    columnId: string | null;
    direction: "asc" | "desc";
  }>({
    columnId: null,
    direction: "asc",
  });
  const [showLeftShadow, setShowLeftShadow] = useState(false);
  const [showRightShadow, setShowRightShadow] = useState(true);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const supplyApyColumnIndex = useMemo(() => {
    // If custom label is provided, find column by label match
    if (props.filters?.supplyApyLabel) {
      return props.tableHeadings.findIndex((h) => 
        h.label.toLowerCase().includes(props.filters!.supplyApyLabel!.toLowerCase())
      );
    }
    // Otherwise use default "supply-apy" id
    return props.tableHeadings.findIndex((h) => h.id === "supply-apy");
  }, [props.tableHeadings, props.filters?.supplyApyLabel]);
  
  const hasSupplyApyColumn = supplyApyColumnIndex !== -1;

  // Handle scroll to show/hide shadow indicators
  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return;
    const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef.current;
    setShowLeftShadow(scrollLeft > 0);
    setShowRightShadow(scrollLeft < scrollWidth - clientWidth - 1);
  }, []);

  const debouncedSearchHandler = useDebounce((value: string) => {
    setDebouncedSearchValue(value);
  }, 300);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setSearchValue(value);
      debouncedSearchHandler(value);
    },
    [debouncedSearchHandler]
  );

  const updateFilter = useCallback(
    (key: keyof FiltersState) => (value: string[]) => {
      setFiltersState((prev) => ({ ...prev, [key]: value }));
      setCurrentPage(1);
    },
    []
  );

  const filteredData = useMemo(
    () =>
      applyFilters(
        props.tableBody.rows,
        debouncedSearchValue.toLowerCase().trim(),
        filtersState,
        supplyApyFilter,
        hasSupplyApyColumn,
        supplyApyColumnIndex,
        props.tableHeadings
      ),
    [
      debouncedSearchValue,
      filtersState,
      supplyApyFilter,
      hasSupplyApyColumn,
      supplyApyColumnIndex,
      props.tableBody.rows,
      props.tableHeadings,
    ]
  );

  const sortedData = useMemo(() => {
    if (!sortConfig.columnId) return filteredData;

    const columnIndex = props.tableHeadings.findIndex(
      (h) => h.id === sortConfig.columnId
    );
    if (columnIndex === -1) return filteredData;

    return [...filteredData].sort((a, b) => {
      const aCell = a.cell[columnIndex];
      const bCell = b.cell[columnIndex];

      let aValue: string | number = aCell?.title || aCell?.tag || "";
      let bValue: string | number = bCell?.title || bCell?.tag || "";

      const aNumMatch = String(aValue).match(/(\d+\.?\d*)/);
      const bNumMatch = String(bValue).match(/(\d+\.?\d*)/);

      if (aNumMatch && bNumMatch) {
        aValue = parseFloat(aNumMatch[1]);
        bValue = parseFloat(bNumMatch[1]);
      }

      if (typeof aValue === "number" && typeof bValue === "number") {
        return sortConfig.direction === "asc"
          ? aValue - bValue
          : bValue - aValue;
      }

      const aStr = String(aValue).toLowerCase();
      const bStr = String(bValue).toLowerCase();

      if (sortConfig.direction === "asc") {
        return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
      } else {
        return aStr > bStr ? -1 : aStr < bStr ? 1 : 0;
      }
    });
  }, [filteredData, sortConfig, props.tableHeadings]);

  useEffect(() => {
    setCurrentPage(1);
  }, [
    filteredData.length,
    supplyApyFilter.percentage,
    supplyApyFilter.greaterThan,
  ]);

  const totalPages = Math.ceil(sortedData.length / ITEMS_PER_PAGE);

  const paginatedData = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return sortedData.slice(start, start + ITEMS_PER_PAGE);
  }, [sortedData, currentPage]);

  const handlePreviousPage = useCallback(() => {
    setCurrentPage((prev) => Math.max(1, prev - 1));
  }, []);

  const handleNextPage = useCallback(() => {
    setCurrentPage((prev) => Math.min(totalPages, prev + 1));
  }, [totalPages]);

  const handleTabChange = useCallback(
    (tabId: string) => {
      props.onTabChange?.(tabId);
    },
    [props]
  );

  const handleSort = useCallback((columnId: string) => {
    setSortConfig((prev) => {
      if (prev.columnId === columnId) {
        return {
          columnId,
          direction: prev.direction === "asc" ? "desc" : "asc",
        };
      }
      return { columnId, direction: "asc" };
    });
    setCurrentPage(1);
  }, []);

  const visibleHeadings = useMemo(
    () =>
      props.tableHeadings.filter(
        (h) => !filtersState.customize.includes(h.label)
      ),
    [props.tableHeadings, filtersState.customize]
  );

  const { filters } = props;
  const showAllChainDropdown = filters?.allChainDropdown;
  const showCustomizeDropdown = filters?.customizeDropdown;
  const showFilterTabType = filters?.filterTabType;
  const hasCollateral = filters?.filters?.includes("Collateral") ?? false;
  const hasDeposit = filters?.filters?.includes("Deposit") ?? false;
  const hasAll = filters?.filters?.includes("All") ?? false;
  const hasVaults = filters?.filters?.includes("Vaults") ?? false;
  const hasCurator = filters?.filters?.includes("Curator") ?? false;
  const hasProvider = filters?.filters?.includes("Provider") ?? false;
  const hasProtocol = filters?.filters?.includes("Protocol") ?? false;

  const customizeOptions = useMemo(
    () => props.tableHeadings.map((h) => h.label),
    [props.tableHeadings]
  );
  const customizeOptionsFilters = useMemo(() => ["All"], []);

  const hasHeadingTitle = Boolean(props.heading.heading);
  const hasTabs = Boolean(props.heading.tabsItems);

  const hasData = sortedData.length > 0;

  // Handle scroll to show/hide shadow indicators
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !hasData) return;

    const timeoutId = setTimeout(() => {
      handleScroll();
    }, 100);

    container.addEventListener("scroll", handleScroll);

    const resizeObserver = new ResizeObserver(() => {
      handleScroll();
    });
    resizeObserver.observe(container);

    return () => {
      clearTimeout(timeoutId);
      container.removeEventListener("scroll", handleScroll);
      resizeObserver.disconnect();
    };
  }, [handleScroll, hasData, sortedData.length]);

  return (
    <section className="w-full h-fit flex flex-col gap-4" aria-label={props.heading.heading || "Data Table"}>
      {hasHeadingTitle && !showAllChainDropdown && (
        <header className="flex flex-col xl:flex-row justify-between items-center gap-3">
          <h2 className={`text-[16px] font-semibold text-center xl:text-left ${
            isDark ? "text-white" : "text-[#111111]"
          }`}>
            {props.heading.heading}
          </h2>
          <div className="flex items-center gap-3 flex-wrap justify-center xl:justify-end" role="toolbar" aria-label="Table Filters">
            {hasCollateral && (
              <FilterDropdown
                dropdownOptions={FILTER_OPTIONS.collateral}
                dropdownOptionsFilters={FILTER_OPTIONS.collateralFilters}
                currentDropdownItem={filtersState.collateral}
                dropDownType="collateral"
                onDropdownItemChange={updateFilter("collateral")}
                dropdownPosition={props.filterDropdownPosition || "left"}
              />
            )}
            {hasDeposit && (
              <FilterDropdown
                dropdownOptions={FILTER_OPTIONS.deposit}
                dropdownOptionsFilters={FILTER_OPTIONS.depositFilters}
                currentDropdownItem={filtersState.deposit}
                dropDownType="deposit"
                onDropdownItemChange={updateFilter("deposit")}
                dropdownPosition={props.filterDropdownPosition || "left"}
              />
            )}
            {hasAll && (
              <FilterDropdown
                dropdownOptions={FILTER_OPTIONS.all}
                dropdownOptionsFilters={FILTER_OPTIONS.allFilters}
                currentDropdownItem={filtersState.all}
                dropDownType="All"
                onDropdownItemChange={updateFilter("all")}
                dropdownPosition="left"
              />
            )}
            {hasVaults && (
              <FilterDropdown
                dropdownOptions={FILTER_OPTIONS.vaults}
                dropdownOptionsFilters={FILTER_OPTIONS.vaultsFilters}
                currentDropdownItem={filtersState.vaults}
                dropDownType="vaults"
                onDropdownItemChange={updateFilter("vaults")}
                dropdownPosition={props.filterDropdownPosition || "left"}
              />
            )}
            {hasCurator && (
              <FilterDropdown
                dropdownOptions={FILTER_OPTIONS.curator}
                dropdownOptionsFilters={FILTER_OPTIONS.curatorFilters}
                currentDropdownItem={filtersState.curator}
                dropDownType="curator"
                onDropdownItemChange={updateFilter("curator")}
                dropdownPosition={props.filterDropdownPosition || "left"}
              />
            )}
            {hasProvider && (
              <FilterDropdown
                dropdownOptions={FILTER_OPTIONS.provider}
                dropdownOptionsFilters={FILTER_OPTIONS.providerFilters}
                currentDropdownItem={filtersState.provider}
                dropDownType="provider"
                onDropdownItemChange={updateFilter("provider")}
                dropdownPosition={props.filterDropdownPosition || "left"}
              />
            )}
            {hasProtocol && (
              <FilterDropdown
                dropdownOptions={FILTER_OPTIONS.protocol}
                currentDropdownItem={filtersState.protocol}
                dropDownType="protocol"
                onDropdownItemChange={updateFilter("protocol")}
                showDropdownFilters={false}
                showSearchBar={false}
                dropdownPosition={props.filterDropdownPosition || "left"}
              />
            )}
            {showCustomizeDropdown && customizeOptions.length > 0 && (
              <FilterDropdown
                dropdownOptions={customizeOptions}
                dropdownOptionsFilters={customizeOptionsFilters}
                currentDropdownItem={filtersState.customize}
                dropDownType="customize"
                onDropdownItemChange={updateFilter("customize")}
                dropdownPosition="right"
              />
            )}
          </div>
        </header>
      )}

      {/* Tabs row + filters row stacked */}
      {(hasTabs || showAllChainDropdown) && (
        <div className={`flex flex-col gap-3 relative z-10 xl:static xl:bg-transparent xl:py-0 sticky top-0 py-3 -mx-4 px-4 sm:-mx-10 sm:px-10 xl:mx-0 xl:px-0 ${isDark ? "bg-[#111111]" : "bg-white"}`}>
          {/* Row 1: main tabs left + filter-type tabs right */}
          {(hasTabs || (showFilterTabType && props.filterTabTypeOptions)) && (
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2">
              {hasTabs && (
                <nav className={`flex gap-1 p-1 rounded-xl border w-full sm:w-auto ${isDark ? "bg-[#111111] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]"}`} aria-label="Table Navigation Tabs">
                  {props.heading.tabsItems!.map((tab) => {
                    const isActive = activeTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => handleTabChange(tab.id)}
                        className={`flex-1 xl:flex-none text-center px-3 py-1.5 rounded-lg text-[14px] whitespace-nowrap transition-colors cursor-pointer ${
                          isActive
                            ? "bg-[#703AE6] text-white font-semibold"
                            : isDark
                            ? "text-[#555555] font-medium hover:text-[#A7A7A7]"
                            : "text-[#A7A7A7] font-medium hover:text-[#555555]"
                        }`}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
                </nav>
              )}
              {showFilterTabType && props.filterTabTypeOptions && (
                <nav className={`flex gap-1 p-1 rounded-xl border w-full sm:w-auto ${isDark ? "bg-[#111111] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]"}`} aria-label="Filter Type Tabs">
                  {props.filterTabTypeOptions.map((tab) => {
                    const isActive = (props.activeFilterTab || props.filterTabTypeOptions![0].id) === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => props.onFilterTabTypeChange?.(tab.id)}
                        className={`flex-1 xl:flex-none text-center px-3 py-1.5 rounded-lg text-[14px] whitespace-nowrap transition-colors cursor-pointer ${
                          isActive
                            ? "bg-[#703AE6] text-white font-semibold"
                            : isDark
                            ? "text-[#555555] font-medium hover:text-[#A7A7A7]"
                            : "text-[#A7A7A7] font-medium hover:text-[#555555]"
                        }`}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
                </nav>
              )}
            </div>
          )}
          {/* Row 2: search + filter toggle (mobile) / full filters (desktop) */}
          {showAllChainDropdown && (
            <>
            {/* Mobile: search + filter button */}
            <div className="flex xl:hidden items-center gap-2">
              <div className="flex-1">
                <SearchBar
                  placeholder="Search pools..."
                  value={searchValue}
                  onChange={handleSearchChange}
                  compact
                />
              </div>
              <button
                type="button"
                onClick={() => setShowMobileFilters(!showMobileFilters)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-[12px] font-medium transition-colors shrink-0 ${
                  showMobileFilters
                    ? "bg-[#703AE6] text-white border-transparent"
                    : isDark ? "bg-[#1A1A1A] border-[#333333] text-[#A7A7A7]" : "bg-[#F7F7F7] border-[#E2E2E2] text-[#555555]"
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/></svg>
                Filter
              </button>
            </div>
            {/* Mobile: expandable filter panel */}
            <AnimatePresence>
              {showMobileFilters && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="xl:hidden"
                >
                  <div className={`flex flex-col gap-2 p-3 rounded-xl border ${isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-[#F7F7F7] border-[#E8E8E8]"}`}>
                    <div className="w-full ">
                      <FilterDropdown
                        dropdownOptions={FILTER_OPTIONS.allChains}
                        dropdownOptionsFilters={FILTER_OPTIONS.allChainsFilters}
                        currentDropdownItem={filtersState.allChains}
                        dropDownType="all-chains"
                        onDropdownItemChange={updateFilter("allChains")}
                        compact
                      />
                    </div>
                    {hasCollateral && <div className="w-full"><FilterDropdown dropdownOptions={FILTER_OPTIONS.collateral} dropdownOptionsFilters={FILTER_OPTIONS.collateralFilters} currentDropdownItem={filtersState.collateral} dropDownType="collateral" onDropdownItemChange={updateFilter("collateral")} dropdownPosition="left" compact /></div>}
                    {hasDeposit && <div className="w-full"><FilterDropdown dropdownOptions={FILTER_OPTIONS.deposit} dropdownOptionsFilters={FILTER_OPTIONS.depositFilters} currentDropdownItem={filtersState.deposit} dropDownType="deposit" onDropdownItemChange={updateFilter("deposit")} dropdownPosition="left" compact /></div>}
                    {hasAll && <div className="w-full "><FilterDropdown dropdownOptions={FILTER_OPTIONS.all} dropdownOptionsFilters={FILTER_OPTIONS.allFilters} currentDropdownItem={filtersState.all} dropDownType="All" onDropdownItemChange={updateFilter("all")} dropdownPosition="right" compact /></div>}
                    {hasVaults && <div className="w-full "><FilterDropdown dropdownOptions={FILTER_OPTIONS.vaults} dropdownOptionsFilters={FILTER_OPTIONS.vaultsFilters} currentDropdownItem={filtersState.vaults} dropDownType="vaults" onDropdownItemChange={updateFilter("vaults")} dropdownPosition="left" compact /></div>}
                    {hasCurator && <div className="w-full "><FilterDropdown dropdownOptions={FILTER_OPTIONS.curator} dropdownOptionsFilters={FILTER_OPTIONS.curatorFilters} currentDropdownItem={filtersState.curator} dropDownType="curator" onDropdownItemChange={updateFilter("curator")} dropdownPosition="left" compact /></div>}
                    {hasProvider && <div className="w-full "><FilterDropdown dropdownOptions={FILTER_OPTIONS.provider} dropdownOptionsFilters={FILTER_OPTIONS.providerFilters} currentDropdownItem={filtersState.provider} dropDownType="provider" onDropdownItemChange={updateFilter("provider")} dropdownPosition="left" compact /></div>}
                    {hasProtocol && <div className="w-full "><FilterDropdown dropdownOptions={FILTER_OPTIONS.protocol} currentDropdownItem={filtersState.protocol} dropDownType="protocol" onDropdownItemChange={updateFilter("protocol")} showDropdownFilters={false} showSearchBar={false} dropdownPosition="left" compact /></div>}
                    {filters?.supplyApyTab && (
                      <div className="w-full">
                        <SupplyApy setSupplyApyFilter={setSupplyApyFilter} supplyApy={supplyApyFilter} supplyApyLabel={filters?.supplyApyLabel} anythingLabel={filters?.anythingLabel} />
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            {/* Desktop: original inline filters */}
            <div className="hidden xl:flex items-center gap-x-2.5 flex-wrap gap-y-2">
              <div className="shrink-0">
                <FilterDropdown
                  dropdownOptions={FILTER_OPTIONS.allChains}
                  dropdownOptionsFilters={FILTER_OPTIONS.allChainsFilters}
                  currentDropdownItem={filtersState.allChains}
                  dropDownType="all-chains"
                  onDropdownItemChange={updateFilter("allChains")}
                  compact
                />
              </div>
              <div className="shrink-0">
                <SearchBar
                  placeholder="Pools"
                  value={searchValue}
                  onChange={handleSearchChange}
                  compact
                />
              </div>
              {/* Spacer pushes filters to right */}
              <div className="flex-1" />
              {hasCollateral && (
                <div className="shrink-0">
                  <FilterDropdown
                    dropdownOptions={FILTER_OPTIONS.collateral}
                    dropdownOptionsFilters={FILTER_OPTIONS.collateralFilters}
                    currentDropdownItem={filtersState.collateral}
                    dropDownType="collateral"
                    onDropdownItemChange={updateFilter("collateral")}
                    dropdownPosition={props.filterDropdownPosition || "left"}
                    compact
                  />
                </div>
              )}
              {hasDeposit && (
                <div className="shrink-0">
                  <FilterDropdown
                    dropdownOptions={FILTER_OPTIONS.deposit}
                    dropdownOptionsFilters={FILTER_OPTIONS.depositFilters}
                    currentDropdownItem={filtersState.deposit}
                    dropDownType="deposit"
                    onDropdownItemChange={updateFilter("deposit")}
                    dropdownPosition={props.filterDropdownPosition || "left"}
                    compact
                  />
                </div>
              )}
              {hasAll && (
                <div className="shrink-0">
                  <FilterDropdown
                    dropdownOptions={FILTER_OPTIONS.all}
                    dropdownOptionsFilters={FILTER_OPTIONS.allFilters}
                    currentDropdownItem={filtersState.all}
                    dropDownType="All"
                    onDropdownItemChange={updateFilter("all")}
                    dropdownPosition={props.filterDropdownPosition || "left"}
                    compact
                  />
                </div>
              )}
              {hasVaults && (
                <div className="shrink-0">
                  <FilterDropdown
                    dropdownOptions={FILTER_OPTIONS.vaults}
                    dropdownOptionsFilters={FILTER_OPTIONS.vaultsFilters}
                    currentDropdownItem={filtersState.vaults}
                    dropDownType="vaults"
                    onDropdownItemChange={updateFilter("vaults")}
                    dropdownPosition={props.filterDropdownPosition || "left"}
                    compact
                  />
                </div>
              )}
              {hasCurator && (
                <div className="shrink-0">
                  <FilterDropdown
                    dropdownOptions={FILTER_OPTIONS.curator}
                    dropdownOptionsFilters={FILTER_OPTIONS.curatorFilters}
                    currentDropdownItem={filtersState.curator}
                    dropDownType="curator"
                    onDropdownItemChange={updateFilter("curator")}
                    dropdownPosition={props.filterDropdownPosition || "left"}
                    compact
                  />
                </div>
              )}
              {hasProvider && (
                <div className="shrink-0">
                  <FilterDropdown
                    dropdownOptions={FILTER_OPTIONS.provider}
                    dropdownOptionsFilters={FILTER_OPTIONS.providerFilters}
                    currentDropdownItem={filtersState.provider}
                    dropDownType="provider"
                    onDropdownItemChange={updateFilter("provider")}
                    dropdownPosition={props.filterDropdownPosition || "left"}
                    compact
                  />
                </div>
              )}
              {hasProtocol && (
                <div className="shrink-0">
                  <FilterDropdown
                    dropdownOptions={FILTER_OPTIONS.protocol}
                    currentDropdownItem={filtersState.protocol}
                    dropDownType="protocol"
                    onDropdownItemChange={updateFilter("protocol")}
                    showDropdownFilters={false}
                    showSearchBar={false}
                    dropdownPosition={props.filterDropdownPosition || "left"}
                    compact
                  />
                </div>
              )}
              {showCustomizeDropdown && customizeOptions.length > 0 && (
                <div className="shrink-0">
                  <FilterDropdown
                    dropdownOptions={customizeOptions}
                    dropdownOptionsFilters={customizeOptionsFilters}
                    currentDropdownItem={filtersState.customize}
                    dropDownType="customize"
                    onDropdownItemChange={updateFilter("customize")}
                    dropdownPosition="right"
                    compact
                  />
                </div>
              )}
              {filters?.supplyApyTab && (
                <div className="shrink-0">
                  <SupplyApy
                    setSupplyApyFilter={setSupplyApyFilter}
                    supplyApy={supplyApyFilter}
                    supplyApyLabel={filters?.supplyApyLabel}
                    anythingLabel={filters?.anythingLabel}
                  />
                </div>
              )}
            </div>
            </>
          )}
        </div>
      )}

      {hasData ? (
        <div className="w-full">
          <table className="w-full h-fit flex flex-col gap-1">
            <thead className="hidden xl:block">
              <tr className={`w-full h-fit px-4 py-3 flex gap-4`}>
                {visibleHeadings.map((item, idx) => {
                  const isLast = visibleHeadings.length - 1 === idx;
                  const isSorted = sortConfig.columnId === item.id;
                  const isDesc = isSorted && sortConfig.direction === "desc";

                  return (
                    <th
                      key={item.id}
                      className={`whitespace-nowrap text-[13px] font-medium ${
                        isDark ? "text-[#777777]" : "text-[#A7A7A7]"
                      } min-w-0 h-fit flex ${
                        isLast ? "justify-start w-full" : "justify-start w-full whitespace-nowrap"
                      } gap-1 items-center`}
                    >
                      {item.icon && (
                        <button
                          type="button"
                          onClick={() => handleSort(item.id)}
                          className={`w-5 h-5 flex flex-col justify-center items-center cursor-pointer transition-all ${
                            isSorted ? "opacity-100" : "opacity-50 hover:opacity-70"
                          } ${isDesc ? "rotate-180" : ""}`}
                          aria-label={`Sort by ${item.label}`}
                        >
                          <svg
                            width="12"
                            height="13"
                            viewBox="0 0 12 13"
                            fill="none"
                            xmlns="http://www.w3.org/2000/svg"
                          >
                            <path
                              d="M6.86559 2.73278C6.98278 2.84983 7.14163 2.91557 7.30726 2.91557C7.47288 2.91557 7.63174 2.84983 7.74892 2.73278L8.34892 2.13278V10.6245C8.34892 10.7902 8.41477 10.9492 8.53198 11.0664C8.64919 11.1836 8.80816 11.2495 8.97392 11.2495C9.13968 11.2495 9.29866 11.1836 9.41587 11.0664C9.53308 10.9492 9.59892 10.7902 9.59892 10.6245V2.13278L10.1989 2.73278C10.2561 2.79419 10.3251 2.84344 10.4018 2.8776C10.4785 2.91176 10.5612 2.93013 10.6452 2.93161C10.7291 2.93309 10.8124 2.91765 10.8903 2.88622C10.9681 2.85478 11.0388 2.808 11.0981 2.74865C11.1575 2.6893 11.2043 2.61861 11.2357 2.54078C11.2671 2.46296 11.2826 2.3796 11.2811 2.29568C11.2796 2.21176 11.2612 2.129 11.2271 2.05234C11.1929 1.97567 11.1437 1.90667 11.0823 1.84945L9.41559 0.182783C9.2984 0.0657412 9.13955 0 8.97392 0C8.8083 0 8.64944 0.0657412 8.53226 0.182783L6.86559 1.84945C6.74855 1.96664 6.68281 2.12549 6.68281 2.29112C6.68281 2.45674 6.74855 2.6156 6.86559 2.73278ZM2.93226 10.7828L3.53226 10.1828C3.58948 10.1214 3.65848 10.0721 3.73514 10.038C3.81181 10.0038 3.89457 9.98544 3.97849 9.98396C4.06241 9.98248 4.14576 9.99791 4.22359 10.0293C4.30141 10.0608 4.37211 10.1076 4.43146 10.1669C4.4908 10.2263 4.53759 10.297 4.56903 10.3748C4.60046 10.4526 4.6159 10.536 4.61442 10.6199C4.61294 10.7038 4.59457 10.7866 4.56041 10.8632C4.52625 10.9399 4.477 11.0089 4.41559 11.0661L2.74892 12.7328C2.63174 12.8498 2.47288 12.9156 2.30726 12.9156C2.14163 12.9156 1.98278 12.8498 1.86559 12.7328L0.198923 11.0661C0.137518 11.0089 0.0882658 10.9399 0.0541058 10.8632C0.0199459 10.7866 0.00157792 10.7038 9.72687e-05 10.6199C-0.00138338 10.536 0.0140536 10.4526 0.0454878 10.3748C0.076922 10.297 0.123709 10.2263 0.183058 10.1669C0.242407 10.1076 0.313102 10.0608 0.390925 10.0293C0.468749 9.99791 0.552106 9.98248 0.636026 9.98396C0.719945 9.98544 0.802706 10.0038 0.879372 10.038C0.956038 10.0721 1.02504 10.1214 1.08226 10.1828L1.68226 10.7828V2.29112C1.68226 2.12536 1.7481 1.96639 1.86531 1.84917C1.98253 1.73196 2.1415 1.66612 2.30726 1.66612C2.47302 1.66612 2.63199 1.73196 2.7492 1.84917C2.86641 1.96639 2.93226 2.12536 2.93226 2.29112V10.7828Z"
                              fill={isDark ? "#777777" : "#A7A7A7"}
                            />
                          </svg>
                        </button>
                      )}
                      {item.label}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="flex flex-col w-full gap-1.5">
              {paginatedData.map((row, idx) => (
                <TableRow
                  key={idx}
                  row={row}
                  visibleHeadings={visibleHeadings}
                  tableBodyBackground={props.tableBodyBackground}
                  tableHeadings={props.tableHeadings}
                  onRowClick={props.onRowClick}
                  hoverBackground={props.hoverBackground}
                  rowIndex={idx}
                  showPieChart={props.showPieChart}
                  showProgressBar={props.showProgressBar}
                  isDark={isDark}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <section className={`w-full h-[402px] rounded-2xl border flex flex-col items-center justify-center ${
          isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-[#F7F7F7] border-[#EEEEEE]"
        }`}>
          <p className={`text-[14px] font-medium ${
            isDark ? "text-[#777777]" : "text-[#A7A7A7]"
          }`}>
            No data available
          </p>
        </section>
      )}

      {hasData && totalPages > 1 && (
        <nav className="flex items-center justify-center gap-4 py-4" aria-label="Table Pagination">
          <button
            type="button"
            onClick={handlePreviousPage}
            disabled={currentPage === 1}
            className={`flex items-center justify-center w-9 h-9 rounded-lg border transition-colors ${
              currentPage === 1
                ? "cursor-not-allowed opacity-30"
                : "cursor-pointer"
            } ${isDark
              ? "bg-[#2A2A2A] border-[#333333] hover:bg-[#333333] text-white"
              : "bg-[#F0F0F0] border-[#E2E2E2] hover:bg-[#E2E2E2] text-[#111111]"
            }`}
            aria-label="Previous page"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path
                d="M7.5 9L4.5 6L7.5 3"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          <span className={`px-3 py-1.5 rounded-lg text-[13px] font-medium ${
            isDark ? "bg-[#2A2A2A] text-[#A7A7A7]" : "bg-[#F0F0F0] text-[#888888]"
          }`} aria-live="polite" aria-atomic="true">
            {currentPage} of {totalPages}
          </span>

          <button
            type="button"
            onClick={handleNextPage}
            disabled={currentPage === totalPages}
            className={`flex items-center justify-center w-9 h-9 rounded-lg border transition-colors ${
              currentPage === totalPages
                ? "cursor-not-allowed opacity-30"
                : "cursor-pointer"
            } ${isDark
              ? "bg-[#2A2A2A] border-[#333333] hover:bg-[#333333] text-white"
              : "bg-[#F0F0F0] border-[#E2E2E2] hover:bg-[#E2E2E2] text-[#111111]"
            }`}
            aria-label="Next page"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path
                d="M4.5 9L7.5 6L4.5 3"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </nav>
      )}
    </section>
  );
});

Table.displayName = "Table";
