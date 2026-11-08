"use client";

/**
 * "Repay Loan" tab (V3 design). Shows the true on-chain debt of the chosen asset ("Net Outstanding
 * Amount to Repay") next to the margin account's own balance of that asset ("Available Balance"),
 * both in token units with a live USD line, a form with quick-% chips, the before → after preview
 * and Pay Now.
 *
 * Same rules and calls as the previous Stellar Repay tab (repay-loan-tab.tsx):
 *
 * - Repay pulls ONLY from the margin account's own balance of the asset (AccountManager `repay`,
 *   no wallet top-up) — so there is no WB / MB source switch here. When the account holds less than
 *   the amount, the tab says so and offers the Transfer tab to move more of the asset in first.
 * - Every chip (10/25/50/100%) is a fraction of the TRUE debt, capped to the margin balance;
 *   sub-cent dust is zeroed.
 * - Submission re-reads debt and balance fresh, caps to both, and for 100% sends the live debt plus
 *   a 1% (min 0.01 token) buffer — capped to the balance — so interest accrued between read and
 *   confirmation doesn't leave a sliver of debt; the contract clamps to the real debt. The progress
 *   step shows the debt, never the padded figure.
 * - After success the store is re-read up to 3 times until it reflects the lower debt.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Info } from "@/components/v3/ui";
import { Icon } from "@/components/v3/icons";
import { hfFmt, usd } from "@/components/v3/format";
import { DropdownOptions } from "@/lib/constants";
import { MarginAccountService } from "@/lib/margin-utils";
import { formatTokenAmount, formatUsdValue } from "@/lib/utils/format-amount";
import { decimalAmountToWad, validateAmountChange, AMOUNT_MAX_DECIMALS } from "@/lib/utils/sanitize-amount";
import { normalizeRepayError } from "@/lib/errors/normalize";
import { buildNetBorrowCashByToken, calculateAccruedBorrowInterest, canonicalMarginPositionToken } from "@/lib/margin-position-attribution";
import { useMarginHistory } from "@/hooks/use-margin";
import { useMutationToast } from "@/hooks/use-mutation-toast";
import { refreshBorrowedBalances as refreshMarginStoreBorrowedBalances, useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { accountNumbers, liqBuffer, noDebt, withRepay } from "./mg-sim";
import { PctChips, PrevBox, PrevRow, RatioBtn, TIPS, TokenDropdown, toneHf, usePop } from "./mg-ui";
import { ckey, type MarginScreen } from "./use-margin-screen";

/** Format a numeric amount for the editable input: clean string, no trailing
 *  zeros, capped at Stellar's 7-decimal precision; empty for non-positive. */
const amountToInputString = (n: number): string => (Number.isFinite(n) && n > 0 ? String(parseFloat(n.toFixed(AMOUNT_MAX_DECIMALS))) : "");

const REPAY_DUST_EPSILON = 1e-6;
const formatDetailedTokenAmount = (value: number): string =>
  Number.isFinite(value) ? value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 7 }) : "0";

/** Positions-row / Portfolio `?repay=` symbol → the dropdown's symbol. */
export const toDropdownAsset = (raw: string | undefined): string | null => {
  if (!raw) return null;
  const cleaned = raw.replace(/^0x/i, "").toUpperCase();
  if (cleaned === "XLM") return "XLM";
  if (cleaned === "USDC" || cleaned === "BLUSDC" || cleaned === "BLEND_USDC") return "BLUSDC";
  if (cleaned === "AQUSDC" || cleaned === "AQUIRESUSDC" || cleaned === "AQUARIUS_USDC") return "AqUSDC";
  if (cleaned === "SOUSDC" || cleaned === "SOROSWAPUSDC" || cleaned === "SOROSWAP_USDC") return "SoUSDC";
  return null;
};

const normalizeContractTokenSymbol = (symbol: string): string =>
  symbol === "BLUSDC" || symbol === "BLEND_USDC" || symbol === "USDC"
    ? "BLUSDC"
    : symbol === "AqUSDC" || symbol === "AquiresUSDC" || symbol === "AQUARIUS_USDC"
      ? "AQUSDC"
      : symbol === "SoUSDC" || symbol === "SoroswapUSDC" || symbol === "SOROSWAP_USDC"
        ? "SOUSDC"
        : symbol;

const clampRepayDust = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.abs(value) < REPAY_DUST_EPSILON ? 0 : value;
};

