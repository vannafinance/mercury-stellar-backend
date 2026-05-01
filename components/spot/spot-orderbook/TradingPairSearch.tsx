import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "@/contexts/theme-context";
import { Dropdown } from "../../ui/dropdown";

type MarketType = "all" | "perps" | "spot";
type CategoryTab = "all" | "favorites" | "crypto" | "rwa";
type SubTab =
  | "all"
  | "new"
  | "majors"
  | "prelaunch"
  | "defi"
  | "chain"
  | "memes"
  | "ai"
  | "stocks"
  | "fx"
  | "commodities"
  | "indices";

type Pair = {
  id: string;
  pair: string;
  base: string;
  icon: string;
  marketType: "spot" | "perps";
  category: "crypto" | "rwa";
  subCategory: SubTab;
  leverage?: number;

  lastPrice: number;
  change24h: number;
  volume24h: number;
  openInterest?: number;
  funding?: number;

  // RWA only
  status?: "open" | "closed";
  timeline?: string;
};

interface TradingPairSearchProps {
  onSelectPair?: (pair: Pair) => void;
  onClose?: () => void;
}

const MOCK_DATA: Pair[] = [
  {
    id: "btc-perp",
    pair: "BTC/USDC",
    base: "BTC",
    icon: "/coins/btc.svg",
    marketType: "perps",
    category: "crypto",
    subCategory: "majors",
    leverage: 50,
    lastPrice: 92574.2,
    change24h: -1.01,
    volume24h: 2.61e9,
    openInterest: 439.9e6,
    funding: 0.01,
  },
  {
    id: "eth-spot",
    pair: "ETH/USDC",
    base: "ETH",
    icon: "/coins/eth.svg",
    marketType: "spot",
    category: "crypto",
    subCategory: "majors",
    lastPrice: 3003.6,
    change24h: 0.48,
    volume24h: 6.59e6,
  },
  {
    id: "btc-spot",
    pair: "BTC/USDC",
    base: "BTC",
    icon: "/coins/btc.svg",
    marketType: "spot",
    category: "crypto",
    subCategory: "majors",
    lastPrice: 3003.6,
    change24h: 0.48,
    volume24h: 6.59e6,
  },
  {
    id: "ada-spot",
    pair: "ADA/USDC",
    base: "ADA",
    icon: "/coins/ada.svg",
    marketType: "spot",
    category: "crypto",
    subCategory: "new",
    lastPrice: 121.25,
    change24h: -1.75,
    volume24h: 10.9e6,
  },
  {
    id: "hood-rwa",
    pair: "HOOD/USDC",
    base: "HOOD",
    icon: "/coins/hood.svg",
    marketType: "perps",
    category: "rwa",
    subCategory: "stocks",
    leverage: 10,
    lastPrice: 185.15,
    change24h: 3.65,
    volume24h: 3.76e6,
    openInterest: 676.83e3,
    funding: 0.01,
    status: "open",
    timeline: "Market open until Saturday 03:30 UTC+5:30",
  },
];

const RWASTATUS_OPTIONS = ["All", "Open", "Closed"];

const format = (n?: number) => {
  if (n == null) return "-";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return n.toString();
};

const getSubTabs = (market: MarketType, category: CategoryTab): SubTab[] => {
  if (category === "favorites") return ["all"];

  if (market === "spot") return ["all", "new"];

  if (category === "crypto")
    return [
      "all",
      "new",
      "majors",
      "prelaunch",
      "defi",
      "chain",
      "memes",
      "ai",
    ];

  if (category === "rwa")
    return ["all", "stocks", "fx", "commodities", "indices"];

  return [
    "all",
    "new",
    "majors",
    "prelaunch",
    "defi",
    "chain",
    "memes",
    "ai",
    "stocks",
    "fx",
    "commodities",
    "indices",
  ];
};

