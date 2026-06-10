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
import { useTokenPrices } from "@/hooks/use-token-prices";
import { buildBorrowAttributionFromHistory } from "@/lib/margin-position-attribution";
import { isTrackingSymbol } from "@/lib/analytics/stellar/canon";

interface PositionstableProps {
  onRepayClick?: (asset?: string) => void;
  onOpenPositionClick?: () => void;
}

const ITEMS_PER_PAGE = 5;
// Match the store's USD-denominated dust floor. A previously-repaid loan
// often leaves a sub-cent residual that rounds to "0.00 XLM" in the UI but
// would still pass an amount-only filter — keeping the Repay button hot
// when there's nothing real left to repay.
const BORROW_DUST_USD = 0.01;
const BORROW_DUST_EPSILON = 1e-6;

const PRICEABLE_TOKENS = ['XLM', 'USDC', 'BLUSDC', 'AQUSDC', 'SOUSDC'];

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

const formatInterestUsd = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
};

export const Positionstable = ({
  onRepayClick,
  onOpenPositionClick,
}: PositionstableProps) => {
  const { isDark } = useTheme();
  const {
    borrowedBalances,
    collateralBalances,
    totalBorrowedValue,
    netAvailableCollateral,
    hasMarginAccount,
  } = useMarginAccountInfoStore(
    useShallow((state) => ({
      borrowedBalances: state.borrowedBalances,
      collateralBalances: state.collateralBalances,
      totalBorrowedValue: state.totalBorrowedValue,
      netAvailableCollateral: state.netAvailableCollateral,
      hasMarginAccount: state.hasMarginAccount,
    })),
  );

  const { history, isLoading: historyInitialLoading } = useMarginHistory();
  const tokenPrices = useTokenPrices(PRICEABLE_TOKENS);

  const positions = useMemo<Position[]>(() => {
    // ── Step 1: Deduplicate borrowed tokens by canonical symbol ──────────────
    const dedupedBorrowed = new Map<string, { token: string; balance: BorrowedBalance }>();
    for (const [token, bal] of Object.entries(borrowedBalances) as [string, BorrowedBalance][]) {
      const amount = parseFloat(bal.amount || '0');
      const usd = parseFloat(bal.usdValue || '0');
      if (!(amount > BORROW_DUST_EPSILON) || !(usd > BORROW_DUST_USD)) continue;
      const canonical = canonicalToken(token);
      const existing = dedupedBorrowed.get(canonical);
      if (!existing || amount > parseFloat(existing.balance.amount || '0')) {
        dedupedBorrowed.set(canonical, { token, balance: bal });
      }
    }

    // ── Step 2: Net deposited collateral per token ───────────────────────────
    // SAC reconcile includes borrowed tokens sitting in the margin wallet (e.g.
    // BLUSDC from a cross-asset borrow). Subtract same-token debt so we only
    // anchor positions on assets the user actually deposited — not on borrowed
    // proceeds that happen to share a wallet balance key.
    const dedupedCollateral = new Map<string, { token: string; balance: BorrowedBalance }>();
    for (const [token, bal] of Object.entries(collateralBalances) as [string, BorrowedBalance][]) {
      // Farm/LP receipts (BLEND_XLM, SS_XLM_USDC, AQ_*) live in collateralBalances
      // for the header HF/value calc but are NOT margin positions — skip them so
      // they don't render as collateral rows. Real collateral uses canonical keys
      // (XLM, USDC, BLUSDC, AQUSDC, SOUSDC), for which isTrackingSymbol is false.
      if (isTrackingSymbol(token)) continue;

      const grossAmount = parseFloat(bal.amount || '0');
      const grossUsd = parseFloat(bal.usdValue || '0');
      if (!(grossAmount > BORROW_DUST_EPSILON) || !(grossUsd > BORROW_DUST_USD)) continue;

      const canonical = canonicalToken(token);
      const sameTokenBorrow = dedupedBorrowed.get(canonical);
      const borrowedAmount = sameTokenBorrow
        ? parseFloat(sameTokenBorrow.balance.amount || '0')
        : 0;
      const borrowedUsd = sameTokenBorrow
        ? parseFloat(sameTokenBorrow.balance.usdValue || '0')
        : 0;

      const netAmount = Math.max(0, grossAmount - borrowedAmount);
      const netUsd = Math.max(0, grossUsd - borrowedUsd);
      if (!(netAmount > BORROW_DUST_EPSILON) || !(netUsd > BORROW_DUST_USD)) continue;

      const netBalance: BorrowedBalance = {
        amount: netAmount.toFixed(7),
        usdValue: netUsd.toFixed(2),
      };
      const existing = dedupedCollateral.get(canonical);
      if (!existing || netUsd > parseFloat(existing.balance.usdValue || '0')) {
        dedupedCollateral.set(canonical, { token, balance: netBalance });
      }
    }

    // ── Step 3: Build per-token interest principal from history ──────────────
    const netPrincipalByToken: Record<string, number> = {};
    if (!historyInitialLoading) {
      for (const item of history) {
        const canonical = canonicalToken(item.asset || '');
        const amt = parseFloat(String(item.amount ?? '0')) || 0;
        if (!Number.isFinite(amt) || amt <= 0) continue;
        if (item.type === 'borrow') {
          netPrincipalByToken[canonical] = (netPrincipalByToken[canonical] ?? 0) + amt;
        } else if (item.type === 'repay') {
          netPrincipalByToken[canonical] = (netPrincipalByToken[canonical] ?? 0) - amt;
        }
      }
    }

    // ── Step 4: Group borrows under the deposit collateral that opened them ──
    // Use local margin history (deposit + borrow share the same tx hash) so
    // cross-asset borrows attach to the correct deposit row — e.g. deposit XLM
    // → borrow BLUSDC stays on the XLM row, while deposit BLUSDC → borrow
    // BLUSDC gets its own BLUSDC row.
    const { borrowsByCollateral: historyAttribution, principalByPair } =
      buildBorrowAttributionFromHistory(history);

    const collateralKeys = Array.from(dedupedCollateral.keys());
    const borrowsByPosition = new Map<string, string[]>();
    for (const key of collateralKeys) borrowsByPosition.set(key, []);

    for (const [collateralCanonical, borrowSet] of historyAttribution.entries()) {
      if (!borrowsByPosition.has(collateralCanonical)) continue;
      for (const borrowCanonical of borrowSet) {
        const list = borrowsByPosition.get(collateralCanonical)!;
        if (!list.includes(borrowCanonical)) list.push(borrowCanonical);
      }
    }

    let largestCollateralKey = collateralKeys[0] ?? "XLM";
    let largestCollateralUsd = 0;
    for (const key of collateralKeys) {
      const usd = parseFloat(dedupedCollateral.get(key)!.balance.usdValue || "0");
      if (usd > largestCollateralUsd) {
        largestCollateralUsd = usd;
        largestCollateralKey = key;
      }
    }

    const assignedBorrows = new Set<string>();
    for (const list of borrowsByPosition.values()) {
      for (const b of list) assignedBorrows.add(b);
    }

    for (const borrowCanonical of dedupedBorrowed.keys()) {
      if (assignedBorrows.has(borrowCanonical)) continue;

      if (borrowsByPosition.has(borrowCanonical)) {
        borrowsByPosition.get(borrowCanonical)!.push(borrowCanonical);
      } else if (borrowsByPosition.has(largestCollateralKey)) {
        borrowsByPosition.get(largestCollateralKey)!.push(borrowCanonical);
      }
      assignedBorrows.add(borrowCanonical);
    }

    // ── Step 5: Build one Position per collateral token ──────────────────────
    const positionRows: Position[] = [];
    let positionId = 1;

    // Sort collateral keys so XLM (typically largest) comes first
    const sortedCollateralKeys = collateralKeys.sort((a, b) => {
      const usdA = parseFloat(dedupedCollateral.get(a)?.balance.usdValue || '0');
      const usdB = parseFloat(dedupedCollateral.get(b)?.balance.usdValue || '0');
      return usdB - usdA;
    });

    for (const collateralCanonical of sortedCollateralKeys) {
      const collateralEntry = dedupedCollateral.get(collateralCanonical)!;
      const collateralUsd = parseFloat(collateralEntry.balance.usdValue || '0');
      const collateralAmt = parseFloat(collateralEntry.balance.amount || '0');

      const thisBorrowKeys = borrowsByPosition.get(collateralCanonical) ?? [];
      const thisBorrows = thisBorrowKeys
        .map((k) => dedupedBorrowed.get(k))
        .filter((b): b is { token: string; balance: BorrowedBalance } => !!b);

      const borrowedArray: Position["borrowed"] = [];
      let thisBorrowUsd = 0;

      for (const b of thisBorrows) {
        const borrowCanonical = canonicalToken(b.token);
        const pairKey = `${collateralCanonical}:${borrowCanonical}`;
        const onChainAmt = parseFloat(b.balance.amount || "0");
        const onChainUsd = parseFloat(b.balance.usdValue || "0");

        let displayAmt = onChainAmt;
        const totalHistoryForToken = Array.from(principalByPair.entries())
          .filter(([key]) => key.endsWith(`:${borrowCanonical}`))
          .reduce((sum, [, amt]) => sum + amt, 0);

        if (totalHistoryForToken > 0 && onChainAmt > 0) {
          const historyPrincipal = principalByPair.get(pairKey) ?? 0;
          displayAmt = onChainAmt * (historyPrincipal / totalHistoryForToken);
        }

        if (!(displayAmt > BORROW_DUST_EPSILON)) continue;

        const price = onChainAmt > 0 ? onChainUsd / onChainAmt : (tokenPrices[borrowCanonical] ?? 1);
        const displayUsd = displayAmt * price;
        thisBorrowUsd += displayUsd;

        borrowedArray.push({
          assetData: {
            asset: b.token,
            amount: displayAmt.toFixed(2),
          },
          percentage: 0,
          usdValue: parseFloat(displayUsd.toFixed(2)),
        });
      }

      if (thisBorrowUsd > 0) {
        for (const item of borrowedArray) {
          item.percentage = Math.round((item.usdValue / thisBorrowUsd) * 100);
        }
      }

      const hasDebt = borrowedArray.length > 0;

      // Equity for this position = collateral USD value (from chain)
      // Leverage = 1 + borrows / collateral
      const equityUsd = collateralUsd > BORROW_DUST_USD ? collateralUsd : 0;
      const leverage = equityUsd > BORROW_DUST_USD
        ? parseFloat((1 + thisBorrowUsd / equityUsd).toFixed(2))
        : 1;

      // Interest accrued for this position's borrows only
      let interestAccruedUsd = 0;
      if (!historyInitialLoading) {
        for (const b of thisBorrows) {
          const canonical = canonicalToken(b.token);
          const currentAmt = parseFloat(b.balance.amount || '0');
          const principalAmt = Math.max(0, netPrincipalByToken[canonical] ?? 0);
          const diff = currentAmt - principalAmt;
          if (diff > 0) {
            const price = tokenPrices[canonical] ?? 1;
            interestAccruedUsd += diff * price;
          }
        }
      }

      if (hasDebt || collateralAmt > BORROW_DUST_EPSILON) {
        positionRows.push({
          positionId: positionId++,
          collateral: {
            asset: collateralEntry.token,
            amount: collateralAmt.toFixed(2),
          },
          collateralUsdValue: parseFloat(collateralUsd.toFixed(2)),
          borrowed: borrowedArray,
          leverage,
          interestAccrued: hasDebt ? parseFloat(interestAccruedUsd.toFixed(4)) : 0,
          isOpen: hasDebt || collateralAmt > BORROW_DUST_EPSILON,
          user: "",
        });
      }
    }

    // Edge case: borrowed tokens but no collateral in dedupedCollateral
    // (e.g. account has debt but collateralBalances hasn't loaded yet) →
    // fall back to a single aggregated position using netAvailableCollateral
    if (positionRows.length === 0 && dedupedBorrowed.size > 0) {
      const allBorrows = Array.from(dedupedBorrowed.values());
      const totalBorrowUsd = allBorrows.reduce(
        (sum, b) => sum + parseFloat(b.balance.usdValue || '0'), 0
      );
      const equityUsd = netAvailableCollateral > BORROW_DUST_USD ? netAvailableCollateral : 0;
      const underlying = canonicalToken(allBorrows[0]?.token ?? 'XLM');
      const price = tokenPrices[underlying] ?? tokenPrices.XLM ?? 0;
      positionRows.push({
        positionId: 1,
        collateral: {
          asset: underlying,
          amount: price > 0 ? (equityUsd / price).toFixed(2) : '0',
        },
        collateralUsdValue: equityUsd,
        borrowed: allBorrows.map(b => ({
          assetData: { asset: b.token, amount: parseFloat(b.balance.amount).toFixed(2) },
          percentage: totalBorrowUsd > 0
            ? Math.round((parseFloat(b.balance.usdValue) / totalBorrowUsd) * 100) : 0,
          usdValue: parseFloat(b.balance.usdValue),
        })),
        leverage: equityUsd > BORROW_DUST_USD
          ? parseFloat((1 + totalBorrowedValue / equityUsd).toFixed(2)) : 1,
        interestAccrued: 0,
        isOpen: true,
        user: "",
      });
    }

    return positionRows;
  }, [
    borrowedBalances,
    collateralBalances,
    totalBorrowedValue,
    netAvailableCollateral,
    history,
    historyInitialLoading,
    tokenPrices,
  ]);

  const [activeTab, setActiveTab] = useState<string>("currentPositions");
  const [currentPage, setCurrentPage] = useState<number>(1);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Current Positions = non-zero **cash / pool deposit** collateral (XLM, USDC,
  // BLUSDC, …). Farm receipt symbols (BLEND_*, AQ_*, SS_*) are excluded upstream
  // in the collateral loop via isTrackingSymbol — they are farm positions, not
  // margin collateral, and only live in collateralBalances for the HF/value calc.
  const filteredPositions = useMemo(() => {
    if (activeTab === "currentPositions") return positions;
    return [];
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
      <div
        className={`w-full py-[16px] px-[12px] ${
          item.borrowed.length > 0
            ? "flex flex-col gap-[6px]"
            : "flex items-center"
        }`}
      >
        {item.borrowed.length > 0 ? (
          item.borrowed.map((borrowedItem, borrowedIdx) => (
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
          ))
        ) : (
          <span
            className={`text-[13px] font-medium ${
              isDark ? "text-[#666666]" : "text-[#A0A0A0]"
            }`}
          >
            $0
          </span>
        )}
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
        {/* Interest accrual UI is temporarily hardcoded to $0 — the on-chain
            b_rate-derived value was being displayed incorrectly for some
            positions, so we suppress it until the calc is verified. */}
        <span className={isDark ? "text-[#666666]" : "text-[#A0A0A0]"}>
          $0
        </span>
      </motion.div>

      {/* Action column */}
      <motion.div
        className="flex flex-col justify-center w-full py-[16px] px-[12px]"
        initial={{ opacity: 0, scale: 0.9 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.3, delay: idx * 0.08 + 0.3 }}
      >
        {(() => {
          const totalBorrowUsd = item.borrowed.reduce((s, b) => s + (b.usdValue || 0), 0);
          const canRepay = item.borrowed.length > 0 && totalBorrowUsd > BORROW_DUST_USD;
          return (
            <div className="w-fit">
              <Button
                size="small"
                type="gradient"
                disabled={!canRepay}
                text="Repay"
                onClick={() => canRepay && onRepayClick?.(item.borrowed[0]?.assetData.asset)}
              />
            </div>
          );
        })()}
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
              <div className={`text-[12px] font-medium ${isDark ? "text-[#666666]" : "text-[#A0A0A0]"}`}>$0</div>
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
            <p className={val}>$0</p>
          </div>
        </div>

        {/* Action */}
        <div className="flex justify-end">
          {(() => {
            const totalBorrowUsd = item.borrowed.reduce((s, b) => s + (b.usdValue || 0), 0);
            const canRepay = item.borrowed.length > 0 && totalBorrowUsd > BORROW_DUST_USD;
            return (
              <Button
                size="small"
                type="gradient"
                disabled={!canRepay}
                text="Repay"
                onClick={() => canRepay && onRepayClick?.(item.borrowed[0]?.assetData.asset)}
              />
            );
          })()}
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
