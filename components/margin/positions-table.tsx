import { Position } from "@/lib/types";
import { motion } from "framer-motion";
import Image from "next/image";
import { Button } from "../ui/button";
import { useState, useMemo, useRef, useEffect } from "react";
import { useMarginAccountInfoStore, type BorrowedBalance } from "@/store/margin-account-info-store";
import { TABLE_ROW_HEADINGS, COIN_ICONS } from "@/lib/constants/margin";
import { useTheme } from "@/contexts/theme-context";
import { useShallow } from "zustand/shallow";
import { useMarginHistory } from "@/hooks/use-margin";

interface PositionstableProps {
  onRepayClick?: (asset?: string) => void;
  onOpenPositionClick?: () => void;
}

const ITEMS_PER_PAGE = 5;
const BORROW_DUST_EPSILON = 1e-6;

const canonicalToken = (token: string): string => {
  const normalized = token.toUpperCase();
  if (normalized === 'BLEND_USDC' || normalized === 'USDC') return 'BLUSDC';
  if (normalized === 'AQUIRESUSDC' || normalized === 'AQUARIUS_USDC') return 'AQUSDC';
  if (normalized === 'SOROSWAPUSDC' || normalized === 'SOROSWAP_USDC') return 'SOUSDC';
  return normalized;
};

const getTokenIcon = (asset: string): string => {
  return (
    COIN_ICONS[asset as keyof typeof COIN_ICONS] ||
    COIN_ICONS[asset.replace("0x", "") as keyof typeof COIN_ICONS] ||
    "/icons/eth-icon.png"
  );
};

const formatTokenName = (asset: string): string => {
  if (asset.startsWith("0x")) return asset.split("0x")[1] || asset;
  return asset;
};