function useSearchState() {
  const [marketType, setMarketType] = useState<MarketType>("all");
  const [search, setSearch] = useState("");
  const [categoryTab, setCategoryTab] = useState<CategoryTab>("all");
  const [subTab, setSubTab] = useState<SubTab>("all");
  const [rwaStatus, setRwaStatus] = useState("All");
  const [sortKey, setSortKey] = useState<keyof Pair | null>(null);
  const [sortOrder, setSortOrder] = useState<"asc" | "desc" | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);

  const showPerpCols = marketType !== "spot";

  const categoryTabs: CategoryTab[] =
    marketType === "spot"
      ? ["all", "favorites", "crypto"]
      : ["all", "favorites", "crypto", "rwa"];
  const subTabs = getSubTabs(marketType, categoryTab);

  const toggleFavorite = (id: string) => {
    setFavorites((prev) =>
      prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id],
    );
  };

  const onSort = (key: keyof Pair) => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortOrder("asc");
    } else if (sortOrder === "asc") {
      setSortOrder("desc");
    } else {
      setSortKey(null);
      setSortOrder(null);
    }
  };

  const rows = useMemo(() => {
    let data = [...MOCK_DATA];

    if (marketType !== "all") {
      data = data.filter((d) => d.marketType === marketType);
    }

    if (categoryTab === "favorites") {
      data = data.filter((d) => favorites.includes(d.id));
    } else if (categoryTab !== "all") {
      data = data.filter((d) => d.category === categoryTab);
    }

    if (subTab !== "all") {
      data = data.filter((d) => d.subCategory === subTab);
    }

    if (categoryTab === "rwa" && rwaStatus !== "All") {
      data = data.filter((d) => d.status === rwaStatus);
    }

    if (search) {
      const q = search.toLowerCase();
      data = data.filter(
        (d) =>
          d.pair.toLowerCase().includes(q) || d.base.toLowerCase().includes(q),
      );
    }

    if (sortKey && sortOrder) {
      data.sort((a: any, b: any) =>
        sortOrder === "asc" ? a[sortKey] - b[sortKey] : b[sortKey] - a[sortKey],
      );
    }

    return data;
  }, [
    marketType,
    categoryTab,
    subTab,
    rwaStatus,
    search,
    sortKey,
    sortOrder,
    favorites,
  ]);

  return {
    marketType,
    setMarketType,
    search,
    setSearch,
    categoryTab,
    setCategoryTab,
    subTab,
    setSubTab,
    rwaStatus,
    setRwaStatus,
    showPerpCols,
    categoryTabs,
    subTabs,
    toggleFavorite,
    onSort,
    rows,
    favorites,
  };
}

