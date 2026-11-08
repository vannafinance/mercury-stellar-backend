"use client";

/**
 * Supply / Withdraw form (V3 design `formHtml`), inline on the pool page and inside a modal
 * (mobile bottom sheet, and `EarnFormModal` for other screens).
 *
 * Same transactions and checks as the pre-V3 Stellar panels (supply-liquidity-tab-new.tsx and
 * withdraw-liqudity.tsx):
 * - Supply: `useSupplyLiquidity` (`deposit` on the pool's lending contract). The amount is in the
 *   underlying asset; native XLM keeps the wallet's REAL on-chain minimum reserve (base +
 *   subentries, via getXlmMinReserve / maxSpendableXlm) plus a fee buffer back, so a 100% supply
 *   can neither trap the account nor be blocked by a flat over-reserve. BLUSDC / AqUSDC / SoUSDC
 *   read their own wallet balance entry (their fees are paid in XLM, so a full supply is safe).
 * - Withdraw: `useWithdrawLiquidity` (`redeem_vtokens`). The amount is in vToken SHARES (the hook
 *   checks it against the vToken balance); the 100% pill pins to the exact balance string so
 *   float-reformatting drift can't misfire "Insufficient Balance", and partial pills floor to 2dp.
 * Both drive the TransactionProgressModal (showTxStep / showTxSuccess / showTxError) and re-sync
 * positions + pool stats across the short window where simulation still returns pre-tx balances.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/v3/ui";
import { Icon } from "@/components/v3/icons";
import { usd } from "@/components/v3/format";
import { useUserStore } from "@/store/user";
import { usePoolData, useSupplyLiquidity, useUserPositions, useWithdrawLiquidity } from "@/hooks/use-earn";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { showTxStep, showTxSuccess, showTxError } from "@/lib/tx-progress";
import { normalizeSupplyError } from "@/lib/errors/normalize";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";
import { getXlmMinReserve, maxSpendableXlm, XLM_FEE_BUFFER } from "@/lib/xlm-reserve";
import { SV, usePop } from "./earn-ui";
import { fLoc, fP, fXr, shortAddr } from "./earn-format";
import { EARN_POOLS, EARN_PRICE_SYMS, findPool } from "./earn-pools";

const PCTS = [10, 25, 50, 100] as const;

export type EarnMode = "supply" | "withdraw";

/** Floor to 2dp and trim trailing zeros (pill amounts never round UP past the balance). */
const floor2 = (n: number) => (Math.floor(n * 100) / 100).toFixed(2).replace(/\.?0+$/, "");

/**
 * The form. `ctx` "page" switches pools by navigating to /earn/<SYM>; "modal" switches in place.
 */