export const Positionstable = ({
  onRepayClick,
  onOpenPositionClick,
}: PositionstableProps) => {
  const { isDark } = useTheme();
  const {
    collateralBalances,
    borrowedBalances,
    totalCollateralValue,
    totalBorrowedValue,
    hasMarginAccount,
  } = useMarginAccountInfoStore(
    useShallow((state) => ({
      collateralBalances: state.collateralBalances,
      borrowedBalances: state.borrowedBalances,
      totalCollateralValue: state.totalCollateralValue,
      totalBorrowedValue: state.totalBorrowedValue,
      hasMarginAccount: state.hasMarginAccount,
    })),
  );

  const positions = useMemo<Position[]>(() => {
    const collateralEntries = (Object.entries(collateralBalances) as [string, BorrowedBalance][]).filter(
      ([, bal]) => parseFloat(bal.amount) > 0
    );
    if (collateralEntries.length === 0) return [];

    const borrowedEntries = Object.entries(borrowedBalances) as [string, BorrowedBalance][];
    const dedupedBorrowed = new Map<string, { token: string; balance: BorrowedBalance }>();

    for (const [token, bal] of borrowedEntries) {
      const amount = parseFloat(bal.amount || '0');
      if (!(amount > BORROW_DUST_EPSILON)) continue;

      const canonical = canonicalToken(token);
      const existing = dedupedBorrowed.get(canonical);
      if (!existing || amount > parseFloat(existing.balance.amount || '0')) {
        dedupedBorrowed.set(canonical, { token, balance: bal });
      }
    }

    const borrowedEntriesClean: [string, BorrowedBalance][] = Array.from(dedupedBorrowed.values()).map(
      ({ token, balance }) => [token, balance]
    );

    const totalBorrowUsd = borrowedEntriesClean.reduce(
      (sum: number, [, bal]: [string, BorrowedBalance]) => sum + parseFloat(bal.usdValue || '0'), 0
    );

    const borrowedArray: Position['borrowed'] = borrowedEntriesClean
      .map(([token, bal]) => ({
        assetData: { asset: token, amount: parseFloat(bal.amount).toFixed(2) },
        percentage: totalBorrowUsd > 0
          ? Math.round((parseFloat(bal.usdValue) / totalBorrowUsd) * 100)
          : 0,
        usdValue: parseFloat(bal.usdValue),
      }));

    const equity = totalCollateralValue - totalBorrowedValue;
    const leverage =
      totalCollateralValue > 0 && equity > 0
        ? parseFloat((totalCollateralValue / equity).toFixed(2))
        : 1;

    // A margin account is ONE leveraged position even when collateral and
    // borrow are different assets (e.g. deposit XLM, borrow BLUSDC). The old
    // logic filtered the borrows-list down to only debts that matched the
    // current row's collateral symbol — that hid every cross-asset borrow.
    // Now each collateral row shows the full borrow list; with a single
    // collateral (the typical case) you see exactly your real debt.
    const hasAnyDebt = borrowedArray.length > 0;
    return collateralEntries.map(([token, bal], idx) => {
      return {
        positionId: idx + 1,
        collateral: { asset: token, amount: parseFloat(bal.amount).toFixed(2) },
        collateralUsdValue: parseFloat(bal.usdValue),
        borrowed: borrowedArray,
        leverage,
        interestAccrued: 0,
        isOpen: hasAnyDebt,
        user: '',
      };
    });
  }, [collateralBalances, borrowedBalances, totalCollateralValue, totalBorrowedValue]);

  const { history } = useMarginHistory();

  const [activeTab, setActiveTab] = useState<string>("currentPositions");
  const [currentPage, setCurrentPage] = useState<number>(1);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Filter positions based on active tab
  const filteredPositions = useMemo(() => {
    if (activeTab === "currentPositions") {
      return positions.filter((pos: Position) => pos.borrowed.length > 0);
    } else {
      return positions.filter((pos: Position) => pos.borrowed.length === 0);
    }
  }, [positions, activeTab]);

  // Calculate pagination
  const activeList = activeTab === "positionsHistory" ? history : filteredPositions;
  const totalPages = Math.max(1, Math.ceil(activeList.length / ITEMS_PER_PAGE));
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const paginatedPositions: Position[] = filteredPositions.slice(
    startIndex,
    endIndex,
  );
  const paginatedHistory = history.slice(startIndex, endIndex);

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    setCurrentPage(1);
  };

  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [currentPage, activeTab]);

  const handlePreviousPage = () => {
    if (currentPage > 1) setCurrentPage(currentPage - 1);
  };

  const handleNextPage = () => {
    if (currentPage < totalPages) setCurrentPage(currentPage + 1);
  };

  // ── EMPTY STATE ──
  const renderEmpty = () => (
    <section
      className={`w-full h-[402px] border rounded-[8px] flex flex-col items-center justify-center ${
        isDark ? "bg-[#222222]" : "bg-[#F7F7F7]"
      }`}
    >
      <div className="w-fit h-fit">
        {activeTab === "currentPositions" ? (
          <Button
            size="small"
            type="ghost"
            text="Open Position"
            onClick={onOpenPositionClick}
            disabled={false}
          />
        ) : (
          <p
            className={`text-[14px] font-medium ${
              isDark ? "text-[#919191]" : "text-[#76737B]"
            }`}
          >
            No transaction history
          </p>
        )}
      </div>
    </section>
  );

  // ── HISTORY ROW ──
  const HISTORY_HEADINGS = ["Date", "Type", "Asset", "Amount", "Tx Hash"];

  const renderHistoryRow = (
    item: { type: 'deposit' | 'borrow' | 'repay' | 'transfer-in' | 'transfer-out'; asset: string; amount: string; timestamp: number; hash: string },
    idx: number
  ) => {
    const date = item.timestamp
      ? new Date(item.timestamp).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
      : '—';

    const badgeConfig =
      item.type === 'borrow'
        ? { className: 'bg-red-100 text-red-600', label: 'Borrow' }
        : item.type === 'repay'
          ? { className: 'bg-green-100 text-green-600', label: 'Repay' }
          : item.type === 'transfer-in'
            ? { className: 'bg-violet-100 text-violet-700', label: 'Transfer In' }
            : item.type === 'transfer-out'
              ? { className: 'bg-amber-100 text-amber-700', label: 'Transfer Out' }
              : { className: 'bg-blue-100 text-blue-600', label: 'Deposit' };

    const shortHash = item.hash
      ? `${item.hash.slice(0, 8)}...${item.hash.slice(-4)}`
      : '—';

    return (
      <motion.article
        key={`history-${idx}`}
        className={`flex border rounded-[12px] w-full ${isDark ? "bg-[#222222]" : "bg-[#F7F7F7]"}`}
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.4, delay: idx * 0.08, ease: "easeOut" }}
      >
        {/* Date */}
        <div className={`w-full flex items-center py-[16px] px-[12px] text-[13px] font-medium ${isDark ? "text-[#AAAAAA]" : "text-[#555555]"}`}>
          {date}
        </div>

        {/* Type badge */}
        <div className="w-full flex items-center py-[16px] px-[12px]">
          <span className={`rounded-[4px] py-[2px] px-[8px] text-[11px] font-semibold ${badgeConfig.className}`}>
            {badgeConfig.label}
          </span>
        </div>

        {/* Asset */}
        <div className="w-full flex items-center gap-[8px] py-[16px] px-[12px]">
          {item.asset && (
            <Image
              src={getTokenIcon(item.asset)}
              alt={item.asset}
              width={20}
              height={20}
              className="rounded-[10px] shrink-0"
            />
          )}
          <span className={`text-[13px] font-medium ${isDark ? "text-white" : ""}`}>
            {item.asset || '—'}
          </span>
        </div>

        {/* Amount */}
        <div className={`w-full flex items-center py-[16px] px-[12px] text-[13px] font-medium ${isDark ? "text-white" : ""}`}>
          {(parseFloat(String(item.amount ?? '0')) || 0).toFixed(2)}
        </div>

        {/* Tx Hash */}
        <div className="w-full flex items-center py-[16px] px-[12px]">
          {item.hash ? (
            <a
              href={`https://stellar.expert/explorer/testnet/tx/${item.hash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[13px] font-medium text-[#703AE6] hover:underline"
            >
              {shortHash}
            </a>
          ) : (
            <span className={`text-[13px] ${isDark ? "text-[#666666]" : "text-[#A0A0A0]"}`}>—</span>
          )}
        </div>
      </motion.article>
    );
  };

  // ── POSITION CARD ──
  const renderPositionCard = (item: Position, idx: number) => (
    <motion.article
      key={item.positionId}
      className={`flex border rounded-[12px] w-full ${
        isDark ? "bg-[#222222]" : "bg-[#F7F7F7]"
      }`}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.4, delay: idx * 0.08, ease: "easeOut" }}
    >
      {/* Collateral column */}
      <div className="w-full flex flex-col gap-[6px] py-[16px] px-[12px]">
        <motion.div
          className="flex gap-[8px] items-center"
          initial={{ opacity: 0, x: -10 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.3, delay: idx * 0.08 + 0.1 }}
        >
          <Image
            src={getTokenIcon(item.collateral.asset)}
            alt={item.collateral.asset}
            width={20}
            height={20}
            className="rounded-[10px] shrink-0"
          />
          <div className="flex flex-col gap-[1px]">
            <div
              className={`text-[13px] font-medium leading-tight ${
                isDark ? "text-white" : ""
              }`}
            >
              {item.collateral.amount} {formatTokenName(item.collateral.asset)}
            </div>
            <div
              className={`text-[11px] font-medium ${
                isDark ? "text-[#919191]" : "text-[#76737B]"
              }`}
            >
              ${item.collateralUsdValue}
            </div>
          </div>
        </motion.div>
      </div>

      {/* Borrowed assets column */}
      <div className="w-full flex flex-col gap-[6px] py-[16px] px-[12px]">
        {item.borrowed.map((borrowedItem, borrowedIdx) => (
          <motion.div
            key={borrowedIdx}
            className="flex gap-[8px] items-center"
            initial={{ opacity: 0, x: -10 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{
              duration: 0.3,
              delay: idx * 0.08 + borrowedIdx * 0.05 + 0.15,
            }}
          >
            <Image
              src={getTokenIcon(borrowedItem.assetData.asset)}
              alt={borrowedItem.assetData.asset}
              width={20}
              height={20}
              className="rounded-[10px] shrink-0"
            />
            <div className="flex flex-col gap-[1px]">
              <div
                className={`text-[13px] font-medium leading-tight ${
                  isDark ? "text-white" : ""
                }`}
              >
                {borrowedItem.assetData.amount}{" "}
                {formatTokenName(borrowedItem.assetData.asset)}
              </div>
              <div
                className={`text-[11px] font-medium ${
                  isDark ? "text-[#919191]" : "text-[#76737B]"
                }`}
              >
                ${borrowedItem.usdValue}
              </div>
            </div>
            {borrowedItem.percentage > 0 && (
              <div className="h-fit bg-[#F1EBFD] rounded-[4px] py-[1px] px-[6px] text-[10px] font-medium text-[#703AE6]">
                {borrowedItem.percentage}%
              </div>
            )}
          </motion.div>
        ))}
      </div>

      {/* Leverage column */}
      <motion.div
        className={`flex flex-col justify-center w-full py-[16px] px-[12px] text-[14px] font-semibold ${
          isDark ? "text-white" : ""
        }`}
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.3, delay: idx * 0.08 + 0.2 }}
      >
        {item.leverage > 0 ? (
          <span className="text-[#703AE6]">{item.leverage}x</span>
        ) : (
          <span className={isDark ? "text-[#666666]" : "text-[#A0A0A0]"}>
            -
          </span>
        )}
      </motion.div>

      {/* Interest accrued column */}
      <motion.div
        className={`w-full flex items-center gap-[4px] text-[13px] font-medium py-[16px] px-[12px] ${
          isDark ? "text-white" : ""
        }`}
        initial={{ opacity: 0, x: 10 }}
        whileInView={{ opacity: 1, x: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.3, delay: idx * 0.08 + 0.25 }}
      >
        {item.interestAccrued > 0 ? (
          <>
            <svg
              width="12"
              height="12"
              viewBox="0 0 14 14"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="shrink-0"
            >
              <path
                d="M6 3.33333H7.33333V4.66667H6V3.33333ZM6 6H7.33333V10H6V6ZM6.66667 0C2.98667 0 0 2.98667 0 6.66667C0 10.3467 2.98667 13.3333 6.66667 13.3333C10.3467 13.3333 13.3333 10.3467 13.3333 6.66667C13.3333 2.98667 10.3467 0 6.66667 0ZM6.66667 12C3.72667 12 1.33333 9.60667 1.33333 6.66667C1.33333 3.72667 3.72667 1.33333 6.66667 1.33333C9.60667 1.33333 12 3.72667 12 6.66667C12 9.60667 9.60667 12 6.66667 12Z"
                fill={isDark ? "#FFFFFF" : "black"}
              />
            </svg>
            ${item.interestAccrued}
          </>
        ) : (
          <span className={isDark ? "text-[#666666]" : "text-[#A0A0A0]"}>
            $0
          </span>
        )}
      </motion.div>

      {/* Action column */}
      <motion.div
        className="flex flex-col justify-center w-full py-[16px] px-[12px]"
        initial={{ opacity: 0, scale: 0.9 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.3, delay: idx * 0.08 + 0.3 }}
      >
        {item.isOpen && item.borrowed.length > 0 ? (
          <div className="w-fit">
            <Button
              size="small"
              type="gradient"
              disabled={false}
              text="Repay"
              onClick={() => onRepayClick?.(item.borrowed[0]?.assetData.asset)}
            />
          </div>
        ) : (
          <span className={`text-[12px] font-medium ${isDark ? "text-[#666666]" : "text-[#A0A0A0]"}`}>
            Repaid
          </span>
        )}
      </motion.div>
    </motion.article>
  );

  // ── MOBILE POSITION CARD ──
  const renderMobilePositionCard = (item: Position, idx: number) => {
    const hasBorrow = item.borrowed.length > 0;
    const lbl = `text-[11px] font-medium ${isDark ? "text-[#A0A0A0]" : "text-[#6B7280]"}`;
    const val = `text-[13px] font-semibold ${isDark ? "text-white" : "text-[#111]"}`;

    return (
      <motion.div
        key={`mobile-${item.positionId}`}
        className={`rounded-lg border p-3 flex flex-col gap-2.5 ${isDark ? "border-[#333333] bg-[#2A2A2A]" : "border-[#E2E2E2] bg-white"}`}
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.4, delay: idx * 0.08, ease: "easeOut" }}
      >
        {/* Collateral + Borrowed */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className={`${lbl} mb-1`}>Collateral Deposited</p>
            <div className="flex gap-1.5 items-center">
              <Image
                src={getTokenIcon(item.collateral.asset)}
                alt={item.collateral.asset}
                width={16}
                height={16}
                className="rounded-full shrink-0"
              />
              <div>
                <div className={`text-[12px] font-medium leading-tight ${isDark ? "text-white" : ""}`}>
                  {item.collateral.amount} {formatTokenName(item.collateral.asset)}
                </div>
                <div className={`text-[10px] ${isDark ? "text-[#919191]" : "text-[#76737B]"}`}>
                  ${item.collateralUsdValue}
                </div>
              </div>
            </div>
          </div>
          <div>
            <p className={`${lbl} mb-1`}>Borrowed Assets</p>
            {hasBorrow ? (
              <div className="flex flex-col gap-1">
                {item.borrowed.map((borrowedItem, borrowedIdx) => (
                  <div key={borrowedIdx} className="flex gap-1.5 items-center">
                    <Image
                      src={getTokenIcon(borrowedItem.assetData.asset)}
                      alt={borrowedItem.assetData.asset}
                      width={16}
                      height={16}
                      className="rounded-full shrink-0"
                    />
                    <div>
                      <div className={`text-[12px] font-medium leading-tight ${isDark ? "text-white" : ""}`}>
                        {borrowedItem.assetData.amount} {formatTokenName(borrowedItem.assetData.asset)}
                      </div>
                      <div className="flex items-center gap-1">
                        <span className={`text-[10px] ${isDark ? "text-[#919191]" : "text-[#76737B]"}`}>
                          ${borrowedItem.usdValue}
                        </span>
                        {borrowedItem.percentage > 0 && (
                          <span className="bg-[#F1EBFD] rounded px-1 text-[9px] font-medium text-[#703AE6]">
                            {borrowedItem.percentage}%
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className={`text-[11px] italic ${isDark ? "text-[#666666]" : "text-[#A0A0A0]"}`}>No borrows</div>
            )}
          </div>
        </div>

        {/* Stats strip */}
        <div className={`rounded-md px-3 py-2 grid grid-cols-2 gap-2 ${isDark ? "bg-[#1A1A1A]" : "bg-[#F0F0F0]"}`}>
          <div>
            <p className={lbl}>Leverage</p>
            <p className={`text-[13px] font-semibold ${item.leverage > 0 ? "text-[#703AE6]" : isDark ? "text-[#666]" : "text-[#A0A0A0]"}`}>
              {item.leverage > 0 ? `${item.leverage}x` : "-"}
            </p>
          </div>
          <div>
            <p className={lbl}>Interest Accrued</p>
            <p className={val}>{item.interestAccrued > 0 ? `$${item.interestAccrued}` : "$0"}</p>
          </div>
        </div>

        {/* Action */}
        <div className="flex justify-end">
          {item.isOpen && item.borrowed.length > 0 ? (
            <Button
              size="small"
              type="gradient"
              disabled={false}
              text="Repay"
              onClick={() => onRepayClick?.(item.borrowed[0]?.assetData.asset)}
            />
          ) : (
            <span className={`text-[12px] font-medium ${isDark ? "text-[#666666]" : "text-[#A0A0A0]"}`}>
              Repaid
            </span>
          )}
        </div>
      </motion.div>
    );
  };

  return (
    <section className="w-full flex flex-col gap-3">
      {/* Title with position count */}
      <motion.div
        className="flex items-center gap-[12px]"
        initial={{ opacity: 0, y: -20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      >
        <h2 className={`text-[20px] font-bold ${isDark ? "text-white" : ""}`}>
          Positions
        </h2>
        {filteredPositions.length > 0 && (
          <span className="px-[10px] py-[3px] rounded-full bg-[#F1EBFD] text-[#703AE6] text-[13px] font-semibold">
            {filteredPositions.length}
          </span>
        )}
      </motion.div>

      <nav className={`w-full sm:w-fit flex gap-1 p-1 rounded-xl border ${isDark ? "bg-[#111111] border-[#333333]" : "bg-white border-[#E5E7EB]"}`}>
        {[
          { id: "currentPositions", label: "Current Positions", short: "Current" },
          { id: "positionsHistory", label: "Positions History", short: "History" },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => handleTabChange(tab.id)}
            className={`flex-1 sm:flex-none rounded-lg px-4 py-2 text-[12px] sm:text-[13px] font-semibold transition-colors whitespace-nowrap ${
              activeTab === tab.id
                ? "bg-[#703AE6] text-white"
                : isDark ? "text-[#999999]" : "text-[#9CA3AF]"
            }`}
          >
            <span className="sm:hidden">{tab.short}</span>
            <span className="hidden sm:inline">{tab.label}</span>
          </button>
        ))}
      </nav>

      {activeTab === "positionsHistory" ? (
        history.length > 0 ? (
          <div className="w-full overflow-x-auto no-scrollbar hidden xl:block">
            <section className="rounded-xl min-w-[700px]">
              {/* History table headers */}
              <ul className="flex" role="row">
                {HISTORY_HEADINGS.map((heading, idx) => (
                  <motion.li
                    className={`w-full pt-[11.25px] px-3 pb-3 font-medium text-[12px] sm:text-[13px] ${
                      isDark ? "text-[#999999]" : "text-[#464545]"
                    }`}
                    key={heading}
                    initial={{ opacity: 0, y: -10 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.3, delay: idx * 0.05 }}
                  >
                    {heading}
                  </motion.li>
                ))}
              </ul>

              {/* History rows */}
              <section
                ref={scrollContainerRef}
                className="flex flex-col gap-2 max-h-[520px] overflow-y-auto pr-1 thin-scrollbar"
              >
                {paginatedHistory.map((item, idx) => renderHistoryRow(item, idx))}
              </section>

              {/* Pagination */}
              {totalPages > 1 && (
                <motion.div
                  className="flex items-center justify-center gap-4 py-4"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  <button
                    type="button"
                    onClick={handlePreviousPage}
                    disabled={currentPage === 1}
                    className={`flex items-center justify-center w-8 h-8 transition-colors ${currentPage === 1 ? "cursor-not-allowed opacity-30" : "cursor-pointer hover:opacity-70"} ${isDark ? "text-white" : "text-[#111111]"}`}
                    aria-label="Previous page"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M7.5 9L4.5 6L7.5 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <span className="px-5 py-1.5 rounded-full bg-[#F1EBFD] text-[#703AE6] text-[13px] font-semibold">
                    {currentPage} of {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={handleNextPage}
                    disabled={currentPage === totalPages}
                    className={`flex items-center justify-center w-8 h-8 transition-colors ${currentPage === totalPages ? "cursor-not-allowed opacity-30" : "cursor-pointer hover:opacity-70"} ${isDark ? "text-white" : "text-[#111111]"}`}
                    aria-label="Next page"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M4.5 9L7.5 6L4.5 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </motion.div>
              )}
            </section>
          </div>
        ) : (
          renderEmpty()
        )
      ) : hasMarginAccount && filteredPositions.length > 0 ? (
        <>
          {/* Desktop table */}
          <div className="w-full overflow-x-auto no-scrollbar hidden xl:block">
            <section className="rounded-xl min-w-[700px]">
              {/* Table headers */}
              <ul className="flex" role="row">
                {TABLE_ROW_HEADINGS.map((item, idx) => (
                  <motion.li
                    className={`w-full pt-[11.25px] px-3 pb-3 font-medium text-[12px] sm:text-[13px] ${
                      isDark ? "text-[#999999]" : "text-[#464545]"
                    }`}
                    key={item}
                    initial={{ opacity: 0, y: -10 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.3, delay: idx * 0.05 }}
                  >
                    {item}
                  </motion.li>
                ))}
              </ul>

              {/* Position rows */}
              <section
                ref={scrollContainerRef}
                className="flex flex-col gap-2 max-h-[520px] overflow-y-auto pr-1 thin-scrollbar"
              >
                {paginatedPositions.map((item, idx) =>
                  renderPositionCard(item, idx),
                )}
              </section>

              {/* Pagination */}
              {totalPages > 1 && (
                <motion.div
                  className="flex items-center justify-center gap-4 py-4"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  <button
                    type="button"
                    onClick={handlePreviousPage}
                    disabled={currentPage === 1}
                    className={`flex items-center justify-center w-10 h-10 transition-colors ${
                      currentPage === 1
                        ? "cursor-not-allowed opacity-30"
                        : "cursor-pointer hover:opacity-70"
                    } ${isDark ? "text-white" : "text-[#111111]"}`}
                    aria-label="Previous page"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M7.5 9L4.5 6L7.5 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <span className="px-6 py-2 rounded-full bg-[#F1EBFD] text-[#703AE6] text-[14px] font-semibold">
                    {currentPage} of {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={handleNextPage}
                    disabled={currentPage === totalPages}
                    className={`flex items-center justify-center w-10 h-10 transition-colors ${
                      currentPage === totalPages
                        ? "cursor-not-allowed opacity-30"
                        : "cursor-pointer hover:opacity-70"
                    } ${isDark ? "text-white" : "text-[#111111]"}`}
                    aria-label="Next page"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M4.5 9L7.5 6L4.5 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </motion.div>
              )}
            </section>
          </div>

          {/* Mobile cards */}
          <div className={`xl:hidden p-2 rounded-lg border flex flex-col gap-2 ${isDark ? "border-[#333333] bg-[#222222]" : "border-[#E2E2E2] bg-[#F7F7F7]"}`}>
            {paginatedPositions.map((item, idx) => renderMobilePositionCard(item, idx))}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-4 py-3">
                <button
                  type="button"
                  onClick={handlePreviousPage}
                  disabled={currentPage === 1}
                  className={`flex items-center justify-center w-8 h-8 transition-colors ${currentPage === 1 ? "cursor-not-allowed opacity-30" : "cursor-pointer hover:opacity-70"} ${isDark ? "text-white" : "text-[#111111]"}`}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M7.5 9L4.5 6L7.5 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
                <span className="px-5 py-1.5 rounded-full bg-[#F1EBFD] text-[#703AE6] text-[13px] font-semibold">{currentPage} of {totalPages}</span>
                <button
                  type="button"
                  onClick={handleNextPage}
                  disabled={currentPage === totalPages}
                  className={`flex items-center justify-center w-8 h-8 transition-colors ${currentPage === totalPages ? "cursor-not-allowed opacity-30" : "cursor-pointer hover:opacity-70"} ${isDark ? "text-white" : "text-[#111111]"}`}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 9L7.5 6L4.5 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
            )}
          </div>
        </>
      ) : (
        renderEmpty()
      )}
    </section>
  );
};