export default function TradingPairSearch({
  onSelectPair,
  onClose,
}: TradingPairSearchProps) {
  const { isDark } = useTheme();
  const [isVisible, setIsVisible] = useState(false);
  const state = useSearchState();

  useEffect(() => {
    requestAnimationFrame(() => setIsVisible(true));
  }, []);

  const handleClose = () => {
    setIsVisible(false);
    setTimeout(() => onClose?.(), 300);
  };

  // Drag-to-close logic
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragStartY = useRef(0);
  const currentTranslateY = useRef(0);
  const isDragging = useRef(false);

  const startDrag = (clientY: number) => {
    dragStartY.current = clientY;
    isDragging.current = true;
    if (sheetRef.current) sheetRef.current.style.transition = "none";
  };

  const moveDrag = (clientY: number) => {
    if (!isDragging.current) return;
    const deltaY = clientY - dragStartY.current;
    if (deltaY > 0) {
      currentTranslateY.current = deltaY;
      if (sheetRef.current) sheetRef.current.style.transform = `translateY(${deltaY}px)`;
    }
  };

  const endDrag = () => {
    if (!isDragging.current) return;
    isDragging.current = false;
    if (sheetRef.current) {
      sheetRef.current.style.transition = "transform 0.3s ease-out";
      if (currentTranslateY.current > 150) {
        sheetRef.current.style.transform = "translateY(100%)";
        setTimeout(() => onClose?.(), 300);
      } else {
        sheetRef.current.style.transform = "translateY(0)";
      }
    }
    currentTranslateY.current = 0;
  };

  const handleTouchStart = (e: React.TouchEvent) => startDrag(e.touches[0].clientY);
  const handleTouchMove = (e: React.TouchEvent) => moveDrag(e.touches[0].clientY);
  const handleTouchEnd = () => endDrag();
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    startDrag(e.clientY);
    const onMouseMove = (ev: MouseEvent) => moveDrag(ev.clientY);
    const onMouseUp = () => {
      endDrag();
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  const {
    marketType,
    setMarketType,
    search,
    setSearch,
    categoryTab,
    setCategoryTab,
    subTab,
    setSubTab,
    rwaStatus,
    setRwaStatus,
    showPerpCols,
    categoryTabs,
    subTabs,
    toggleFavorite,
    onSort,
    rows,
    favorites,
  } = state;

  // Shared: market type button
  const marketBtn = (market: MarketType, className?: string) => (
    <button
      key={market}
      onClick={() => setMarketType(market)}
      className={`cursor-pointer p-2.5 rounded-lg text-[12px] leading-[18px] font-semibold ${
        marketType === market
          ? "bg-[#F1EBFD] text-[#703AE6]"
          : isDark
            ? "bg-transparent text-[#FFFFFF]"
            : "bg-transparent text-[#111111]"
      } ${className ?? ""}`}
    >
      {market === "all" ? "All" : market === "perps" ? "Perps" : "Spot"}
    </button>
  );

  // Shared: search input
  const searchInput = (
    <div
      className={`flex gap-[9px] py-2 px-5 rounded-lg ${isDark ? "bg-[#111111]" : "bg-[#FFFFFF]"}`}
    >
      <Image
        src="/icons/search.svg"
        alt="search"
        height={15}
        width={15}
        className="w-5 h-5 flex items-center justify-center"
      />
      <input
        placeholder="Search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className={`flex-1 placeholder:text-[#A7A7A7] outline-none text-[14px] leading-[21px] font-medium min-w-0 ${isDark ? "text-[#FFFFFF] bg-transparent" : ""}`}
      />
    </div>
  );

  // Shared: category tabs
  const categoryTabsEl = (
    <div className="flex overflow-x-auto">
      {categoryTabs.map((category) => (
        <button
          key={category}
          onClick={() => {
            setCategoryTab(category);
            setSubTab("all");
          }}
          className={`cursor-pointer whitespace-nowrap py-2 px-3 text-[12px] leading-[18px] font-semibold ${
            categoryTab === category
              ? "text-[#703AE6] border-b-2 border-[#703AE6]"
              : isDark
                ? "text-[#FFFFFF]"
                : "text-[#111111]"
          }`}
        >
          {category[0].toUpperCase() + category.slice(1)}
        </button>
      ))}
    </div>
  );

  // Shared: sub tabs
  const subTabsEl = (
    <div className="flex items-center justify-between gap-2">
      <div className="flex overflow-x-auto">
        {subTabs.map((s) => (
          <button
            key={s}
            onClick={() => setSubTab(s)}
            className={`cursor-pointer whitespace-nowrap py-2 px-3 text-[12px] leading-[18px] font-semibold ${
              subTab === s
                ? "text-[#703AE6] border-b-2 border-[#703AE6]"
                : isDark
                  ? "text-[#FFFFFF]"
                  : "text-[#111111]"
            }`}
          >
            {s === "prelaunch" ? "Pre-launch" : s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      <div className="shrink-0">
        {categoryTab === "rwa" && marketType !== "spot" && (
          <Dropdown
            items={RWASTATUS_OPTIONS}
            selectedOption={rwaStatus}
            setSelectedOption={(val) => setRwaStatus(val)}
            classname={`gap-2 font-medium text-[12px] leading-[18px] ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}
            dropdownClassname="text-[12px] leading-[18px] font-medium "
            menuClassname="top-8 right-0"
          />
        )}
      </div>
    </div>
  );

  // Shared: table row
  const tableRow = (row: Pair, isMobile: boolean) => (
    <div
      key={row.id}
      onClick={() => onSelectPair?.(row)}
      className={`cursor-pointer grid text-[12px] leading-[18px] font-medium items-center py-1.5 rounded-lg transition-colors duration-150 ${
        isDark
          ? "text-[#FFFFFF] hover:bg-[#333333]"
          : "text-[#111111] hover:bg-[#F1EBFD]"
      } ${
        isMobile
          ? showPerpCols
            ? "grid-cols-[2fr_1fr_1fr_1fr]"
            : "grid-cols-[2fr_1fr_1fr]"
          : showPerpCols
            ? "grid-cols-[2.5fr_1fr_1fr_1.2fr_1.2fr_1fr]"
            : "grid-cols-[2.5fr_1fr_1fr_1.2fr]"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <button
          className="cursor-pointer shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite(row.id);
          }}
        >
          <Image
            src={
              favorites.includes(row.id)
                ? "/icons/ic_round-star.svg"
                : "/icons/line-md_star.svg"
            }
            alt="fav"
            width={20}
            height={20}
          />
        </button>
        <span className="shrink-0">
          <Image src={row.icon} alt={row.base} width={20} height={20} />
        </span>
        <span className="truncate font-semibold">{row.base}</span>
        {row.marketType === "spot" ? (
          <span className="shrink-0 px-1.5 py-0.5 text-[10px] leading-[15px] rounded bg-[#703AE6] text-[#FFFFFF] font-medium">
            Spot
          </span>
        ) : (
          <span className="shrink-0 px-1.5 py-0.5 text-[10px] leading-[15px] rounded bg-[#703AE6] text-[#FFFFFF] font-medium">
            {row.leverage}x
          </span>
        )}
        {row.category === "rwa" && row.status && (
          <span
            className={`ml-1 w-2 h-2 rounded-full shrink-0 ${
              row.status === "open" ? "bg-green-500" : "bg-red-500"
            }`}
          />
        )}
      </div>

      {isMobile ? (
        <>
          <div className="text-right">
            <div>{row.lastPrice.toLocaleString()}</div>
            <div
              className={`text-[11px] ${
                row.change24h >= 0 ? "text-green-600" : "text-red-600"
              }`}
            >
              {row.change24h > 0 && "+"}
              {row.change24h}%
            </div>
          </div>
          <div className="text-right">{format(row.volume24h)}</div>
          {showPerpCols && (
            <div className="text-right">{format(row.openInterest)}</div>
          )}
        </>
      ) : (
        <>
          <div>{row.lastPrice.toLocaleString()}</div>
          <div
            className={row.change24h >= 0 ? "text-green-600" : "text-red-600"}
          >
            {row.change24h > 0 && "+"}
            {row.change24h}%
          </div>
          <div>{format(row.volume24h)}</div>
          {showPerpCols && (
            <>
              <div>{format(row.openInterest)}</div>
              <div>
                {row.funding != null ? `${row.funding.toFixed(2)}%` : "-"}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );

  return (
    <>
      {/* ── Mobile: full-screen bottom sheet (< xl) ── */}
      <div className="min-[920px]:hidden">
        {/* Backdrop */}
        <div
          className={`fixed inset-0 bg-black/50 z-[200] transition-opacity duration-300 ${
            isVisible ? "opacity-100" : "opacity-0"
          }`}
          onClick={handleClose}
        />

        {/* Bottom sheet — extends from navbar to bottom */}
        <div
          ref={sheetRef}
          className={`fixed inset-x-0 top-[72px] bottom-0 z-[201] flex flex-col rounded-t-2xl transition-transform duration-300 ease-out ${
            isVisible ? "translate-y-0" : "translate-y-full"
          } ${isDark ? "bg-[#222222]" : "bg-[#F4F4F4]"}`}
        >
          {/* Handle bar — drag to close */}
          <div
            className="flex justify-center pt-3 pb-1 cursor-grab"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onMouseDown={handleMouseDown}
          >
            <div
              className={`w-10 h-1 rounded-full ${isDark ? "bg-[#555555]" : "bg-[#CCCCCC]"}`}
            />
          </div>

          {/* Title row */}
          <div className="flex items-center justify-between px-4 pb-2">
            <h2
              className={`text-[16px] font-semibold ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}
            >
              Markets
            </h2>
            <button
              onClick={handleClose}
              className={`cursor-pointer p-1 rounded-lg ${isDark ? "text-[#A7A7A7] hover:text-[#FFFFFF]" : "text-[#57585C] hover:text-[#111111]"}`}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M15 5L5 15M5 5L15 15"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>

          {/* Market type tabs — horizontal */}
          <div className="flex gap-1 px-4">
            {(["all", "perps", "spot"] as MarketType[]).map((m) =>
              marketBtn(m),
            )}
          </div>

          {/* Search + Type/Category dropdowns */}
          <div className="px-4 pt-2 flex items-center gap-2">
            <div className="flex-1 min-w-0">{searchInput}</div>
            <div className="flex items-center shrink-0 gap-2">
              {categoryTab === "rwa" && marketType !== "spot" && (
                <Dropdown
                  items={RWASTATUS_OPTIONS}
                  selectedOption={rwaStatus === "All" ? "Status" : rwaStatus}
                  setSelectedOption={(val) => setRwaStatus(val)}
                  classname={`gap-1.5 font-medium text-[12px] leading-[18px] ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}
                  dropdownClassname="text-[12px] leading-[18px] font-medium"
                />
              )}
              <Dropdown
                items={categoryTabs.map((c) => c[0].toUpperCase() + c.slice(1))}
                selectedOption={
                  categoryTab === "all"
                    ? "Type"
                    : categoryTab[0].toUpperCase() + categoryTab.slice(1)
                }
                setSelectedOption={(val) => {
                  setCategoryTab(val.toLowerCase() as CategoryTab);
                  setSubTab("all");
                }}
                classname={`gap-1.5 font-medium text-[12px] leading-[18px] ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}
                dropdownClassname="text-[12px] leading-[18px] font-medium"
              />
              <Dropdown
                items={subTabs.map((s) =>
                  s === "prelaunch"
                    ? "Pre-Launch"
                    : s[0].toUpperCase() + s.slice(1),
                )}
                selectedOption={
                  subTab === "all"
                    ? "Category"
                    : subTab === "prelaunch"
                      ? "Pre-Launch"
                      : subTab[0].toUpperCase() + subTab.slice(1)
                }
                setSelectedOption={(val) => {
                  const mapped =
                    val === "Pre-Launch" ? "prelaunch" : val.toLowerCase();
                  setSubTab(mapped as SubTab);
                }}
                classname={`gap-1.5 font-medium text-[12px] leading-[18px] ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}
                dropdownClassname="text-[12px] leading-[18px] font-medium "
                menuClassname="top-8 right-0"
              />
            </div>
          </div>

          {/* Table header */}
          <div className={`grid text-[10px] text-[#A7A7A7] leading-[15px] font-semibold px-4 pt-2 ${
            showPerpCols
              ? "grid-cols-[2fr_1fr_1fr_1fr]"
              : "grid-cols-[2fr_1fr_1fr]"
          }`}>
            <div onClick={() => onSort("pair")}>Market</div>
            <div className="text-right" onClick={() => onSort("lastPrice")}>
              Last Price / 24h
            </div>
            <div className="text-right" onClick={() => onSort("volume24h")}>
              Volume
            </div>
            {showPerpCols && (
              <div className="text-right" onClick={() => onSort("openInterest")}>
                OI
              </div>
            )}
          </div>

          {/* Scrollable rows */}
          <div className="flex-1 overflow-y-auto px-4 pb-4">
            {rows.map((row) => tableRow(row, true))}
          </div>
        </div>
      </div>

      {/* ── Desktop: dropdown card (xl+) ── */}
      <div
        className={`hidden min-[920px]:flex w-[880px] rounded-2xl border shadow ${isDark ? "bg-[#222222] border-[#333333]" : "bg-[#F4F4F4] border-[#E2E2E2]"}`}
      >
        {/* Left: vertical market type tabs */}
        <div className="flex flex-col p-2 gap-2 text-[12px] leading-[18px] font-semibold items-center">
          {(["all", "perps", "spot"] as MarketType[]).map((m) =>
            marketBtn(m, "w-[92px] text-left"),
          )}
        </div>

        {/* Right: content */}
        <div className="h-80 flex flex-1 flex-col p-2 gap-2">
          {/* Search + category tabs */}
          <div className="flex gap-2">
            <div className="flex-1">{searchInput}</div>
            {categoryTabsEl}
          </div>

          {/* Sub tabs + table */}
          <div className="flex flex-col gap-2 flex-1 overflow-hidden">
            {subTabsEl}

            <div className="flex flex-col gap-2 overflow-y-auto flex-1">
              {/* Header */}
              <div
                className={`grid text-[10px] text-[#A7A7A7] leading-[15px] font-semibold ${
                  showPerpCols
                    ? "grid-cols-[2.5fr_1fr_1fr_1.2fr_1.2fr_1fr]"
                    : "grid-cols-[2.5fr_1fr_1fr_1.2fr]"
                }`}
              >
                <div onClick={() => onSort("pair")}>Pair</div>
                <div onClick={() => onSort("lastPrice")}>Last Price</div>
                <div onClick={() => onSort("change24h")}>24h Change</div>
                <div onClick={() => onSort("volume24h")}>24h Volume</div>
                {showPerpCols && (
                  <>
                    <div>Open Interest</div>
                    <div>8h Funding</div>
                  </>
                )}
              </div>

              {/* Rows */}
              {rows.map((row) => tableRow(row, false))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