export function RepayTab({ m, prefill, onTransfer }: { m: MarginScreen; prefill?: { sym: string; n: number }; onTransfer: () => void }) {
  const pop = usePop();
  const qc = useQueryClient();
  const marginAccount = m.marginAddress ?? "";
  const [sym, setSym] = useState<string>(() => toDropdownAsset(prefill?.sym) ?? DropdownOptions[0]);
  const [pct, setPct] = useState(0);
  // The amount field is held as a RAW STRING while editing — converting to a Number on each
  // keystroke turned a partial "." into NaN and dropped trailing decimals.
  const [input, setInput] = useState("");
  const amt = parseFloat(input) || 0;
  const [stats, setStats] = useState({ debt: 0, available: 0 });
  const [currentDebtWad, setCurrentDebtWad] = useState<string>("0");
  // Raw WAD twin of `stats.available` — the display figure loses precision to a JS float, so the
  // submission caps against this when it needs an exact on-chain amount.
  const [currentAvailableBalanceWad, setCurrentAvailableBalanceWad] = useState<string>("0");

  // A positions-row Repay click / Portfolio's ?repay= hand-off preselects that asset.
  useEffect(() => {
    const s = toDropdownAsset(prefill?.sym);
    if (s) {
      setSym(s);
      setInput("");
      setPct(0);
    }
  }, [prefill?.sym, prefill?.n]);

  // Reset on wallet disconnect so the previous user's figures don't linger.
  useEffect(() => {
    if (!m.address) {
      setStats({ debt: 0, available: 0 });
      setInput("");
      setPct(0);
      setCurrentDebtWad("0");
      setCurrentAvailableBalanceWad("0");
    }
  }, [m.address]);

  // Live oracle price; BLUSDC/AQUSDC/SOUSDC alias to USDC inside the oracle module.
  const price = m.prices[ckey(sym)] ?? 1;

  // Debt and margin-account balance for the CURRENT asset, fetched together so the tiles never mix
  // a fresh debt read with a stale balance. The debt is always the TRUE full debt.
  const refreshRepayableStats = useCallback(
    async (marginAccountAddress: string) => {
      try {
        const normalizedSymbol = normalizeContractTokenSymbol(sym);
        const [debtResult, marginBalWad] = await Promise.all([
          MarginAccountService.getBorrowedTokenDebtWad(marginAccountAddress, normalizedSymbol),
          MarginAccountService.getMarginAccountTokenBalanceWad(marginAccountAddress, normalizedSymbol),
        ]);
        const trueDebtTokens = debtResult.success && debtResult.debtWad ? clampRepayDust(parseFloat(debtResult.amount || "0") || 0) : 0;
        setCurrentDebtWad(debtResult.success && debtResult.debtWad ? debtResult.debtWad : "0");
        setCurrentAvailableBalanceWad(marginBalWad ?? "0");
        setStats({ debt: trueDebtTokens, available: marginBalWad != null ? clampRepayDust(parseFloat(marginBalWad) / 1e18) : 0 });
      } catch (error) {
        console.error("Error refreshing repayable stats:", error);
      }
    },
    [sym],
  );

  // Refresh when the asset / account changes, and whenever the store's debt for it moves (a borrow
  // or repay elsewhere on the page).
  const storeDebt = m.borrowedBalances[ckey(sym)]?.amount;
  useEffect(() => {
    if (marginAccount) void refreshRepayableStats(marginAccount);
  }, [marginAccount, refreshRepayableStats, storeDebt]);

  // Interest accrued since this debt opened, from Mercury + RPC margin events (null = unknown).
  const { history, isLoading: historyLoading } = useMarginHistory();
  const accrued = useMemo(() => {
    if (historyLoading) return null;
    const netBorrowCash = buildNetBorrowCashByToken(history);
    return calculateAccruedBorrowInterest(stats.debt, netBorrowCash.get(canonicalMarginPositionToken(sym)));
  }, [history, historyLoading, stats.debt, sym]);

  // Both tiles in tokens of the selected asset, with a live USD line; sub-cent USD reads as 0.
  const statDisplay = (value: number) => {
    const cleaned = clampRepayDust(value);
    const usdEquiv = price > 0 ? cleaned * price : 0;
    return usdEquiv > 0 && usdEquiv < 0.01 ? 0 : cleaned;
  };

  const debtTip =
    accrued !== null
      ? `Net borrowed amount: ${formatDetailedTokenAmount(Math.max(0, stats.debt - accrued))} ${sym}. Interest accrued till date: ${formatDetailedTokenAmount(accrued)} ${sym} (≈ ${formatUsdValue(accrued * price)}). Total outstanding loan: ${formatDetailedTokenAmount(stats.debt)} ${sym}.`
      : `Total outstanding loan: ${formatDetailedTokenAmount(stats.debt)} ${sym}. Principal and interest breakdown is unavailable until the original on-chain borrow is indexed.`;

  // Every chip is a fraction of the TRUE debt, capped to the margin account's own balance (it only
  // ever repays from that balance). Below-a-cent dust is zeroed.
  const pick = (p: number) => {
    setPct(p);
    const target = Math.min((stats.debt * p) / 100, stats.available);
    const usdEquiv = price > 0 ? target * price : target;
    setInput(amountToInputString(usdEquiv < 0.01 ? 0 : clampRepayDust(target)));
  };

  const mutation = useMutation({
    // No optimistic write: the position must reflect ONLY confirmed on-chain state.
    mutationFn: async () => {
      if (!marginAccount || amt <= 0) throw new Error("Please enter a valid repay amount");
      try {
        const normalizedSymbol = normalizeContractTokenSymbol(sym);
        const [latestDebt, freshMarginBalWad] = await Promise.all([
          MarginAccountService.getBorrowedTokenDebtWad(marginAccount, normalizedSymbol),
          MarginAccountService.getMarginAccountTokenBalanceWad(marginAccount, normalizedSymbol),
        ]);
        const inputRepayWad = decimalAmountToWad(input);
        const debtWad = latestDebt.success && latestDebt.debtWad ? BigInt(latestDebt.debtWad) : currentDebtWad && currentDebtWad !== "0" ? BigInt(currentDebtWad) : BigInt(0);
        const marginBalWad =
          freshMarginBalWad != null ? BigInt(freshMarginBalWad) : currentAvailableBalanceWad && currentAvailableBalanceWad !== "0" ? BigInt(currentAvailableBalanceWad) : BigInt(0);
        // Every submission is capped to BOTH the real debt (never overpay) AND the margin
        // account's own live balance (no wallet top-up).
        const cappedToDebt = debtWad > BigInt(0) ? (inputRepayWad > debtWad ? debtWad : inputRepayWad) : inputRepayWad;
        // 100%: debt accrues every second, so any exact amount read here is stale by the time the
        // tx lands. The contract clamps whatever is sent to the real debt, so send the live debt
        // plus a 1% buffer (floored at 0.01 token) — close enough to the real debt that the
        // wallet's own confirmation doesn't show a confusing figure.
        const REPAY_BUFFER_BPS = BigInt(100); // 1%
        const REPAY_BUFFER_FLOOR_WAD = BigInt("10000000000000000"); // 0.01 token
        const bufferedDebtWad =
          debtWad > BigInt(0)
            ? debtWad +
              (() => {
                const proportional = (debtWad * REPAY_BUFFER_BPS) / BigInt(10_000);
                return proportional > REPAY_BUFFER_FLOOR_WAD ? proportional : REPAY_BUFFER_FLOOR_WAD;
              })()
            : debtWad;
        const finalRepayWad =
          pct === 100 && debtWad > BigInt(0) && marginBalWad > BigInt(0)
            ? bufferedDebtWad > marginBalWad
              ? marginBalWad
              : bufferedDebtWad
            : cappedToDebt > marginBalWad
              ? marginBalWad
              : cappedToDebt;
        if (finalRepayWad <= BigInt(0)) throw new Error("Nothing to repay for this token");

        // The progress step reads as "repaying the debt", never the padded on-chain amount.
        const displayAmountOverride = pct === 100 && debtWad > BigInt(0) ? (Number(debtWad) / 1e18).toFixed(7) : input || undefined;
        const result = await MarginAccountService.repayLoan(marginAccount, normalizeContractTokenSymbol(sym), finalRepayWad.toString(), displayAmountOverride);
        if (!result.success) {
          console.error("🔴 REPAY FAILED — raw result:", result);
          throw new Error(result.error || 'Loan repayment failed (no further detail returned — see "🔴 REPAY FAILED" above in console)');
        }
        const repaidWad = result.repaidAmountWad ? BigInt(result.repaidAmountWad) : finalRepayWad;
        return { hash: result.hash, repaidWad };
      } catch (error: unknown) {
        // Catches anything that escapes repayLoan's own try/catch and rethrows with a message
        // guaranteed to be non-empty, so the error is never a bare, contentless fallback.
        console.error("🔴 REPAY THREW — raw error:", error);
        const detail =
          error instanceof Error && error.message
            ? error.message
            : (() => {
                try {
                  return JSON.stringify(error);
                } catch {
                  return String(error);
                }
              })();
        throw new Error(detail || 'Repay threw with no message — see "🔴 REPAY THREW" in console.');
      }
    },
    onSuccess: async () => {
      setInput("");
      setPct(0);
      qc.invalidateQueries({ queryKey: ["margin"] });
      const preRepayDebtWad = currentDebtWad && currentDebtWad !== "0" ? BigInt(currentDebtWad) : BigInt(0);
      const key = normalizeContractTokenSymbol(sym);
      // A read right after confirmation can land on an RPC node that hasn't ingested that ledger
      // yet — retry a couple of times, a beat apart, until the store reflects the drop.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await refreshRepayableStats(marginAccount);
          await refreshMarginStoreBorrowedBalances(marginAccount, true);
        } catch (error) {
          console.warn("Post-repay balance refresh failed; ledger tick will reconcile.", error);
          break;
        }
        const storeDebtWad = decimalAmountToWad(useMarginAccountInfoStore.getState().borrowedBalances[key]?.amount ?? "0");
        if (storeDebtWad < preRepayDebtWad) break; // confirmed drop — done
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
      }
    },
  });

  useMutationToast(mutation, {
    loading: `Repaying ${formatTokenAmount(amt)} ${sym}`,
    success: () => `Loan repayment successful!`,
    error: (e) => normalizeRepayError(e.message, sym),
  });

  // Repay is margin-balance-based only — an amount above what's in the margin account can never
  // succeed on-chain, so surface that up front. Small epsilon avoids flagging a 100% preset.
  const exceeds = amt > 0 && amt > stats.available + 1e-7;

  // Preview (repaid from the margin account) — never for a repay that cannot happen.
  const b = m.now;
  const full = pct === 100 && stats.available + 1e-9 >= stats.debt && stats.debt > 0;
  const x = full ? stats.debt : Math.min(amt, stats.debt);
  const a = accountNumbers(withRepay(m.model, { symbol: ckey(sym), usd: x * price }, "margin"));
  const showPrev = m.connected && amt > 0 && b.debt > 0 && stats.debt > 0 && !exceeds;

  const tile = (k: string, tip: string, v: number) => {
    const d = statDisplay(v);
    return (
      <article className="mg-tile">
        <span className="mg-tk">
          {k} <Info text={tip} />
        </span>
        <span className="mg-tv num">
          <Icon sym={sym} className="ico mg-tvi" />
          {formatTokenAmount(d)} {sym}
        </span>
        {price > 0 && <span className="mg-sub num">≈ {formatUsdValue(d * price)}</span>}
      </article>
    );
  };

  return (
    <div className="mg-rep">
      <div className="mg-rep-in">
        <section className="mg-tiles">
          {tile("Net Outstanding Amount to Repay", debtTip, stats.debt)}
          {tile("Available Balance in Margin Account", TIPS.avail, stats.available)}
        </section>
        <article className="mg-cc">
          <div className="mg-r">
            <span className="mg-lbl">Repay</span>
            <PctChips value={pct} label="Repay percentage" onPick={pick} />
          </div>
          <div className="mg-r">
            <TokenDropdown
              id="rep"
              sym={sym}
              list={DropdownOptions}
              pop={pop}
              onPick={(s) => {
                setSym(s);
                setInput("");
                setPct(0);
              }}
            />
            <input
              className="mg-amt num"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={input}
              aria-label="Repay amount"
              onChange={(e) => {
                const v = validateAmountChange(e.target.value);
                if (v === null) return;
                // A chip only fills the field; once edited, the typed amount is authoritative.
                setPct(0);
                setInput(v);
              }}
            />
          </div>
          <div className="mg-r">
            <RatioBtn sym={sym} price={price} />
            <span className="mg-usdr num" aria-live="polite">
              ≈ {formatUsdValue(amt * price)}
            </span>
          </div>
          <div className="mg-r start">
            <span className="mg-sub mg-inl">
              Repay From: <b>Margin Account</b>
              <Info text="Repays from your margin account's own balance of this asset (no wallet top-up). To repay from your wallet, first move the asset in with Transfer → MB." />
            </span>
          </div>
        </article>

        {exceeds && (
          <div className="mg-am" role="status">
            <span>
              Your margin account holds {formatTokenAmount(stats.available)} {sym}, less than this repay. Move more {sym} into the margin account first.
            </span>
            <span className="mg-am-a">
              <button type="button" onClick={onTransfer}>
                Transfer from wallet
              </button>
            </span>
          </div>
        )}

        {showPrev && (
          <PrevBox flush>
            <PrevRow label="Outstanding Debt" b={usd(b.debt)} a={usd(a.debt)} tone="up" />
            <PrevRow label="Margin Collateral" b={usd(b.holdings)} a={usd(a.holdings)} tone="dn" tip={TIPS.value} />
            <PrevRow label="Health Factor" b={hfFmt(b.hf)} a={hfFmt(a.hf)} tone={toneHf(b.hf, a.hf)} tip={TIPS.hf} />
            <PrevRow
              label="Liquidation Buffer"
              b={usd(liqBuffer(b))}
              a={noDebt(a) ? "N/A, no debt" : usd(liqBuffer(a))}
              tone={noDebt(a) || liqBuffer(a) >= liqBuffer(b) ? "up" : "dn"}
              tip={TIPS.buffer}
            />
          </PrevBox>
        )}

        <section>
          <button type="button" className="mg-btn" disabled={!(amt > 0) || mutation.isPending || !marginAccount || exceeds} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "Processing..." : exceeds ? "Insufficient Balance" : "Pay Now"}
          </button>
        </section>
      </div>
    </div>
  );
}
