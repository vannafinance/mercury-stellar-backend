import { formatUsdValue } from "@/lib/utils/format-amount";
import type { PreviewRow } from "@/components/margin/margin-action-preview";

/** Debt below this is treated as "no debt" — matches store + positions table. */
export const BORROW_DUST_USD = 0.01;
export const LIQUIDATION_THRESHOLD = 1.1;
const HF_INF_SENTINEL = 999;

const formatHF = (hf: number): string =>
  !Number.isFinite(hf) || hf >= HF_INF_SENTINEL ? "∞" : hf.toFixed(2);

export interface CollateralPreviewInput {
  totalCollateralValue: number;
  totalBorrowedValue: number;
  avgHealthFactor: number;
  /** USD value of the amount being transferred. */
  transferUsd: number;
  /** true = wallet → margin (collateral grows); false = margin → wallet (collateral shrinks). */
  isInbound: boolean;
}

/**
 * Computes the "before → after" margin collateral / health factor /
 * liquidation buffer preview rows for a collateral transfer. Shared by the
 * margin page's Transfer Collateral tab and the Portfolio page's
 * Deposit/Withdraw modals so the projection math has one source of truth.
 *
 * Health factor is derived from the store's own `avgHealthFactor` (which
 * mirrors the contract RiskEngine) rather than the naive collateral+debt
 * formula — that formula only holds for pure-cash accounts, and understates
 * or overstates HF once a trader has deployed collateral into aTokens, LP
 * positions, or tracking tokens.
 */
export function computeCollateralPreviewRows({
  totalCollateralValue,
  totalBorrowedValue,
  avgHealthFactor,
  transferUsd,
  isInbound,
}: CollateralPreviewInput): PreviewRow[] {
  const collateralAfter = isInbound
    ? totalCollateralValue + transferUsd
    : Math.max(0, totalCollateralValue - transferUsd);

  const hasDebt = totalBorrowedValue > BORROW_DUST_USD;
  const hfBefore = hasDebt && avgHealthFactor > 0 ? avgHealthFactor : HF_INF_SENTINEL;
  // gross_before = avgHF × debt (works regardless of collateral type).
  const grossBefore = hasDebt && avgHealthFactor > 0
    ? avgHealthFactor * totalBorrowedValue
    : totalCollateralValue;
  const grossAfter = isInbound ? grossBefore + transferUsd : Math.max(0, grossBefore - transferUsd);
  const hfAfter = hasDebt ? grossAfter / totalBorrowedValue : HF_INF_SENTINEL;

  const bufferBefore = Math.max(0, grossBefore - totalBorrowedValue * LIQUIDATION_THRESHOLD);
  const bufferAfter = Math.max(0, grossAfter - totalBorrowedValue * LIQUIDATION_THRESHOLD);

  return [
    {
      label: "Margin Collateral",
      before: formatUsdValue(totalCollateralValue),
      after: formatUsdValue(collateralAfter),
      tone: isInbound ? "positive" : "negative",
    },
    {
      label: "Health Factor",
      before: formatHF(hfBefore),
      after: formatHF(hfAfter),
      tone: hfAfter >= hfBefore ? "positive" : "negative",
    },
    {
      label: "Liquidation Buffer",
      before: formatUsdValue(bufferBefore),
      after: formatUsdValue(bufferAfter),
      tone: bufferAfter >= bufferBefore ? "positive" : "negative",
    },
  ];
}
