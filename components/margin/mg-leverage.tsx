"use client";

/**
 * "Leverage your Assets" tab (V3 design): deposit one or more collaterals from the wallet (WB) or
 * size against collateral already in the margin account (MB, single row, borrow-only), borrow one
 * asset or two (dual borrow), pick the leverage, preview the account before → after, submit.
 *
 * Submission is the previous Stellar Leverage tab's flow, unchanged (leverage-assets-tab.tsx):
 *
 *  - No margin account → opens the create-account / sign-agreement dialogues.
 *  - MB → borrow-only against already-deposited collateral (`borrowTokens`, one call per borrow
 *    asset for Dual Borrow).
 *  - WB → deposit + borrow. Single-collateral uses the atomic `deposit_and_borrow(_cross)` contract
 *    call (one signature; Dual Borrow's second asset follows as a separate `borrow`); it falls back
 *    to the split 2-tx flow for multi-collateral or when the atomic call overflows Soroban's per-tx
 *    budget.
 *
 * Borrow size is pre-validated against the on-chain RiskEngine formula before signing
 * ((gross + borrow) / (debt + borrow) > 1.10), XLM deposits respect the wallet's real minimum
 * reserve, and after a confirmed tx the UI is unblocked immediately (progress modal success + form
 * reset + optimistic store merge) while balances refresh in the background.
 *
 * Limits: the selectable leverage is capped at 1 + (RiskEngine borrow limit) / deposit (floored to
 * 2 dp, at most MAX_LEVERAGE = 10x); the displayed slider scale always stays 1x–10x.
 * Max = deposit × (leverage − 1). Borrowed tokens land in the margin account and count as collateral.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Info } from "@/components/v3/ui";
import { Icon } from "@/components/v3/icons";
import { hfFmt, levFmt, nf, usd } from "@/components/v3/format";
import { TokenPickButton, type PickerRow } from "@/components/v3/token-picker";
import { WARN_HF, LIQ_HF } from "@/lib/account-model";
import { DropdownOptions } from "@/lib/constants";
import { MAX_LEVERAGE } from "@/lib/constants/margin";
import type { BorrowInfo } from "@/lib/types";
import { validateAmountChange, floorAmountToInput, numberAmountToWad } from "@/lib/utils/sanitize-amount";
import { getXlmMinReserve, maxSpendableXlm } from "@/lib/xlm-reserve";
import { MarginAccountService } from "@/lib/margin-utils";
import { normalizeContractError, normalizeDepositCollateralError } from "@/lib/errors/normalize";
import { showTxStep, showTxSuccess, showTxError } from "@/lib/tx-progress";
import { usePoolData } from "@/hooks/use-earn";
import { useWallet } from "@/hooks/use-wallet";
import {
  useMarginAccountInfoStore,
  borrowTokens,
  setupContractConfiguration,
  refreshBorrowedBalances,
} from "@/store/margin-account-info-store";
import { accountNumbers, liqBuffer, riskEngineMaxBorrowUsd, withBorrows, withDeposits, type Move } from "./mg-sim";
import { LevSlider, MI, PctChips, PrevBox, PrevRow, RatioBtn, TIPS, toneHf } from "./mg-ui";
import { CreateAccountModal } from "./mg-create-account";
import { ckey, type MarginScreen } from "./use-margin-screen";

// Live step-by-step progress for the WB deposit(+borrow) flow — a multi-leg
// operation (deposit, then borrow, then a second borrow for Dual Borrow)
// shows which step is running (and which one failed) via the centered
// TransactionProgressModal, which updates in place, instead of a static
// "Processing..." button with no visibility into a silently-dropped leg.
const showStep = (message: string) => showTxStep(message);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const showStepSuccess = (message: string, _txHash?: string) => showTxSuccess(message);
const showStepError = (message: string) => showTxError(message);

/** Tolerance for comparing typed XLM amounts against balances (float noise). */
const XLM_DEPOSIT_EPSILON = 1e-7;

/** Contract symbol of a UI token (same mapping as the previous Leverage tab). */
const normalizeContractTokenSymbol = (symbol: string) => {
  if (symbol === "BLUSDC" || symbol === "BLEND_USDC" || symbol === "USDC") return "BLUSDC";
  if (symbol === "AqUSDC" || symbol === "AquiresUSDC" || symbol === "AQUARIUS_USDC") return "AQUSDC";
  if (symbol === "SoUSDC" || symbol === "SoroswapUSDC" || symbol === "SOROSWAP_USDC") return "SOUSDC";
  return symbol;
};

/** Token names for the picker. */
const NAMES: Record<string, string> = { XLM: "Stellar Lumens", BLUSDC: "Blend USDC", AqUSDC: "Aquarius USDC", SoUSDC: "Soroswap USDC" };
/** Lending-pool key of a borrowable token (`/api/pools` shape). */
const POOL_KEY: Record<string, "XLM" | "USDC" | "AQUARIUS_USDC" | "SOROSWAP_USDC"> = { XLM: "XLM", BLUSDC: "USDC", AqUSDC: "AQUARIUS_USDC", SoUSDC: "SOROSWAP_USDC" };
const bal4 = (v: number) => nf(v, v >= 1000 ? 2 : 4);
/** "<faucet name>" used in the no-balance hint. */
const faucetHint = (asset: string) =>
  asset === "BLUSDC" ? "Blend USDC" : asset === "AQUSDC" ? "Aquarius USDC" : asset === "SOUSDC" ? "Soroswap USDC" : asset;

interface Row {
  id: string;
  sym: string;
  amt: string;
  src: "wb" | "mb";
  pct: number;
}
let seq = 0;
const newRow = (): Row => ({ id: `r${++seq}`, sym: DropdownOptions[0], amt: "", src: "wb", pct: 0 });
const num = (s: string) => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};
/** Borrow auto-fill formatting (the previous DualBorrow's): 7 dp, trailing zeros trimmed. */
const fmtAmt = (amt: number) => (amt > 0 ? amt.toFixed(7).replace(/\.?0+$/, "") : "");
const floor2 = (v: number) => Math.floor(v * 100) / 100;

