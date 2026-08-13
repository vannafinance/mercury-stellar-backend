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
import { isTrackingSymbol } from "@/lib/analytics/stellar/canon";
import { formatTokenAmount, formatUsdValue } from "@/lib/utils/format-amount";

interface PositionstableProps {
  /** Fired from a row's Repay button; passes the borrowed asset to prefill the Repay tab. */
  onRepayClick?: (asset?: string) => void;
  /** Fired from the empty-state CTA to start opening a new position. */
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

// Delegate to the shared adaptive formatter: "$0.00" for true zero, "<$0.01" for
// sub-cent dust, "$X.XX" otherwise — consistent with the header and repay tab.
const formatInterestUsd = (value: number): string => formatUsdValue(value);

/**
 * Collateral cell for a borrow-only position row — a borrow that is
 * cross-collateralized against the whole margin account (typical of an MB
 * borrow against several selected assets) rather than tied to one deposit.
 * Reads "Portfolio" instead of guessing a single backing token, so the row is
 * honest about what secures the debt.
 */
const PortfolioCollateralCell = ({ isDark, compact }: { isDark: boolean; compact?: boolean }) => (
  <div className="flex items-center gap-2">
    <span
      className={`shrink-0 rounded-full flex items-center justify-center ${compact ? "w-4 h-4" : "w-5 h-5"}`}
      style={{ background: "linear-gradient(135deg, #FC5457 10%, #703AE6 80%)" }}
      aria-hidden="true"
    >
      <svg width={compact ? 9 : 11} height={compact ? 9 : 11} viewBox="0 0 12 12" fill="none">
        <circle cx="4" cy="4" r="2.1" fill="white" />
        <circle cx="8" cy="4" r="2.1" fill="white" fillOpacity="0.75" />
        <circle cx="6" cy="8" r="2.1" fill="white" fillOpacity="0.55" />
      </svg>
    </span>
    <div className="flex flex-col gap-px">
      <span className={`${compact ? "text-[12px]" : "text-[13px]"} font-medium leading-tight ${isDark ? "text-white" : ""}`}>
        Portfolio
      </span>
      <span className={`${compact ? "text-[10px]" : "text-[11px]"} font-medium ${isDark ? "text-[#919191]" : "text-[#76737B]"}`}>
        Cross-collateral
      </span>
    </div>
  </div>
);

/**
 * Margin positions panel with two tabs: Current Positions and Positions
 * History. Current positions are derived from on-chain state in the margin
 * store — borrowed and collateral balances are deduplicated by canonical
 * symbol, dust is filtered, farm/LP receipt tokens are excluded, and borrows are
 * attributed back to the deposit that opened them (via shared tx hashes in local
 * margin history) so each row reads as one collateral-anchored position with its
 * leverage and Repay action. Renders a desktop table, mobile cards, paginated
 * history, and per-tab empty states. Repay is enabled whenever any real debt
 * remains — including sub-cent dust — so a residual balance can be fully cleared.
 */
export const Positionstable = ({
  onRepayClick,
  onOpenPositionClick,
}: PositionstableProps) => {
  const { isDark } = useTheme();
  const {
    borrowedBalances,
    collateralBalances,
    netAvailableCollateral,
    hasMarginAccount,
  } = useMarginAccountInfoStore(
    useShallow((state) => ({
      borrowedBalances: state.borrowedBalances,
      collateralBalances: state.collateralBalances,
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
      // Keep any real (non-zero) debt — including sub-$0.01 dust — so the user can
      // see and repay it. (Previously a $0.01 USD floor hid residual debt and left
      // the Repay button disabled while debt still existed on-chain.)
      if (!(amount > BORROW_DUST_EPSILON)) continue;
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

    // ── Step 4: One combined row for the whole margin account ────────────────
    // Vanna's margin accounts are cross-collateralized — one shared Health
    // Factor and borrowing capacity across every deposit (see the account-wide
    // stats above this table) — not isolated per-asset positions like
    // Aave/Compound. A debt has no single "owning" deposit to attribute it to,
    // since ANY deposit backs ALL debt equally. So: one row, listing every
    // collateral and every borrow, instead of guessing which deposit "opened"
    // which loan (a former per-collateral-row design that either duplicated
    // debt across rows or reparented it onto an unrelated same-symbol deposit —
    // both worse than just showing the true shared-liability picture).
    if (dedupedCollateral.size === 0 && dedupedBorrowed.size === 0) return [];

    const collateralEntries = Array.from(dedupedCollateral.entries()).sort(
      (a, b) => parseFloat(b[1].balance.usdValue || '0') - parseFloat(a[1].balance.usdValue || '0'),
    );
    const borrowEntries = Array.from(dedupedBorrowed.entries()).sort(
      (a, b) => parseFloat(b[1].balance.usdValue || '0') - parseFloat(a[1].balance.usdValue || '0'),
    );

    const collaterals: Position["collaterals"] = collateralEntries.map(([, entry]) => ({
      assetData: { asset: entry.token, amount: formatTokenAmount(parseFloat(entry.balance.amount || '0')) },
      percentage: 0,
      usdValue: parseFloat(entry.balance.usdValue || '0'),
    }));
    const totalCollateralUsd = collaterals.reduce((sum, c) => sum + c.usdValue, 0);
    collaterals.forEach((c) => {
      c.percentage = totalCollateralUsd > 0 ? Math.round((c.usdValue / totalCollateralUsd) * 100) : 0;
    });

    const borrowedArray: Position["borrowed"] = borrowEntries.map(([, entry]) => ({
      assetData: { asset: entry.token, amount: formatTokenAmount(parseFloat(entry.balance.amount || '0')) },
      percentage: 0,
      usdValue: parseFloat(entry.balance.usdValue || '0'),
    }));
    const totalBorrowUsd = borrowedArray.reduce((sum, b) => sum + b.usdValue, 0);
    borrowedArray.forEach((b) => {
      b.percentage = totalBorrowUsd > 0 ? Math.round((b.usdValue / totalBorrowUsd) * 100) : 0;
    });

    const equityUsd = totalCollateralUsd > BORROW_DUST_USD ? totalCollateralUsd : netAvailableCollateral;
    const leverage = equityUsd > BORROW_DUST_USD
      ? parseFloat((1 + totalBorrowUsd / equityUsd).toFixed(2))
      : (totalBorrowUsd > 0 ? 0 : 1);

    // Interest accrued across every borrow. Only counted when we've actually
    // seen borrow/repay history for that token — a missing history entry
    // means "principal unknown", not "principal is 0". The latter would
    // misreport the entire outstanding debt as accrued interest for any loan
    // opened before Mercury indexed this account (e.g. via a raw/CLI
    // transaction with no matching event) — the same failure mode fixed on
    // the Earn page's Net Earnings.
    let interestAccruedUsd = 0;
    if (!historyInitialLoading) {
      for (const [canonical, entry] of borrowEntries) {
        if (!Object.prototype.hasOwnProperty.call(netPrincipalByToken, canonical)) continue;
        const currentAmt = parseFloat(entry.balance.amount || '0');
        const principalAmt = Math.max(0, netPrincipalByToken[canonical]);
        const diff = currentAmt - principalAmt;
        if (diff > 0) {
          const price = tokenPrices[canonical] ?? 1;
          interestAccruedUsd += diff * price;
        }
      }
    }

    return [{
      positionId: 1,
      collaterals,
      borrowed: borrowedArray,
      leverage,
      interestAccrued: parseFloat(interestAccruedUsd.toFixed(4)),
      isOpen: true,
      user: "",
    }];
  }, [
    borrowedBalances,
    collateralBalances,
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
    item: { type: 'deposit' | 'withdraw' | 'borrow' | 'repay'; asset: string; amount: string; timestamp: number; hash: string },
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
          : item.type === 'withdraw'
              ? { className: 'bg-amber-100 text-amber-700', label: 'Withdraw' }
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

        {/* Asset — normalize so long-form / variant symbols (e.g. AQUARIUS_USDC,
            BLEND_USDC) resolve to the right icon instead of the eth-icon fallback,
            matching the Current Positions table. */}
        <div className="w-full flex items-center gap-[8px] py-[16px] px-[12px]">
          {item.asset && (
            <Image
              src={getTokenIcon(canonicalToken(item.asset))}
              alt={item.asset}
              width={20}
              height={20}
              className="rounded-[10px] shrink-0"
            />
          )}
          <span className={`text-[13px] font-medium ${isDark ? "text-white" : ""}`}>
            {item.asset ? canonicalToken(item.asset) : '—'}
          </span>
        </div>

        {/* Amount */}
        <div className={`w-full flex items-center py-[16px] px-[12px] text-[13px] font-medium ${isDark ? "text-white" : ""}`}>
          {formatTokenAmount(parseFloat(String(item.amount ?? '0')) || 0)}
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
      {/* Collateral column — every deposited asset, same stacking as Borrowed */}
      <div className="w-full flex flex-col gap-[6px] py-[16px] px-[12px]">
        {item.collaterals.length > 0 ? (
          item.collaterals.map((collateralItem, collateralIdx) => (
            <motion.div
              key={collateralIdx}
              className="flex gap-[8px] items-center"
              initial={{ opacity: 0, x: -10 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.3, delay: idx * 0.08 + collateralIdx * 0.05 + 0.1 }}
            >
              <Image
                src={getTokenIcon(collateralItem.assetData.asset)}
                alt={collateralItem.assetData.asset}
                width={20}
                height={20}
                className="rounded-[10px] shrink-0"
              />
              <div className="flex flex-col gap-[1px]">
                <div className={`text-[13px] font-medium leading-tight ${isDark ? "text-white" : ""}`}>
                  {collateralItem.assetData.amount} {formatTokenName(collateralItem.assetData.asset)}
                </div>
                <div className={`text-[11px] font-medium ${isDark ? "text-[#919191]" : "text-[#76737B]"}`}>
                  {formatUsdValue(collateralItem.usdValue)}
                </div>
              </div>
            </motion.div>
          ))
        ) : (
          <PortfolioCollateralCell isDark={isDark} />
        )}
      </div>

      {/* Borrowed assets column */}
      <div
        className={`w-full py-[16px] px-[12px] ${
          item.borrowed.length > 0
            ? "flex flex-col gap-[6px]"
            : "flex items-center"
        }`}
      >
        {item.borrowed.filter((b) => b.usdValue >= 0.01).length > 0 ? (
          item.borrowed.filter((b) => b.usdValue >= 0.01).map((borrowedItem, borrowedIdx) => (
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
                  {formatUsdValue(borrowedItem.usdValue)}
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
        {/* Real accrued interest: current on-chain debt for this position's
            borrows minus their reconstructed principal (Σ borrow − Σ repay
            from real Mercury-indexed history), computed in the `positions`
            memo above. */}
        <span className={isDark ? "text-white" : ""}>
          {formatInterestUsd(item.interestAccrued)}
        </span>
      </motion.div>

      {/* Action column — one Repay button PER borrowed asset (not just the
          first), so a row with e.g. BLUSDC + AQUSDC + SOUSDC debt gets three
          buttons, each opening the Repay tab prefilled for that specific
          asset. Stacked with the same gap as the Borrowed Assets column so
          each button lines up with its row. */}
      <motion.div
        className="flex flex-col justify-center gap-[6px] w-full py-[16px] px-[12px]"
        initial={{ opacity: 0, scale: 0.9 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.3, delay: idx * 0.08 + 0.3 }}
      >
        {(() => {
          // Same dust filter as the Borrowed Assets column so the buttons line up 1:1.
          const repayable = item.borrowed.filter((b) => b.usdValue >= 0.01);
          if (repayable.length === 0) {
            return (
              <div className="w-fit">
                <Button size="small" type="gradient" disabled text="Repay" onClick={() => {}} />
              </div>
            );
          }
          return repayable.map((b) => (
            <div className="w-fit" key={b.assetData.asset}>
              <Button
                size="small"
                type="gradient"
                disabled={false}
                text="Repay"
                onClick={() => onRepayClick?.(b.assetData.asset)}
              />
            </div>
          ));
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
            {item.collaterals.length > 0 ? (
              <div className="flex flex-col gap-1">
                {item.collaterals.map((collateralItem, collateralIdx) => (
                  <div key={collateralIdx} className="flex gap-1.5 items-center">
                    <Image
                      src={getTokenIcon(collateralItem.assetData.asset)}
                      alt={collateralItem.assetData.asset}
                      width={16}
                      height={16}
                      className="rounded-full shrink-0"
                    />
                    <div>
                      <div className={`text-[12px] font-medium leading-tight ${isDark ? "text-white" : ""}`}>
                        {collateralItem.assetData.amount} {formatTokenName(collateralItem.assetData.asset)}
                      </div>
                      <div className={`text-[10px] ${isDark ? "text-[#919191]" : "text-[#76737B]"}`}>
                        {formatUsdValue(collateralItem.usdValue)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex gap-1.5 items-center">
                <PortfolioCollateralCell isDark={isDark} compact />
              </div>
            )}
          </div>
          <div>
            <p className={`${lbl} mb-1`}>Borrowed Assets</p>
            {hasBorrow && item.borrowed.filter((b) => b.usdValue >= 0.01).length > 0 ? (
              <div className="flex flex-col gap-1">
                {item.borrowed.filter((b) => b.usdValue >= 0.01).map((borrowedItem, borrowedIdx) => (
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
                          {formatUsdValue(borrowedItem.usdValue)}
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
            <p className={val}>{formatInterestUsd(item.interestAccrued)}</p>
          </div>
        </div>

        {/* Action — one Repay button per borrowed asset, same as desktop */}
        <div className="flex flex-wrap justify-end gap-2">
          {(() => {
            const repayable = item.borrowed.filter((b) => b.usdValue >= 0.01);
            if (repayable.length === 0) {
              return <Button size="small" type="gradient" disabled text="Repay" onClick={() => {}} />;
            }
            return repayable.map((b) => (
              <Button
                key={b.assetData.asset}
                size="small"
                type="gradient"
                disabled={false}
                text={`Repay ${formatTokenName(b.assetData.asset)}`}
                onClick={() => onRepayClick?.(b.assetData.asset)}
              />
            ));
          })()}
        </div>
      </motion.div>
    );
  };

  // ── MOBILE HISTORY CARD ──
  const renderMobileHistoryCard = (
    item: { type: 'deposit' | 'withdraw' | 'borrow' | 'repay'; asset: string; amount: string; timestamp: number; hash: string },
    idx: number,
  ) => {
    const date = item.timestamp
      ? new Date(item.timestamp).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
      : '—';
    const badgeConfig =
      item.type === 'borrow'
        ? { className: 'bg-red-100 text-red-600', label: 'Borrow' }
        : item.type === 'repay'
          ? { className: 'bg-green-100 text-green-600', label: 'Repay' }
          : item.type === 'withdraw'
              ? { className: 'bg-amber-100 text-amber-700', label: 'Withdraw' }
              : { className: 'bg-blue-100 text-blue-600', label: 'Deposit' };
    const shortHash = item.hash ? `${item.hash.slice(0, 8)}...${item.hash.slice(-4)}` : '—';
    return (
      <div
        key={`mobile-history-${idx}`}
        className={`rounded-lg border p-3 flex items-center gap-3 ${isDark ? "border-[#333333] bg-[#2A2A2A]" : "border-[#E2E2E2] bg-white"}`}
      >
        {item.asset && (
          <Image
            src={getTokenIcon(canonicalToken(item.asset))}
            alt={item.asset}
            width={24}
            height={24}
            className="rounded-full shrink-0"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`rounded-[4px] py-[2px] px-[8px] text-[10px] font-semibold ${badgeConfig.className}`}>{badgeConfig.label}</span>
            <span className={`text-[13px] font-semibold ${isDark ? "text-white" : "text-[#111]"}`}>
              {formatTokenAmount(parseFloat(String(item.amount ?? '0')) || 0)} {item.asset ? canonicalToken(item.asset) : ''}
            </span>
          </div>
          <span className={`text-[11px] font-medium ${isDark ? "text-[#919191]" : "text-[#76737B]"}`}>{date}</span>
        </div>
        {item.hash ? (
          <a
            href={`https://stellar.expert/explorer/testnet/tx/${item.hash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[12px] font-medium text-[#703AE6] hover:underline shrink-0"
          >
            {shortHash}
          </a>
        ) : (
          <span className={`text-[12px] shrink-0 ${isDark ? "text-[#666666]" : "text-[#A0A0A0]"}`}>—</span>
        )}
      </div>
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
          <>
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

          {/* Mobile / tablet cards — a wide history table scrolls awkwardly on
              narrow screens, so mirror Current Positions with a card list. */}
          <div className={`xl:hidden p-2 rounded-lg border flex flex-col gap-2 ${isDark ? "border-[#333333] bg-[#222222]" : "border-[#E2E2E2] bg-[#F7F7F7]"}`}>
            {paginatedHistory.map((item, idx) => renderMobileHistoryCard(item, idx))}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-4 py-3">
                <button type="button" onClick={handlePreviousPage} disabled={currentPage === 1} className={`flex items-center justify-center w-8 h-8 transition-colors ${currentPage === 1 ? "cursor-not-allowed opacity-30" : "cursor-pointer hover:opacity-70"} ${isDark ? "text-white" : "text-[#111111]"}`} aria-label="Previous page">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M7.5 9L4.5 6L7.5 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
                <span className="px-5 py-1.5 rounded-full bg-[#F1EBFD] text-[#703AE6] text-[13px] font-semibold">{currentPage} of {totalPages}</span>
                <button type="button" onClick={handleNextPage} disabled={currentPage === totalPages} className={`flex items-center justify-center w-8 h-8 transition-colors ${currentPage === totalPages ? "cursor-not-allowed opacity-30" : "cursor-pointer hover:opacity-70"} ${isDark ? "text-white" : "text-[#111111]"}`} aria-label="Next page">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 9L7.5 6L4.5 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
            )}
          </div>
          </>
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
