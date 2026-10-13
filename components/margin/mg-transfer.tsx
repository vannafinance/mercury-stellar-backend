"use client";

/**
 * "Transfer Collateral" tab (V3 design): move a token between the wallet and the margin account.
 * MB = wallet → margin (`deposit_collateral_tokens`), WB = margin → wallet
 * (`withdraw_collateral_balance`, health-checked on-chain by the RiskEngine).
 *
 * Same caps and checks as the previous Stellar Transfer tab (transfer-collateral.tsx):
 * - the source balance — the wallet's native XLM keeps its real on-chain minimum reserve
 *   ((2 + subentries) × 0.5 XLM + fee buffer), contract-held tokens have no reserve;
 * - for a withdrawal, the RiskEngine-safe limit `maxMarginWithdrawal` from the store's health
 *   factor and dust-floored debt (so a withdrawal can't reach the 1.10 liquidation line), with
 *   Max / % presets that keep all seven token decimals (`marginWithdrawalPreset`);
 * - a withdrawal whose projected health factor is at or below 1.10 is blocked.
 * A failed transaction keeps the entered amount; balances refresh after confirmation.
 */
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info } from "@/components/v3/ui";
import { Icon, IC } from "@/components/v3/icons";
import { hfFmt, nf, usd } from "@/components/v3/format";
import { LIQ_HF, WARN_HF } from "@/lib/account-model";
import { DropdownOptions } from "@/lib/constants";
import { MarginAccountService } from "@/lib/margin-utils";
import { ContractService } from "@/lib/stellar-utils";
import { showTxStep, showTxSuccess, showTxError } from "@/lib/tx-progress";
import { normalizeTransferCollateralError } from "@/lib/errors/normalize";
import { validateAmountChange, floorAmountToInput, decimalAmountToWad } from "@/lib/utils/sanitize-amount";
import { maxMarginWithdrawal, marginWithdrawalPreset } from "@/lib/utils/margin-withdraw";
import { getXlmMinReserve, maxSpendableXlm } from "@/lib/xlm-reserve";
import { USD_DUST_EPSILON } from "@/lib/account-snapshot";
import { useWallet } from "@/hooks/use-wallet";
import { useMarginAccountInfoStore, refreshBorrowedBalances } from "@/store/margin-account-info-store";
import { accountNumbers, liqBuffer, noDebt, withDeposits, withWithdraw } from "./mg-sim";
import { PctChips, PrevBox, PrevRow, RatioBtn, TIPS, TokenDropdown, toneHf, usePop } from "./mg-ui";
import { ckey, type MarginScreen } from "./use-margin-screen";

const XLM_TRANSFER_EPSILON = 1e-7;

/** Contract collateral symbol (Blend USDC goes on-chain as `USDC`), as the previous tab sent it. */
const normalizeContractTokenSymbol = (symbol: string) =>
  symbol === "BLUSDC" || symbol === "BLEND_USDC" || symbol === "USDC"
    ? "USDC"
    : symbol === "AqUSDC" || symbol === "AquiresUSDC" || symbol === "AQUARIUS_USDC"
      ? "AQUSDC"
      : symbol === "SoUSDC" || symbol === "SoroswapUSDC" || symbol === "SOROSWAP_USDC"
        ? "SOUSDC"
        : symbol;