export function LeverageTab({ m }: { m: MarginScreen }) {
  const qc = useQueryClient();
  const { refreshBalances } = useWallet();
  const { pools } = usePoolData();
  const { address, hasAccount, model, now } = m;
  const marginAccountAddress = m.marginAddress;
  /** Price exactly as the previous tab read it: the oracle map, unknown → 1. */
  const pxS = useCallback((s: string) => m.prices[ckey(s)] ?? 1, [m.prices]);
  /** Price as the previous DualBorrow read it: unknown → 0 (no auto-fill). */
  const pxB = useCallback((s: string) => m.prices[ckey(s)] ?? 0, [m.prices]);

  // Real on-chain XLM minimum reserve — a flat reserve is wrong once the account
  // holds a few trustlines (BLUSDC/AQUSDC/SOUSDC/LP), so a "100%" click on XLM
  // would set an amount that passes the app's own math but still traps on-chain
  // with "resulting balance is not within the allowed range" (Contract #10).
  const [xlmMinReserve, setXlmMinReserve] = useState(1.5);
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    getXlmMinReserve(address).then((r) => {
      if (!cancelled) setXlmMinReserve(r);
    });
    return () => {
      cancelled = true;
    };
  }, [address]);

  useEffect(() => {
    if (!address) return;
    refreshBalances(address).catch((err) => {
      console.warn("Failed to refresh wallet balances on margin page:", err);
    });
  }, [address, refreshBalances]);

  // Token picker rows. Deposit: the balance the chosen source holds (wallet for WB, margin account for MB).
  // Borrow: what each Vanna lending pool can lend right now, with its borrow APY.
  const depositRows = (src: Row["src"]): PickerRow[] =>
    DropdownOptions.map((s) => ({ symbol: s, name: NAMES[s] ?? s, value: bal4(src === "mb" ? m.vault(s) : m.wbal(s)) }));
  const borrowRows: PickerRow[] = DropdownOptions.map((s) => {
    const p = pools?.[POOL_KEY[s]];
    return { symbol: s, name: NAMES[s] ?? s, value: bal4(parseFloat(p?.availableLiquidity ?? "0") || 0), valueSub: `${nf(parseFloat(p?.borrowAPY ?? "0") || 0, 2)}% borrow APY` };
  });

  // The first row's id is fixed so server and client render the same markup (the counter only
  // numbers rows added later, which happens in the browser).
  const [rows, setRows] = useState<Row[]>(() => [{ ...newRow(), id: "r0" }]);
  const [editId, setEditId] = useState<string | null>(() => rows[0].id);
  // The row as it was before editing started (Cancel restores it; null = a newly added row).
  const [backup, setBackup] = useState<Row | null>(null);
  const [dual, setDual] = useState(false);
  // Default to two distinct assets so dual mode is valid out of the box.
  const [bTok, setBTok] = useState<[string, string]>(["BLUSDC", "XLM"]);
  // Typed borrow amounts; null = follow the leverage (auto-fill).
  const [bManual, setBManual] = useState<[string, string] | null>(null);
  const [lev, setLev] = useState(2);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const mb = rows.length === 1 && rows[0].src === "mb";
  const rowBal = (r: Row) => (r.src === "mb" ? m.vault(r.sym) : m.wbal(r.sym));

  // Entering MB with no collateral loaded yet → pull the margin-account balances so the row's
  // live Balance / % math fills in instead of flashing zero. refreshBorrowedBalances dedups /
  // throttles internally, so this is safe on every MB enter.
  useEffect(() => {
    if (mb && marginAccountAddress && m.gross <= 0.01) {
      refreshBorrowedBalances(marginAccountAddress, true).catch(() => {});
    }
  }, [mb, marginAccountAddress, m.gross]);

  // ---- derived state (the design's levState, Stellar limits) ----
  const st = useMemo(() => {
    const depUsd = rows.reduce((t, r) => t + num(r.amt) * pxS(r.sym), 0);
    const deps: Move[] = mb ? [] : rows.filter((r) => num(r.amt) > 0).map((r) => ({ symbol: ckey(r.sym), usd: num(r.amt) * pxS(r.sym) }));
    const n = dual ? 2 : 1;
    const syms = bTok.slice(0, n);
    // The RiskEngine borrow limit the submit pre-check enforces (gross includes a WB deposit).
    const accMax = riskEngineMaxBorrowUsd(m.gross + (mb ? 0 : depUsd), m.borrowedUsd);
    const max = depUsd > 0 ? Math.max(1, Math.min(MAX_LEVERAGE, floor2(1 + accMax / depUsd) || 1)) : MAX_LEVERAGE;
    const levE = Math.max(1, Math.min(lev, max));
    const maxUsd = Math.max(0, depUsd * (levE - 1));
    // Leverage-driven auto-fill: single puts the whole amount on the one asset, dual splits 50/50.
    const auto =
      n === 1
        ? [pxB(syms[0]) > 0 ? fmtAmt(maxUsd / pxB(syms[0])) : "", ""]
        : syms.map((s) => (pxB(s) > 0 ? fmtAmt(maxUsd / 2 / pxB(s)) : ""));
    const shown = syms.map((_, i) => (bManual ? bManual[i] : auto[i]) ?? "");
    const items = syms.map((sym, i) => ({ sym, amt: num(shown[i]), str: shown[i], usd: num(shown[i]) * pxB(sym) }));
    const totalUsd = items.reduce((t, x) => t + x.usd, 0);
    const dup = n === 2 && bTok[0] === bTok[1];
    let error: string | null = null;
    let exceeds = false;
    if (totalUsd > 0 && depUsd <= 0) error = "Add collateral before borrowing.";
    else if (dup) error = "Pick two different assets to borrow.";
    // 1-cent tolerance: the auto-fill targets exactly Max and USD rounding can land a hair above it.
    else if (totalUsd > maxUsd + 0.01) {
      error = `Total borrow ${usd(totalUsd)} exceeds your limit of ${usd(maxUsd)}. Lower an amount or raise leverage.`;
      exceeds = true;
    }
    // What the submit flow reads (the previous DualBorrow's emitted items: slots with an amount).
    const borrowItems: BorrowInfo[] = items
      .filter((x) => x.amt > 0)
      .map((x) => ({ assetData: { asset: x.sym, amount: x.str }, percentage: depUsd > 0 ? Number(((x.usd / depUsd) * 100).toFixed(2)) : 0, usdValue: x.usd }));
    const borrows = levE > 1 ? items.filter((x) => x.amt > 0) : [];
    const after = withBorrows(withDeposits(model, deps), borrows.map((b) => ({ symbol: ckey(b.sym), usd: b.usd })));
    return { depUsd, deps, n, syms, accMax, max, levE, maxUsd, shown, items, totalUsd, dup, error, exceeds, borrowItems, afterN: accountNumbers(after) };
  }, [rows, mb, dual, bTok, bManual, lev, model, pxS, pxB, m.gross, m.borrowedUsd]);

  // Keep the chosen leverage inside the (input-dependent) RiskEngine max.
  useEffect(() => {
    if (lev > st.max) setLev(st.max);
  }, [lev, st.max]);

  // ---- handlers ----
  const auto = () => setBManual(null); // a driving input changed → borrow follows the leverage again
  const patch = (id: string, p: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
    auto();
  };
  const setSrc = (id: string, src: Row["src"]) => {
    // MB is single-collateral: it clears every other row; WB drops any MB row.
    setRows((rs) => (src === "mb" ? rs.filter((r) => r.id === id) : rs.filter((r) => r.id === id || r.src !== "mb")).map((r) => (r.id === id ? { ...r, src, pct: 0 } : r)));
    setEditId(id);
    auto();
  };
  const pickPct = (r: Row, p: number) => {
    const balance = r.src === "wb" ? m.wbal(r.sym) : m.vault(r.sym);
    // For a WB-sourced native XLM deposit, percentages apply to the safely spendable balance
    // (wallet balance minus the account's real reserve), not the raw balance.
    const spendable = r.sym === "XLM" && r.src === "wb" ? maxSpendableXlm(balance, xlmMinReserve) : balance;
    patch(r.id, { pct: p, amt: floorAmountToInput((spendable * p) / 100) });
  };
  const onAmt = (r: Row, raw: string) => {
    const v = validateAmountChange(raw);
    if (v !== null) patch(r.id, { amt: v, pct: 0 });
  };
  const startEdit = (r: Row) => {
    if (editId) return;
    setBackup({ ...r });
    setEditId(r.id);
  };
  const cancel = () => {
    if (!editId) return;
    const i = rows.findIndex((r) => r.id === editId);
    if (backup && backup.id === editId) setRows((rs) => rs.map((r) => (r.id === editId ? backup : r)));
    else if (i > 0 && !(num(rows[i].amt) > 0)) setRows((rs) => rs.filter((r) => r.id !== editId)); // an empty added row goes away
    setBackup(null);
    setEditId(null);
    auto();
  };
  const save = () => {
    setBackup(null);
    setEditId(null);
  };
  const addRow = () => {
    if (editId || mb) return;
    const r = newRow();
    setRows((rs) => [...rs, r]);
    setBackup(null);
    setEditId(r.id);
  };
  const delRow = (id: string) => {
    if (editId) return;
    setRows((rs) => (rs[0]?.id === id ? rs : rs.filter((r) => r.id !== id)));
    auto();
  };
  const changeLev = (v: number) => {
    setLev(Math.round(Math.max(1, Math.min(st.max, v)) * 100) / 100);
    auto();
  };
  const onBorAmt = (i: number, raw: string) => {
    if (raw !== "" && !/^\d*\.?\d*$/.test(raw)) return; // numeric only
    const next: [string, string] = [st.shown[0] ?? "", st.shown[1] ?? ""];
    next[i] = raw;
    setBManual(next);
  };
  // Reset the entire form after a successful Deposit & Borrow / Borrow so the next position doesn't
  // inherit stale collateral, leverage, or borrow amounts.
  const resetForm = () => {
    const r = newRow();
    setRows([r]);
    setEditId(r.id);
    setBackup(null);
    setLev(2);
    setBManual(null);
  };

  /** The previous Leverage tab's submit, verbatim in its checks, amounts and contract calls. */
  const submit = async () => {
    const userAddress = address;
    if (!userAddress) return;

    // Block the action while a collateral row is mid-edit — but only for an existing margin
    // account, where Deposit & Borrow must submit a settled amount. Creating the account itself
    // takes no amount at all.
    if (editId !== null && hasAccount) {
      toast.error("Please save or cancel your collateral edit before proceeding.");
      return;
    }
    if (!hasAccount) {
      setCreating(true);
      return;
    }

    const leverage = st.levE;
    const borrowState = { items: st.borrowItems };
    const isDualBorrow = borrowState.items.length === 2;
    const borrowToken = borrowState.items[0]?.assetData.asset ?? DropdownOptions[0];
    // A typed single-borrow amount is sent as typed; otherwise (auto-fill) the amount is derived
    // from the leverage exactly as before.
    const explicitSingle = !isDualBorrow && bManual !== null && borrowState.items.length === 1 ? parseFloat(borrowState.items[0].assetData.amount) || 0 : undefined;
    const collateralList = rows.map((r) => ({ asset: r.sym, amount: num(r.amt), amountInUsd: parseFloat((num(r.amt) * pxS(r.sym)).toFixed(2)), balanceType: r.src }));

    // ── MB mode: borrow-only (collateral already in margin account) ──────────
    if (mb) {
      const mbRow = collateralList[0];
      const totalCollateralUsd = st.depUsd;
      if (totalCollateralUsd <= 0) {
        toast.error("Enter how much of your margin-account collateral to borrow against.");
        return;
      }
      // The row's amount is a sizing input, not a real transfer — but it shouldn't claim more
      // collateral than the account actually holds for that asset.
      const realBalance = m.vault(mbRow.asset);
      const realBalanceUsd = realBalance * pxS(mbRow.asset);
      if (mbRow.amount > realBalance + 1e-7) {
        toast.error(`You only have ${realBalance.toFixed(4)} ${mbRow.asset} (~$${realBalanceUsd.toFixed(2)}) in your margin account. Reduce the amount or use the 100% chip.`);
        return;
      }
      if (leverage <= 1) {
        toast.error("Please set leverage greater than 1x to borrow.");
        return;
      }

      const normalizedBorrowToken = normalizeContractTokenSymbol(borrowToken);
      const borrowTokenPrice = pxS(normalizedBorrowToken);
      const borrowAmountUsd = explicitSingle !== undefined ? explicitSingle * borrowTokenPrice : totalCollateralUsd * (leverage - 1);
      const borrowAmountTokens = explicitSingle !== undefined ? explicitSingle : borrowAmountUsd / borrowTokenPrice;

      // Pre-validate against risk engine before submitting
      const latestMarginState = useMarginAccountInfoStore.getState();
      const maxAdditionalBorrowUsd = riskEngineMaxBorrowUsd(latestMarginState.grossCollateralValue, latestMarginState.totalBorrowedValue);
      if (maxAdditionalBorrowUsd <= 0) {
        toast.error("You've reached the safe borrow limit for your current collateral. Add more collateral or repay part of your loan to borrow more.");
        return;
      }
      if (borrowAmountUsd > maxAdditionalBorrowUsd) {
        const maxSafeLeverage = totalCollateralUsd > 0 ? parseFloat((1 + (maxAdditionalBorrowUsd * 0.95) / totalCollateralUsd).toFixed(2)) : 1;
        toast.error(`Selected leverage (${leverage}x) is above the safe limit for your collateral. Lower it to ~${maxSafeLeverage}x or add more collateral.`);
        return;
      }

      setBusy(true);
      // Dual Borrow: execute each item's own amount as a separate borrowTokens() call.
      const items = isDualBorrow
        ? borrowState.items
            .map((b) => ({ token: normalizeContractTokenSymbol(b.assetData.asset), displayAsset: b.assetData.asset, amount: parseFloat(b.assetData.amount) || 0 }))
            .filter((b) => b.amount > 0)
        : [{ token: normalizedBorrowToken, displayAsset: normalizedBorrowToken, amount: borrowAmountTokens }];
      showStep(`Borrowing ${items.map((b) => `${b.amount.toFixed(2)} ${b.displayAsset}`).join(" + ")}`);
      let lastHash = "";
      try {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (items.length > 1) showStep(`Step ${i + 1}/${items.length}: Borrowing ${item.amount.toFixed(2)} ${item.displayAsset}`);
          const result = await borrowTokens(userAddress, item.token, item.amount);
          if (!result.success) {
            // Build the "first leg already landed" context BEFORE normalizing — normalizeContractError
            // returns its `raw` argument as-is when it doesn't match a known pattern.
            const rawWithContext = lastHash
              ? `First asset borrowed. Second borrow (${item.displayAsset}) failed: ${result.error ?? "Unknown error"}`
              : isDualBorrow
                ? `Borrow (${item.displayAsset}) failed: ${result.error ?? "Unknown error"}`
                : result.error || "Borrow failed";
            showStepError(normalizeContractError(rawWithContext, "Borrow failed. Please try again."));
            try {
              await refreshBalances(userAddress);
            } catch (refreshErr) {
              console.warn("Failed to refresh wallet balances after borrow failure:", refreshErr);
            }
            if (marginAccountAddress) await refreshBorrowedBalances(marginAccountAddress, true);
            return;
          }
          lastHash = result.hash ?? lastHash;
        }
        showStepSuccess(`Borrowed ${items.map((b) => `${b.amount.toFixed(2)} ${b.displayAsset}`).join(" + ")} against your margin collateral.`, lastHash || undefined);
        resetForm();
        qc.invalidateQueries({ queryKey: ["margin"] });
        // Force past the 3s throttle so the new debt shows immediately — the tx is already
        // confirmed in a closed ledger. Swallow transient post-popup throws; the ledger tick reconciles.
        if (marginAccountAddress) {
          try {
            await refreshBorrowedBalances(marginAccountAddress, true);
          } catch (e) {
            console.warn("Post-borrow refresh failed; ledger tick will reconcile:", e);
          }
        }
      } catch (error) {
        showStepError(normalizeContractError(error instanceof Error ? error.message : undefined, "Borrow failed. Please try again."));
      } finally {
        setBusy(false);
      }
      return;
    }

    // ── WB mode: deposit + borrow ───────────────────────────────────────────
    try {
      setBusy(true);
      // Refresh latest risk metrics before computing borrow size
      if (marginAccountAddress) await refreshBorrowedBalances(marginAccountAddress);
      if (!marginAccountAddress) {
        toast.error("Margin account not found. Please reconnect wallet and try again.");
        return;
      }

      const wbDeposits = collateralList
        .filter((item) => item.balanceType === "wb")
        .map((item) => {
          const normalizedAsset = normalizeContractTokenSymbol(item.asset || "XLM");
          const amount = Number(item.amount || 0);
          const amountInUsd = Number(item.amountInUsd || 0) || amount * pxS(normalizedAsset);
          return { asset: normalizedAsset, amount, amountInUsd };
        })
        .filter((item) => item.amount > 0);

      if (wbDeposits.length === 0) {
        toast.error("Please enter a deposit amount greater than 0");
        return;
      }

      const multiplier = leverage;
      const totalDepositAmountUsd = wbDeposits.reduce((sum, item) => sum + item.amountInUsd, 0);
      const totalXlmDeposit = wbDeposits.filter((item) => item.asset === "XLM").reduce((sum, item) => sum + item.amount, 0);
      const maxXlmDeposit = maxSpendableXlm(m.wbal("XLM"), xlmMinReserve);
      if (totalXlmDeposit > 0 && totalXlmDeposit > maxXlmDeposit + XLM_DEPOSIT_EPSILON) {
        toast.error(`You cannot deposit that much XLM. Please keep at least ${xlmMinReserve.toFixed(2)} XLM in your wallet for the account reserve.`);
        return;
      }
      for (const item of wbDeposits) {
        if (item.asset === "XLM") continue;
        const available = m.wbal(item.asset);
        if (item.amount > available + XLM_DEPOSIT_EPSILON) {
          toast.error(
            available <= XLM_DEPOSIT_EPSILON
              ? `You have no ${item.asset} in your wallet. Use the Faucet to mint ${faucetHint(item.asset)} first, then retry.`
              : `Insufficient ${item.asset} wallet balance. Available: ${available.toFixed(2)} ${item.asset}.`,
          );
          return;
        }
      }

      // Pre-validate borrow against the Risk Engine's formula before submitting.
      // On-chain: (grossAssets + borrow) / (debt + borrow) > 1.1, where grossAssets
      // = priced collateral + outstanding debt (borrowed funds still in the account).
      if (multiplier > 1) {
        const latestMarginState = useMarginAccountInfoStore.getState();
        const projectedGrossUsd = latestMarginState.grossCollateralValue + totalDepositAmountUsd;
        const requestedBorrowUsd = explicitSingle !== undefined ? explicitSingle * pxS(borrowToken) : totalDepositAmountUsd * (multiplier - 1);
        const maxAdditionalBorrowUsd = riskEngineMaxBorrowUsd(projectedGrossUsd, latestMarginState.totalBorrowedValue);
        if (maxAdditionalBorrowUsd <= 0) {
          toast.error("Borrow is blocked by Risk Engine: your current debt is already too high for your collateral. Add more collateral or repay first.");
          return;
        }
        if (requestedBorrowUsd > maxAdditionalBorrowUsd) {
          const maxSafeLeverage = totalDepositAmountUsd > 0 ? parseFloat((1 + (maxAdditionalBorrowUsd * 0.95) / totalDepositAmountUsd).toFixed(2)) : 1;
          toast.error(`Selected leverage (${multiplier}x) exceeds your account's safe borrowing limit. Max safe leverage: ~${maxSafeLeverage}x. Add more collateral or repay existing debt first.`);
          return;
        }
      }

      const normalizedBorrowToken = normalizeContractTokenSymbol(borrowToken || wbDeposits[0]?.asset || "XLM");
      // Fast path: single-collateral → the atomic contract method (deposit_and_borrow for
      // same-asset, deposit_and_borrow_cross for cross-asset). One wallet signature either way.
      const canUseAtomic = wbDeposits.length === 1;
      const isCrossAsset = wbDeposits[0]?.asset !== normalizedBorrowToken;
      // Flipped to true when the atomic deposit+borrow overflows Soroban's per-tx budget,
      // routing execution to the 2-tx split flow below.
      let useSplitFlow = !canUseAtomic;
      const depositHashes: string[] = [];
      let borrowHash = "";

      const atomicItem = wbDeposits[0];
      // For dual borrow, the first item's explicit amount; for a typed single borrow, that amount;
      // for cross-asset single borrow, the leverage USD target in borrow-token units. Same-asset
      // single borrow leaves options undefined so MarginAccountService uses the multiplier.
      const borrowOptions = (() => {
        if (isDualBorrow && borrowState.items.length > 0) {
          const b0 = borrowState.items[0];
          return { borrowTokenSymbol: normalizeContractTokenSymbol(b0.assetData.asset), borrowAmountTokens: parseFloat(b0.assetData.amount) || 0 };
        }
        if (explicitSingle !== undefined && multiplier > 1) {
          return { borrowTokenSymbol: normalizedBorrowToken, borrowAmountTokens: explicitSingle };
        }
        if (isCrossAsset && multiplier > 1) {
          const depositUsd = atomicItem.amount * pxS(atomicItem.asset);
          const borrowUsd = depositUsd * (multiplier - 1);
          const borrowPrice = pxS(normalizedBorrowToken);
          return { borrowTokenSymbol: normalizedBorrowToken, borrowAmountTokens: borrowPrice > 0 ? borrowUsd / borrowPrice : 0 };
        }
        return undefined;
      })();
      // Display-only preview of the same math, so the step message states the ACTUAL borrow amount.
      const atomicDisplayBorrow =
        canUseAtomic && multiplier > 1
          ? borrowOptions
            ? { amountTokens: borrowOptions.borrowAmountTokens, displaySymbol: isDualBorrow ? borrowState.items[0].assetData.asset : borrowToken || atomicItem.asset }
            : { amountTokens: atomicItem.amount * (multiplier - 1), displaySymbol: atomicItem.asset }
          : undefined;

      showStep(
        canUseAtomic
          ? `${isDualBorrow ? "Step 1/2: " : ""}Depositing ${atomicItem.amount.toFixed(2)} ${atomicItem.asset}${
              atomicDisplayBorrow ? ` and borrowing ${atomicDisplayBorrow.amountTokens.toFixed(2)} ${atomicDisplayBorrow.displaySymbol}` : ""
            }`
          : `Depositing ${wbDeposits.map((d) => `${d.amount.toFixed(2)} ${d.asset}`).join(" + ")}`,
      );

      if (canUseAtomic) {
        const atomicResult = await MarginAccountService.depositAndBorrow(marginAccountAddress, atomicItem.amount, multiplier, atomicItem.asset, borrowOptions);
        if (atomicResult.success) {
          if (atomicResult.hash) {
            depositHashes.push(atomicResult.hash);
            if (multiplier > 1) borrowHash = atomicResult.hash;
          }
          // Dual borrow second leg: borrow the second asset as a separate tx.
          if (isDualBorrow && borrowState.items.length > 1 && multiplier > 1) {
            const b1 = borrowState.items[1];
            const sym1 = normalizeContractTokenSymbol(b1.assetData.asset);
            const amt1 = parseFloat(b1.assetData.amount) || 0;
            if (amt1 > 0) {
              showStep(`Step 2/2: Borrowing ${amt1.toFixed(2)} ${b1.assetData.asset}`);
              // Hand this leg the exact sequence the atomic deposit+borrow tx just consumed — a
              // fresh RPC read right after that tx confirms is not reliably caught up (txBadSeq).
              const borrow2Result = await borrowTokens(userAddress, sym1, amt1, atomicResult.nextSequence);
              if (borrow2Result.success) {
                borrowHash = borrow2Result.hash ?? borrowHash;
              } else {
                // The deposit + first borrow already landed on-chain — report the second leg's
                // failure instead of an unconditional success.
                showStepError(normalizeDepositCollateralError(`First asset borrowed. Second borrow (${b1.assetData.asset}) failed: ${borrow2Result.error ?? "Unknown error"}`));
                try {
                  await refreshBalances(userAddress);
                } catch (refreshErr) {
                  console.warn("Failed to refresh wallet balances after dual-borrow second-leg failure:", refreshErr);
                }
                await refreshBorrowedBalances(marginAccountAddress, true);
                return;
              }
            }
          }
        } else {
          // Error(Budget, ExceededLimit): the chained deposit→borrow overflowed Soroban's per-tx
          // CPU/resource cap — a hard network limit, so split it into two transactions instead.
          // The atomic tx failed wholesale, so nothing was deposited; the split flow is clean.
          const isBudgetError = /budget|exceededlimit|resource/i.test(atomicResult.error ?? "");
          if (isBudgetError) {
            console.warn("[leverage] atomic deposit_and_borrow hit Soroban budget; falling back to split 2-tx flow");
            useSplitFlow = true;
          } else if (atomicResult.error?.includes("not allowed as collateral") || atomicResult.error?.includes("Max asset cap")) {
            showStepError(`Contract configuration error: ${atomicResult.error}`);
            return;
          } else {
            showStepError(normalizeDepositCollateralError(atomicResult.error));
            return;
          }
        }
      }

      if (useSplitFlow) {
        // Per-token deposit, then a separate borrow. Used for multi-collateral and as the fallback
        // when the atomic deposit+borrow exceeds the Soroban budget.
        const borrowsToExecute =
          multiplier > 1
            ? isDualBorrow
              ? borrowState.items.map((b) => ({ token: normalizeContractTokenSymbol(b.assetData.asset), amount: parseFloat(b.assetData.amount) || 0 })).filter((b) => b.amount > 0)
              : explicitSingle !== undefined
                ? [{ token: normalizedBorrowToken, amount: explicitSingle }]
                : [{ token: normalizedBorrowToken, amount: (totalDepositAmountUsd * (multiplier - 1)) / pxS(normalizedBorrowToken) }]
            : [];
        const totalSteps = wbDeposits.length + borrowsToExecute.length;
        let stepNum = 0;

        for (const item of wbDeposits) {
          stepNum += 1;
          showStep(`Step ${stepNum}/${totalSteps}: Depositing ${item.amount.toFixed(2)} ${item.asset}`);
          const amountWad = numberAmountToWad(item.amount).toString();
          const depositResult = await MarginAccountService.depositCollateralTokens(marginAccountAddress, item.asset, amountWad);
          if (!depositResult.success) {
            if (depositResult.error?.includes("not allowed as collateral") || depositResult.error?.includes("Max asset cap")) {
              showStepError(`Contract configuration error: ${depositResult.error}`);
              try {
                const configResult = await setupContractConfiguration();
                if (configResult.success) toast.success("Contract configuration setup successful! You can now try the deposit again.");
                else toast.error("Contract setup failed: " + configResult.error);
              } catch (setupError) {
                toast.error(normalizeContractError(setupError instanceof Error ? setupError.message : undefined, "Setup error. Please try again."));
              }
            } else {
              showStepError(normalizeDepositCollateralError(depositResult.error));
            }
            return;
          }
          if (depositResult.hash) depositHashes.push(depositResult.hash);
        }

        if (multiplier > 1) {
          for (const bItem of borrowsToExecute) {
            stepNum += 1;
            showStep(`Step ${stepNum}/${totalSteps}: Borrowing ${bItem.amount.toFixed(2)} ${bItem.token}`);
            const borrowResult = await borrowTokens(userAddress, bItem.token, bItem.amount);
            if (!borrowResult.success) {
              console.error("❌ Borrow failed after successful deposits:", borrowResult.error);
              showStepError(normalizeDepositCollateralError(`Deposits were successful. Borrow ${bItem.token} failed: ${borrowResult.error || "Unknown borrow error"}`));
              try {
                await refreshBalances(userAddress);
              } catch (refreshErr) {
                console.warn("Failed to refresh wallet balances after borrow failure:", refreshErr);
              }
              await refreshBorrowedBalances(marginAccountAddress, true);
              return;
            }
            borrowHash = borrowResult.hash ?? "";
          }
        }
      }

      // The tx is already confirmed in a closed ledger, so unblock the UI NOW — success, reset,
      // drop the "Processing…" state — and run the refresh in the BACKGROUND.
      const txPreview = borrowHash || depositHashes[depositHashes.length - 1] || "";
      showStepSuccess(
        isDualBorrow ? "Deposited collateral and borrowed both assets successfully." : multiplier > 1 ? "Deposited collateral and borrowed successfully." : "Collateral deposited successfully.",
        txPreview || undefined,
      );
      resetForm();
      setBusy(false);

      // Optimistic, post-confirmation: merge the just-deposited collateral into the store NOW so
      // switching to MB shows it instantly; the background refresh reconciles to exact on-chain values.
      {
        const store = useMarginAccountInfoStore.getState();
        const nextCollateral = { ...store.collateralBalances };
        for (const item of wbDeposits) {
          const key = normalizeContractTokenSymbol(item.asset);
          const price = pxS(key);
          const prevAmt = parseFloat(nextCollateral[key]?.amount || "0") || 0;
          const newAmt = prevAmt + item.amount;
          nextCollateral[key] = { amount: newAmt.toFixed(7), usdValue: (newAmt * price).toFixed(2) };
        }
        store.set({ collateralBalances: nextCollateral });
      }

      qc.invalidateQueries({ queryKey: ["margin"] });
      void (async () => {
        try {
          await refreshBalances(userAddress);
        } catch (refreshErr) {
          console.warn("Failed to refresh wallet balances after leverage action:", refreshErr);
        }
        try {
          await refreshBorrowedBalances(marginAccountAddress, true);
        } catch (e) {
          console.warn("Post-deposit refresh failed; ledger tick will reconcile:", e);
        }
      })();
    } catch (error) {
      console.error("❌ Error in deposit and borrow:", error);
      showStepError(normalizeDepositCollateralError(error instanceof Error ? error.message : "Unknown error"));
    } finally {
      setBusy(false);
    }
  };

  // ---- preview ----
  const dep = mb ? 0 : st.depUsd;
  const bor = st.levE > 1 ? st.totalUsd : 0;
  const showPrev = dep > 0 || bor > 0;
  const b = now;
  const a = st.afterN;
  const label = busy
    ? "Processing..."
    : editId !== null && hasAccount
      ? "Save Collateral to Continue"
      : !address
        ? "Login"
        : hasAccount && !mb
          ? st.levE <= 1
            ? "Deposit"
            : "Deposit & Borrow"
          : hasAccount && mb
            ? "Borrow"
            : "Create your Margin Account";
  const disabled = busy || (editId !== null && hasAccount) || !!st.error;
  const warn = !disabled && hasAccount && bor > 0 && a.hf > LIQ_HF && a.hf < WARN_HF;

  return (
    <div className="mg-lev">
      <div className="mg-dep">
        <h2 className="mg-h2">Deposit</h2>
        <ul className={`mg-rows ${rows.length > 2 ? "scroll" : ""}`} role="list">
          {rows.map((r, i) => {
            const bal = rowBal(r);
            const v = num(r.amt) * pxS(r.sym);
            return (
              <li key={r.id}>
                {editId === r.id ? (
                  <article className="mg-cc">
                    <div className="mg-r">
                      <span className="mg-lbl">Deposit</span>
                      <PctChips value={r.pct} label="Deposit percentage" onPick={(p) => pickPct(r, p)} />
                    </div>
                    <div className="mg-r">
                      <span className="mg-ddw">
                        <TokenPickButton
                          sym={r.sym}
                          className="mg-tok"
                          iconClassName="ico mg-ti"
                          chevron={<span className="mg-cv">{MI.chev16}</span>}
                          rows={depositRows(r.src)}
                          valueLabel={r.src === "mb" ? "Margin balance" : "Wallet balance"}
                          onSelect={(s) => patch(r.id, { sym: s, amt: "", pct: 0 })}
                        />
                      </span>
                      <input className="mg-amt num" inputMode="decimal" autoComplete="off" placeholder="0" value={r.amt} aria-label="Collateral amount" onChange={(e) => onAmt(r, e.target.value)} />
                    </div>
                    <div className="mg-r end">
                      <span className="mg-sub num">~ {usd(v)} USD</span>
                    </div>
                    <div className="mg-r start">
                      <span className="mg-seg" role="group" aria-label="Source">
                        {(["wb", "mb"] as const).map((s) => (
                          <button
                            key={s}
                            type="button"
                            className={r.src === s ? "on" : ""}
                            aria-pressed={r.src === s}
                            aria-label={s === "wb" ? "Deposit from wallet balance" : "Use margin balance"}
                            onClick={() => setSrc(r.id, s)}
                          >
                            {s.toUpperCase()}
                          </button>
                        ))}
                      </span>
                      <Info text="WB deposits from your wallet balance; MB borrows against collateral that is already in your margin account." />
                    </div>
                    <div className="mg-r">
                      <div className="mg-bl">
                        <span className="mg-sub num">
                          Balance: {nf(bal, 2)} {r.sym}
                        </span>
                        <RatioBtn sym={r.sym} price={pxB(r.sym)} />
                      </div>
                      <div className="mg-acts">
                        <button type="button" className="mg-cancel" onClick={cancel}>
                          Cancel
                        </button>
                        <button type="button" className="mg-add" onClick={save}>
                          Add
                        </button>
                      </div>
                    </div>
                  </article>
                ) : (
                  <article className="mg-cc">
                    <div className="mg-r">
                      <span className="mg-lbl">Deposit</span>
                      <span className="mg-acts" style={{ gap: 6 }}>
                        <button type="button" className="mg-icb" disabled={!!editId} aria-label="Edit collateral" onClick={() => startEdit(r)}>
                          {MI.pen}
                        </button>
                        {i > 0 && (
                          <button type="button" className="mg-icb" disabled={!!editId} aria-label="Delete collateral" onClick={() => delRow(r.id)}>
                            {MI.dash}
                          </button>
                        )}
                      </span>
                    </div>
                    <div className="mg-r">
                      <span className="mg-tok" style={{ cursor: "default" }}>
                        <Icon sym={r.sym} className="ico mg-ti" />
                        <span>{r.sym}</span>
                        <span className="mg-badge">{r.src.toUpperCase()}</span>
                      </span>
                      <span className="mg-amtv num">{nf(num(r.amt), 2)}</span>
                    </div>
                    <div className="mg-r">
                      <div className="mg-bl">
                        <span className="mg-sub num">
                          Balance: {nf(bal, 2)} {r.sym}
                        </span>
                        <RatioBtn sym={r.sym} price={pxB(r.sym)} />
                      </div>
                      <span className="mg-sub num">~ {usd(v)} USD</span>
                    </div>
                  </article>
                )}
              </li>
            );
          })}
        </ul>
        <button type="button" className="mg-addc" disabled={!!editId || mb} onClick={addRow}>
          {MI.plus11}Add Collateral
        </button>
      </div>

      <div className="mg-bor">
        <div className="mg-bh">
          <span className="mg-h3">Borrow</span>
          <span className="mg-sw">
            <span className={dual ? "" : "on"}>Single Borrow</span>
            <button
              type="button"
              className={`mg-tgl ${dual ? "on" : ""}`}
              role="switch"
              aria-checked={dual}
              aria-label="Toggle dual borrow"
              onClick={() => {
                setDual((d) => !d);
                auto();
              }}
            >
              <i />
            </button>
            <span className={dual ? "on" : ""}>Dual Borrow</span>
          </span>
        </div>
        <div className={`mg-bcards ${dual ? "dual" : ""}`}>
          {st.items.map((it, i) => {
            const err = (st.exceeds && it.usd > 0) || (st.dup && i === 1);
            return (
              <article key={i} className={`mg-cc ${err ? "err" : ""}`}>
                <div className="mg-r mg-r1h">
                  <span className="mg-lbl b">Borrow</span>
                  {/* Max Value only in single mode: in dual mode the amount is split 50/50 from leverage. */}
                  {!dual && (
                    <button type="button" className="mg-maxv" aria-label={`Borrow the maximum — set leverage to ${st.max.toFixed(2)}x`} onClick={() => changeLev(st.max)}>
                      Max Value
                    </button>
                  )}
                </div>
                <div className="mg-r">
                  <span className="mg-ddw">
                    <TokenPickButton
                      sym={bTok[i]}
                      className="mg-tok b2"
                      iconClassName="ico mg-ti"
                      chevron={<span className="mg-cv">{MI.chev16}</span>}
                      rows={borrowRows}
                      valueLabel="Available to borrow"
                      onSelect={(s) => {
                        setBTok((t) => (i === 0 ? [s, t[1]] : [t[0], s]));
                        auto();
                      }}
                    />
                  </span>
                  <input
                    className="mg-amt num"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0"
                    value={st.shown[i] ?? ""}
                    aria-invalid={err}
                    aria-label="Borrow amount"
                    onChange={(e) => onBorAmt(i, e.target.value)}
                  />
                </div>
                <div className="mg-r">
                  <RatioBtn sym={bTok[i]} price={pxB(bTok[i])} />
                  <span className="mg-sub num">~ {usd(it.usd)}</span>
                </div>
              </article>
            );
          })}
        </div>
        <div>
          <div className="mg-tot">
            <b className={`num ${st.exceeds ? "err" : ""}`}>Total: {usd(st.totalUsd)}</b>
            <span className="num">Max: {usd(st.maxUsd)}</span>
          </div>
          {st.error && (
            <p className="mg-err" role="alert">
              {st.error}
            </p>
          )}
        </div>
        <div className="mg-levrow">
          <div className="mg-step">
            <button type="button" disabled={st.levE <= 1} aria-label="Decrease leverage" onClick={() => changeLev(Math.max(1, Math.ceil(st.levE) - 1))}>
              −
            </button>
            <span className="num">{Number.isInteger(st.levE) ? st.levE : st.levE.toFixed(2)}</span>
            <button type="button" disabled={st.levE >= st.max} aria-label="Increase leverage" onClick={() => changeLev(Math.floor(st.levE) + 1)}>
              +
            </button>
          </div>
          <div className="mg-slw">
            <LevSlider lev={st.levE} max={MAX_LEVERAGE} onChange={changeLev} />
          </div>
        </div>
      </div>

      {showPrev && (
        <PrevBox>
          <PrevRow label="Account leverage" b={levFmt(b.leverage)} a={levFmt(a.leverage)} tip={TIPS.lev} />
          {dep > 0 && <PrevRow label="You're depositing" b={usd(0)} a={usd(dep)} />}
          {bor > 0 && <PrevRow label="You're borrowing" b={usd(0)} a={usd(bor)} />}
          <PrevRow label="Margin Collateral" b={usd(b.holdings)} a={usd(a.holdings)} tone="up" tip={TIPS.value} />
          {bor > 0 && <PrevRow label="Outstanding Debt" b={usd(b.debt)} a={usd(a.debt)} tone="dn" />}
          <PrevRow label="Health Factor" b={hfFmt(b.hf)} a={hfFmt(a.hf)} tone={toneHf(b.hf, a.hf)} tip={TIPS.hf} />
          <PrevRow label="Liquidation Buffer" b={usd(liqBuffer(b))} a={usd(liqBuffer(a))} tone={liqBuffer(a) >= liqBuffer(b) ? "up" : "dn"} tip={TIPS.buffer} />
        </PrevBox>
      )}

      <div className="mg-cta">
        {warn && (
          <div className="mg-am mg-wn" role="status">
            <span>
              Health factor after this: {hfFmt(a.hf)}, close to the {nf(LIQ_HF, 2)} liquidation line.
            </span>
          </div>
        )}
        <button type="button" className="mg-btn" disabled={disabled} onClick={() => void submit()}>
          {label}
        </button>
      </div>
      {creating && address && <CreateAccountModal address={address} onClose={() => setCreating(false)} />}
    </div>
  );
}