export function EarnForm({
  symbol,
  ctx = "page",
  initialMode = "supply",
  onSymbol,
  onDone,
}: {
  symbol: string;
  ctx?: "page" | "modal";
  initialMode?: EarnMode;
  onSymbol?: (s: string) => void;
  onDone?: () => void;
}) {
  const router = useRouter();
  const def = findPool(symbol) ?? EARN_POOLS[0];
  const sym = def.sym;
  const [mode, setMode] = useState<EarnMode>(initialMode);
  const [amt, setAmt] = useState("");
  const [pct, setPct] = useState(0);
  const [more, setMore] = useState(false);
  const [lastSym, setLastSym] = useState(sym);
  const pop = usePop();

  // Reset the amount when the pool changes (render-time state sync, no effect needed).
  if (lastSym !== sym) {
    setLastSym(sym);
    setAmt("");
    setPct(0);
  }

  const userAddress = useUserStore((s) => s.address);
  const xlmBalance = useUserStore((s) => s.balance);
  const tokenBalances = useUserStore((s) => s.tokenBalances);
  const supply = useSupplyLiquidity();
  const withdraw = useWithdrawLiquidity();
  const { pools, refresh: refreshPools } = usePoolData();
  const { positions, refresh: refreshPositions } = useUserPositions();
  const oracle = useTokenPrices(EARN_PRICE_SYMS);
  const pool = pools[def.key];
  const price = oracle[def.priceSym] ?? 0;
  const pending = supply.isPending || withdraw.isPending;
  const sup = mode === "supply";

  // Real on-chain XLM minimum reserve (base + subentries) — a flat "keep 1 XLM" either overshoots
  // (blocking a valid 100% supply) or undershoots (trapping the account) depending on how many
  // trustlines the wallet holds.
  const [xlmMinReserve, setXlmMinReserve] = useState(1.5);
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

  // ── balances ──────────────────────────────────────────────────────────────────────────────
  /** Spendable wallet balance of the underlying (supply side). */
  const walletBal = useMemo(() => {
    if (def.key === "XLM") return maxSpendableXlm(parseFloat(xlmBalance) || 0, xlmMinReserve);
    if (def.key === "USDC") return parseFloat(tokenBalances.BLEND_USDC || tokenBalances.USDC || "0") || 0;
    return parseFloat(tokenBalances[def.key] || "0") || 0;
  }, [def.key, xlmBalance, tokenBalances, xlmMinReserve]);
  const vTokenRaw = positions[def.key]?.vTokenBalance || "0";
  const vTokenBalance = parseFloat(vTokenRaw) || 0;
  const a = parseFloat(amt) || 0;

  // ── preview inputs ────────────────────────────────────────────────────────────────────────
  const xr = parseFloat(pool?.exchangeRate || "1") || 1;
  const apy = parseFloat(pool?.supplyAPY || "0") || 0;
  const poolAvail = parseFloat(pool?.availableLiquidity || "0") || 0;
  /** Underlying the withdraw returns (shares × exchange rate). */
  const receive = sup ? 0 : a * xr;
  // Pool can only pay out its idle liquidity; a tiny relative tolerance absorbs the 7-dp
  // exchange-rate rounding so a full exit from an idle pool is never blocked.
  const exceedsLiquidity = !sup && receive > poolAvail * (1 + 1e-6) + 1e-7;

  let btn: string;
  let ok = false;
  if (!userAddress) btn = "Connect Wallet";
  else if (sup) {
    if (supply.isPending) btn = "Supplying...";
    else if (!amt || a <= 0) btn = "Enter Amount";
    else if (a > walletBal) btn = "Insufficient Balance";
    else {
      btn = "Supply Liquidity";
      ok = true;
    }
  } else {
    if (withdraw.isPending) btn = "Withdrawing...";
    else if (!(vTokenBalance > 0)) btn = "No Position";
    else if (!amt || a <= 0) btn = "Enter Amount";
    else if (a > vTokenBalance) btn = "Insufficient Balance";
    else if (exceedsLiquidity) btn = "Exceeds Pool Liquidity";
    else {
      btn = "Withdraw Liquidity";
      ok = true;
    }
  }

  const reset = () => {
    setAmt("");
    setPct(0);
  };
  const clickPct = (x: number) => {
    setPct(x);
    if (sup) {
      // Floor (not round) to 2dp — rounding can nudge the 100% pill slightly ABOVE the true
      // spendable balance and show a false "Insufficient Balance".
      if (walletBal > 0) setAmt(floor2((walletBal * x) / 100));
    } else if (vTokenBalance > 0) {
      // 100% pins to the exact vToken balance string (no float drift past the cap).
      setAmt(x === 100 ? String(vTokenBalance) : floor2((vTokenBalance * x) / 100));
    }
  };
  /**
   * Simulation-based reads can briefly return pre-tx balances right after SUCCESS. Re-sync
   * positions + pool stats across that window so Total Supply / Your Positions catch up on their
   * own (ledger ticks also invalidate, but these guarantee a prompt catch-up).
   */
  const resyncAfter = (delays: number[]) => {
    const resync = () => {
      void refreshPositions();
      void refreshPools();
    };
    resync();
    delays.forEach((ms) => setTimeout(resync, ms));
  };
  const submit = async () => {
    if (!userAddress || !ok) return;
    if (sup) {
      // No proactive "keep a small balance" block: for XLM, `walletBal` already reserves the real
      // on-chain minimum + fee buffer, and BLUSDC/AqUSDC/SoUSDC have no reserve of their own.
      showTxStep(`Supplying ${a} ${sym} to the lending pool`);
      try {
        await supply.mutateAsync({ amount: a, assetType: def.assetType });
        showTxSuccess(`Successfully supplied ${a} ${sym}! You received v${sym} tokens.`);
        reset();
        resyncAfter([500, 1200, 2500]);
        onDone?.();
      } catch (err) {
        showTxError(normalizeSupplyError(err instanceof Error ? err.message : undefined, sym));
      }
    } else {
      // No frontend "100% blocked" guard — the contract decides (full withdrawals are allowed).
      showTxStep(`Withdrawing ${a} v${sym} from the lending pool`);
      try {
        await withdraw.mutateAsync({ amount: a, assetType: def.assetType });
        showTxSuccess(`Successfully withdrew ${sym}! Transaction confirmed.`);
        reset();
        resyncAfter([3000, 6000, 10000, 15000]);
        onDone?.();
      } catch (err) {
        // The mutation already normalizes the contract error (normalizeWithdrawError).
        showTxError(err instanceof Error ? err.message : "Withdraw failed");
      }
    }
  };

  // ── preview ("More Details") ──────────────────────────────────────────────────────────────
  const tok = (n: number, d = 6) => `${fLoc(n, d)} ${sym}`;
  const rows: [string, string][] = sup
    ? [
        [`You Get (v${sym})`, `${fLoc(xr > 0 ? a / xr : 0, 7)} v${sym}`],
        [`${sym} per v${sym}`, fXr(xr)],
        ["Current Supply APY", fP(apy)],
        ["Est. Monthly Earnings (at current APY)", tok((a * apy) / 100 / 12)],
        ["Est. Yearly Earnings (at current APY)", tok((a * apy) / 100)],
      ]
    : [
        [`You Receive (${sym})`, tok(receive)],
        [`Shares Redeemed (v${sym})`, `${fLoc(a, 7)} v${sym}`],
        [`${sym} per v${sym}`, fXr(xr)],
        ["Current Supply APY", fP(apy)],
        ["Pool Available Liquidity", tok(poolAvail)],
      ];

  const balTxt = sup ? `Bal: ${userAddress ? `${fLoc(walletBal, 4)} ${sym}` : `-- ${sym}`}` : `Balance: ${userAddress ? `${fLoc(vTokenBalance, 4)} v${sym}` : `-- v${sym}`}`;
  const popKey = `ftok-${ctx}`;
  const pctBase = sup ? walletBal : vTokenBalance;
  const usdAmt = price > 0 ? (sup ? a : receive) * price : 0;

  return (
    <section className={`earn-fm${ctx === "modal" ? " in-modal" : ""}`} aria-label="Liquidity Management">
      <nav className="earn-btabs fm" aria-label="Liquidity Actions">
        <button
          type="button"
          className={sup ? "on" : ""}
          onClick={() => {
            setMode("supply");
            reset();
          }}
        >
          Supply Liquidity
        </button>
        <button
          type="button"
          className={sup ? "" : "on"}
          onClick={() => {
            setMode("withdraw");
            reset();
          }}
        >
          Withdraw Liquidity
        </button>
      </nav>
      <div className="earn-fin">
        <div className="earn-fr1">
          <div className="earn-ftw" data-earn-pop={popKey}>
            <button type="button" className="earn-ftok" aria-haspopup="listbox" aria-expanded={pop.open === popKey} onClick={() => pop.toggle(popKey)}>
              <Icon sym={sym} className="earn-i20" />
              <span>{sup ? sym : `v${sym}`}</span>
              {SV.chev14}
            </button>
            {pop.open === popKey && (
              <div className="pop earn-pop tok" role="listbox">
                {EARN_POOLS.map((t) => (
                  <button
                    key={t.sym}
                    type="button"
                    className={t.sym === sym ? "on" : ""}
                    role="option"
                    aria-selected={t.sym === sym}
                    onClick={() => {
                      pop.close();
                      if (t.sym === sym) return;
                      if (onSymbol) onSymbol(t.sym);
                      else router.push(`/earn/${t.sym}`);
                    }}
                  >
                    <Icon sym={t.sym} className="earn-i16" />
                    {sup ? t.sym : `v${t.sym}`}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="earn-famt">
            <label className="earn-sr" htmlFor={`earn-amt-${ctx}`}>
              {sup ? "Supply Amount" : "Withdraw Amount (vault shares)"}
            </label>
            <input
              id={`earn-amt-${ctx}`}
              type="text"
              inputMode="decimal"
              placeholder="0"
              autoComplete="off"
              value={amt}
              disabled={pending}
              onChange={(e) => {
                const v = validateAmountChange(e.target.value);
                if (v === null) return;
                setAmt(v);
                setPct(0);
              }}
            />
            <div className="earn-fusd num">~ {usd(usdAmt)}</div>
          </div>
        </div>
        <div className="earn-fr2">
          <div className="earn-pcts">
            {PCTS.map((x) => (
              <button key={x} type="button" className={pct === x ? `on p${x}` : ""} disabled={!userAddress || pending || pctBase <= 0} onClick={() => clickPct(x)}>
                {x}%
              </button>
            ))}
          </div>
          <span
            className="earn-fbal num"
            title={
              sup && userAddress && def.key === "XLM"
                ? `Spendable: ${fLoc(walletBal, 7)} XLM (${fLoc(xlmMinReserve, 7)} XLM minimum reserve + ${XLM_FEE_BUFFER} XLM for fees kept back)`
                : undefined
            }
          >
            {balTxt}
          </span>
        </div>
      </div>
      <article className={`earn-more${more ? " on" : ""}`}>
        <button type="button" className="earn-moreh" aria-expanded={more} onClick={() => setMore((m) => !m)}>
          More Details {SV.chev}
        </button>
        {more && (
          <div className="earn-morel">
            {rows.map(([k, v]) => (
              <div key={k}>
                <span>{k}</span>
                <b className="num">{v}</b>
              </div>
            ))}
          </div>
        )}
      </article>
      <button type="button" className="earn-cta" disabled={!ok || pending} onClick={submit}>
        {btn}
      </button>
      <div className="earn-res">Contract: {shortAddr(def.lendingProtocol)}</div>
    </section>
  );
}

/**
 * The form in a modal (design `EarnAPI.open(sym, mode)`): used by the pool page's mobile sheet and
 * available to other screens (e.g. Portfolio) to supply / withdraw without leaving the page.
 */
export function EarnFormModal({ symbol, mode, onClose }: { symbol: string; mode: EarnMode; onClose: () => void }) {
  const [sym, setSym] = useState((findPool(symbol) ?? EARN_POOLS[0]).sym);
  const def = findPool(sym) ?? EARN_POOLS[0];
  const pool = usePoolData().pools[def.key];
  return (
    <Modal onClose={onClose} className="earn-modal">
      <div className="earn">
        <h2>
          {mode === "supply" ? "Supply" : "Withdraw"} {sym}
        </h2>
        <p className="msub">
          {sym} vault · {fP(parseFloat(pool?.supplyAPY || "0") || 0)} supply APY
        </p>
        <EarnForm symbol={sym} ctx="modal" initialMode={mode} onSymbol={setSym} onDone={onClose} />
      </div>
    </Modal>
  );
}