export function TransferTab({ m }: { m: MarginScreen }) {
  const pop = usePop();
  const qc = useQueryClient();
  const { refreshBalances } = useWallet();
  const userAddress = m.address ?? "";
  const marginAccount = m.marginAddress ?? "";
  const [sym, setSym] = useState<string>("XLM");
  const [dir, setDir] = useState<"MB" | "WB">("MB");
  const [input, setInput] = useState("");
  const [pct, setPct] = useState(0);
  const [xlmMinReserve, setXlmMinReserve] = useState(1.5);

  // The store's RiskEngine-aligned health factor and debt — the pair `maxMarginWithdrawal` needs.
  const totalBorrowedValue = useMarginAccountInfoStore((s) => s.totalBorrowedValue);
  const avgHealthFactor = useMarginAccountInfoStore((s) => s.avgHealthFactor);
  // Same dust floor `avgHealthFactor` is computed against (USD_DUST_EPSILON): a sub-cent residual
  // debt reads as no debt, so the withdrawal cap isn't collapsed by an HF / debt mismatch.
  const hasMeaningfulDebt = totalBorrowedValue > USD_DUST_EPSILON;

  // Reset on wallet disconnect / switch so the previous wallet's figures don't linger (adjusted
  // during render, React's recommended alternative to a resetting effect).
  const [seenAddress, setSeenAddress] = useState(m.address);
  if (seenAddress !== m.address) {
    setSeenAddress(m.address);
    setInput("");
    setPct(0);
  }

  useEffect(() => {
    if (!userAddress) return;
    let cancelled = false;
    getXlmMinReserve(userAddress).then((r) => {
      if (!cancelled) setXlmMinReserve(r);
    });
    return () => {
      cancelled = true;
    };
  }, [userAddress]);

  /**
   * Fresh wallet balance of the selected token (on-chain read, not the cached store copy). Nested
   * under `['margin']`, so every margin mutation's invalidation re-reads it.
   */
  const walletQuery = useQuery({
    queryKey: ["margin", "transfer-wallet-balance", userAddress, sym],
    enabled: Boolean(userAddress),
    queryFn: async (): Promise<number> => {
      try {
        const balances = await ContractService.getAllTokenBalances(userAddress);
        const c = normalizeContractTokenSymbol(sym);
        return c === "USDC"
          ? parseFloat(balances.BLEND_USDC) || 0
          : c === "AQUSDC"
            ? parseFloat(balances.AQUARIUS_USDC) || 0
            : c === "SOUSDC"
              ? parseFloat(balances.SOROSWAP_USDC) || 0
              : parseFloat(balances.XLM) || 0;
      } catch (error) {
        console.error("Error fetching selected wallet balance:", error);
        return 0;
      }
    },
  });
  const walletBalance = userAddress ? (walletQuery.data ?? 0) : 0;

  // Opening the tab force-refreshes the margin balances (as the previous tab did on mount).
  useEffect(() => {
    if (marginAccount) refreshBorrowedBalances(marginAccount, true).catch(console.error);
  }, [marginAccount]);

  const key = ckey(sym);
  const marginBalanceInput = m.collateralBalances[key]?.amount ?? "0";
  const marginAccountBalance = parseFloat(marginBalanceInput) || 0;
  const price = m.prices[key] ?? 1;
  const sourceBalance = dir === "MB" ? walletBalance : marginAccountBalance;
  const maxTransferableBalance = dir === "MB" && key === "XLM" ? maxSpendableXlm(sourceBalance, xlmMinReserve) : Math.max(0, sourceBalance);
  // What gets SHOWN as "your balance" — for a wallet→margin XLM transfer the spendable amount.
  const displayedSourceBalance = dir === "MB" && key === "XLM" ? maxTransferableBalance : sourceBalance;
  const dustFlooredDebt = hasMeaningfulDebt ? totalBorrowedValue : 0;
  const maxExecutableWithdraw = dir === "WB" ? maxMarginWithdrawal(maxTransferableBalance, dustFlooredDebt, avgHealthFactor, price) : maxTransferableBalance;
  const amt = Number(input || 0);
  const isOverSourceBalance = amt > sourceBalance;

  // Projected HF after a WB (withdraw) — blocks Transfer when it would reach 1.10.
  const projectedHfAfterWb = (() => {
    if (dir !== "WB" || !hasMeaningfulDebt) return Infinity;
    if (avgHealthFactor <= 0) return Infinity;
    const grossBefore = avgHealthFactor * totalBorrowedValue;
    return Math.max(0, grossBefore - amt * price) / totalBorrowedValue;
  })();
  const belowLiq = dir === "WB" && amt > 0 && hasMeaningfulDebt && projectedHfAfterWb <= LIQ_HF;
  const warn = dir === "WB" && amt > 0 && hasMeaningfulDebt && !belowLiq && projectedHfAfterWb < WARN_HF;

  const pick = (p: number) => {
    setPct(p);
    setInput(dir === "WB" ? marginWithdrawalPreset(marginBalanceInput, maxExecutableWithdraw, p) : floorAmountToInput((maxTransferableBalance * p) / 100));
  };
  // floorAmountToInput floors to 7dp (never rounds UP past the real max) while keeping full
  // Stellar precision — so Max transfers the whole balance, not a 2dp slice.
  const max = () => setInput(dir === "WB" ? marginWithdrawalPreset(marginBalanceInput, maxExecutableWithdraw) : floorAmountToInput(maxTransferableBalance));
  const clear = () => {
    setInput("");
    setPct(0);
  };

  const mutation = useMutation({
    onMutate: () => {
      showTxStep(`${dir === "MB" ? "Transferring" : "Withdrawing"} ${input || 0} ${sym} ${dir === "MB" ? "to your margin account" : "to your wallet"}`);
    },
    mutationFn: async () => {
      // String-based conversion keeps all 7 Stellar decimals (no stranded dust on Max / 100%).
      const amountWad = decimalAmountToWad(input).toString();
      const result =
        dir === "MB"
          ? await MarginAccountService.depositCollateralTokens(marginAccount, normalizeContractTokenSymbol(sym), amountWad)
          : await MarginAccountService.withdrawCollateralBalance(marginAccount, normalizeContractTokenSymbol(sym), amountWad);
      if (!result.success) throw new Error(result.error || "Transfer failed");
      return result;
    },
    onSuccess: async () => {
      showTxSuccess(dir === "MB" ? "Transfer to margin successful!" : "Transfer to wallet successful!");
      // Reset and invalidate first so the UI updates even if the imperative refresh below throws
      // (the wallet's getAddress can transiently return undefined right after a signed popup).
      setInput("");
      setPct(0);
      qc.invalidateQueries({ queryKey: ["margin"] });
      try {
        await refreshBorrowedBalances(marginAccount, true);
        await walletQuery.refetch();
        if (userAddress) await refreshBalances(userAddress);
      } catch (error) {
        console.warn("Post-transfer balance refresh failed; ledger tick will reconcile.", error);
      }
    },
    onError: (error) => {
      showTxError(normalizeTransferCollateralError(error instanceof Error ? error.message : "Transfer failed", sym));
    },
  });

  const go = () => {
    if (!marginAccount || !input || amt <= 0) return void toast.error("Please enter a valid amount");
    if (amt > sourceBalance) return void toast.error("Insufficient balance for selected transfer mode");
    if (dir === "MB" && key === "XLM" && amt >= sourceBalance - XLM_TRANSFER_EPSILON) {
      return void toast.error("You cannot transfer all your wallet balance. Please keep at least 1 XLM in your wallet.");
    }
    if (amt > maxTransferableBalance + XLM_TRANSFER_EPSILON) {
      return void toast.error("You cannot transfer all your wallet balance. Please keep at least 1 XLM in your wallet.");
    }
    if (dir === "WB" && amt > maxExecutableWithdraw) {
      const safeMaxDisplay = (Math.floor(maxExecutableWithdraw * 100) / 100).toFixed(2);
      toast.error(
        !hasMeaningfulDebt
          ? `Max transferable right now: ${safeMaxDisplay} ${sym}.`
          : maxExecutableWithdraw > 0
            ? `Unsafe withdrawal for current debt/health factor. Max you can transfer now: ${safeMaxDisplay} ${sym}.`
            : "Unsafe withdrawal for current debt/health factor. Repay some debt first.",
      );
      return;
    }
    mutation.mutate();
  };

  // Preview from the account model.
  const x = Math.min(amt, dir === "MB" ? walletBalance : marginAccountBalance) * price;
  const afterState = dir === "MB" ? withDeposits(m.model, [{ symbol: key, usd: x }]) : withWithdraw(m.model, { symbol: key, usd: x });
  const b = m.now;
  const a = accountNumbers(afterState);
  const nd = noDebt(b);

  return (
    <div className="mg-trn">
      <article className="mg-cc">
        <div className="mg-r">
          <span className="mg-lbl">Transfer</span>
          <PctChips value={pct} label="Transfer percentage" onPick={pick} />
        </div>
        <div className="mg-r">
          <TokenDropdown
            id="tr"
            sym={sym}
            list={DropdownOptions}
            pop={pop}
            onPick={(s) => {
              setSym(s);
              clear();
            }}
          />
          <input
            className="mg-amt num"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={input}
            aria-label="Transfer amount"
            onChange={(e) => {
              const v = validateAmountChange(e.target.value);
              if (v === null) return;
              setPct(0);
              setInput(v);
            }}
          />
        </div>
        <div className="mg-r mg-trow">
          <div className="mg-bl">
            <span className="mg-sub">
              Transfer To: <b>{dir === "MB" ? "Margin Account" : "Wallet"}</b>
            </span>
            <button type="button" className="mg-maxc" onClick={max}>
              Max
            </button>
            <RatioBtn sym={sym} price={price} />
          </div>
          <span className="mg-srcb">
            <Icon sym={sym} className="ico mg-sbi" />
            <b className="num">
              {nf(displayedSourceBalance, 2)} {sym}
            </b>
            <span className="mg-usdr num">≈ {nf(displayedSourceBalance * price, 2)} USD</span>
          </span>
        </div>
        <div className="mg-r start">
          <span className="mg-seg lg" role="group" aria-label="Direction">
            {(["WB", "MB"] as const).map((d) => (
              <button
                key={d}
                type="button"
                className={dir === d ? "on" : ""}
                aria-pressed={dir === d}
                aria-label={d === "WB" ? "Transfer to your wallet" : "Transfer to your margin account"}
                onClick={() => {
                  setDir(d);
                  clear();
                }}
              >
                {d}
              </button>
            ))}
          </span>
          <Info text="WB moves the token from your margin account to your wallet; MB moves it from your wallet into your margin account." />
        </div>
      </article>

      {m.connected && amt > 0 && (
        <PrevBox flush>
          <PrevRow label="Margin Collateral" b={usd(b.holdings)} a={usd(a.holdings)} tone={dir === "MB" ? "up" : "dn"} tip={TIPS.value} />
          <PrevRow label="Health Factor" b={hfFmt(b.hf)} a={hfFmt(a.hf)} tone={nd ? "" : toneHf(b.hf, a.hf)} tip={TIPS.hf} />
          <PrevRow
            label="Liquidation Buffer"
            b={nd ? undefined : usd(liqBuffer(b))}
            a={nd ? "N/A, no debt" : usd(liqBuffer(a))}
            tone={nd ? "" : liqBuffer(a) >= liqBuffer(b) ? "up" : "dn"}
            tip={TIPS.buffer}
          />
        </PrevBox>
      )}

      <section>
        {belowLiq ? (
          <div className="mg-rd" role="alert">
            {IC.warn}
            <span>This withdrawal would drop your Health Factor to {hfFmt(projectedHfAfterWb)} (at or below 1.10). Reduce the amount or repay some debt first.</span>
          </div>
        ) : (
          warn && (
            <div className="mg-am mg-wn" role="status">
              <span>
                Health factor after this: {hfFmt(projectedHfAfterWb)}, close to the {nf(LIQ_HF, 2)} liquidation line.
              </span>
            </div>
          )
        )}
        <button type="button" className="mg-btn" disabled={!(amt > 0 && !mutation.isPending && marginAccount && !isOverSourceBalance) || belowLiq} onClick={go}>
          {mutation.isPending ? "Processing..." : "Transfer"}
        </button>
      </section>
    </div>
  );
}
