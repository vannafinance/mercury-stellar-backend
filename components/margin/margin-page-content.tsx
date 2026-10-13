"use client";

import "./margin-v3.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Banner } from "@/components/v3/ui";
import { hfFmt, levFmt, usdC } from "@/components/v3/format";
import { LIQ_HF, hfZone } from "@/lib/account-model";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useMarginScreen } from "./use-margin-screen";
import { liqBuffer, noDebt } from "./mg-sim";
import { LblTip, MI, SIC, TIPS } from "./mg-ui";
import { LeverageTab } from "./mg-leverage";
import { RepayTab, toDropdownAsset } from "./mg-repay";
import { TransferTab } from "./mg-transfer";
import { RightColumn } from "./mg-right";
import { Positions } from "./mg-positions";

interface MarginPageContentProps {
  /** Path this page lives at — the ?repay=<asset> hand-off is stripped back to it. */
  basePath: string;
}

type Tab = "lev" | "repay" | "transfer";
const TABS: [Tab, string, string][] = [
  ["lev", "Leverage your Assets", "Leverage"],
  ["repay", "Repay Loan", "Repay"],
  ["transfer", "Transfer Collateral", "Transfer"],
];

/**
 * The Stellar margin page, V3 design: liquidation-risk banner, promo carousel, account stats strip,
 * the Leverage / Repay / Transfer panel, Margin Account Info + Liquidation + Oracles, and the
 * positions section.
 *
 * Health factor, leverage, liquidation buffer and every before → after preview come from the
 * RiskEngine-exact account model (`useV3Account`, lib/account-model.ts: HF = Σ collateral / Σ debt,
 * unweighted, liquidatable at ≤ 1.10). Per-token balances, debts and the borrow rate come from the
 * per-account `/api/account/[addr]` snapshot (`useAccountSnapshot`), fed into the margin store here so
 * every consumer reads the same numbers; mutations refresh the store directly
 * (`refreshBorrowedBalances`). Nothing is persisted.
 *
 * useSearchParams() opts the page out of static prerendering, so callers wrap this in a Suspense
 * boundary.
 */
export const MarginPageContent = ({ basePath }: MarginPageContentProps) => {
  const searchParams = useSearchParams();
  const router = useRouter();
  const m = useMarginScreen();
  const [tab, setTab] = useState<Tab>("lev");
  const [prefill, setPrefill] = useState<{ sym: string; n: number } | undefined>(undefined);
  const [errorDismissed, setErrorDismissed] = useState<string | null>(null);
  const topRef = useRef<HTMLHeadingElement>(null);

  const scrollToPanel = useCallback(() => {
    setTimeout(() => topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }, []);

  /** Positions-row Repay / Portfolio hand-off: open the Repay tab on that asset. */
  const openRepay = useCallback(
    (sym?: string) => {
      setTab("repay");
      const s = toDropdownAsset(sym);
      if (s) setPrefill((p) => ({ sym: s, n: (p?.n ?? 0) + 1 }));
      scrollToPanel();
    },
    [scrollToPanel],
  );

  // Portfolio's per-asset Repay button hands off here via ?repay=<asset> (it has no Repay UI of its
  // own) — consume it once on arrival, then strip it from the URL so a manual refresh doesn't
  // re-trigger the tab switch.
  useEffect(() => {
    const repayAsset = searchParams.get("repay");
    if (repayAsset !== null) {
      openRepay(repayAsset || undefined);
      router.replace(basePath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // D25: per-user stats come from the cached /api/account/[addr] snapshot — instant first paint on
  // a warm edge cache, and the ledger-tick revalidation is absorbed by the route's 15s s-maxage.
  // The snapshot is fed into the store so every consumer stays unchanged. The imperative client read
  // (refreshBorrowedBalances) is the mutation / cache-miss fallback only.
  const { snapshot } = m;
  useEffect(() => {
    if (!snapshot) return;
    const store = useMarginAccountInfoStore.getState();
    if (snapshot.hasMarginAccount && snapshot.marginAccountAddress) {
      // Don't let a degraded snapshot (no collateral) overwrite collateral the store already holds
      // — the single-source-of-truth guarantee. If this read shows zero collateral but we already
      // had some, update only the debt side and PRESERVE the collateral/health; a later good read
      // reconciles. This guard only applies to repeated reads of the SAME account — a snapshot for
      // a DIFFERENT account (a just-switched wallet, or a freshly created margin account) must
      // always win in full, even at zero.
      const sameAccount = store.marginAccountAddress === snapshot.marginAccountAddress;
      const snapGross = snapshot.grossCollateralValue ?? 0;
      const degraded = sameAccount && snapGross <= 0.01 && (store.grossCollateralValue ?? 0) > 0.01;
      store.set({
        hasMarginAccount: true,
        marginAccountAddress: snapshot.marginAccountAddress,
        borrowedBalances: snapshot.borrowedBalances ?? {},
        totalBorrowedValue: snapshot.totalBorrowedValue ?? 0,
        totalValue: snapshot.totalValue ?? 0,
        borrowRate: snapshot.borrowRate ?? 0,
        isLoadingBorrowedBalances: false,
        ...(degraded
          ? {}
          : {
              collateralBalances: snapshot.collateralBalances ?? {},
              totalCollateralValue: snapshot.totalCollateralValue ?? 0,
              grossCollateralValue: snapGross,
              avgHealthFactor: snapshot.avgHealthFactor ?? 0,
              collateralLeftBeforeLiquidation: snapshot.collateralLeftBeforeLiquidation ?? 0,
              netAvailableCollateral: snapshot.netAvailableCollateral ?? 0,
              debtLimit: snapshot.debtLimit ?? 0,
            }),
      });
    } else if (snapshot.hasMarginAccount === false) {
      store.set({ hasMarginAccount: false });
    }
  }, [snapshot]);

  const n = m.now;
  const nd = noDebt(n);
  const on = m.connected && m.hasAccount;
  const danger = on && !nd && n.hf <= LIQ_HF;
  const dash = m.loading;
  const err = m.snapshotError && m.snapshotError !== errorDismissed ? m.snapshotError : null;

  const stats: [React.ReactNode, string, React.ReactNode, string][] = [
    [SIC.health, "Net Health Factor", <span key="h" className={nd ? "z-ok" : hfZone(n.hf)}>{dash || nd ? "No debt" : hfFmt(n.hf)}</span>, TIPS.hf],
    [SIC.liq, "Collateral Left Before Liquidation", dash ? usdC(0) : nd ? <span className="z-ok">No debt</span> : usdC(liqBuffer(n)), TIPS.buffer],
    [SIC.dollar, "Net Available Collateral", usdC(dash ? 0 : n.equity), TIPS.equity],
    [SIC.retry, "Net amount Borrowed", usdC(dash ? 0 : n.debt), TIPS.borrowed],
    [SIC.bag, "Net Leverage Taken", levFmt(dash ? 0 : n.leverage), TIPS.lev],
  ];

  return (
    <main className="v3">
      <div className="page mg">
        {err && (
          <div className="mg-am" role="alert" style={{ marginBottom: 16 }}>
            <span>{err}</span>
            <span className="mg-am-a">
              <button type="button" onClick={() => setErrorDismissed(err)}>
                Dismiss
              </button>
            </span>
          </div>
        )}
        {danger && (
          <div className="mg-dg" role="alert">
            {MI.alert}
            <div>
              <b>Liquidation Risk — Health Factor {hfFmt(n.hf)} (at or below 1.10)</b>
              <p>Your account is undercollateralised and can be liquidated by anyone. Repay debt or add collateral immediately to restore your Health Factor above 1.1.</p>
            </div>
          </div>
        )}
        <div className="mg-bnw">
          <Banner page="margin" />
        </div>
        {m.connected && (
          <section className="mg-stats">
            {stats.map(([ic, k, v, t]) => (
              <article key={k}>
                <div className="mg-sh">
                  <span className="mg-si">{ic}</span>
                  <span className="mg-sk">
                    <LblTip k={k} tip={t} />
                  </span>
                </div>
                <div className="mg-sv num">{v}</div>
              </article>
            ))}
          </section>
        )}
        <section className="mg-main">
          <h1 className="mg-h1" ref={topRef}>
            Leverage your Collateral
          </h1>
          <div className="mg-cols">
            <div className="mg-left">
              <section className="mg-panel">
                <nav className="mg-tabs" role="tablist" aria-label="Margin actions">
                  {TABS.map(([k, l, s]) => (
                    <button key={k} type="button" role="tab" aria-selected={tab === k} className={`mg-tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>
                      <span className="mg-l">{l}</span>
                      <span className="mg-s">{s}</span>
                    </button>
                  ))}
                </nav>
                <section className="mg-tc">
                  {tab === "lev" ? <LeverageTab m={m} /> : tab === "repay" ? <RepayTab m={m} prefill={prefill} onTransfer={() => setTab("transfer")} /> : <TransferTab m={m} />}
                </section>
              </section>
            </div>
            <aside className="mg-right">
              <RightColumn m={m} />
            </aside>
          </div>
          {m.connected && (
            <Positions
              m={m}
              onRepay={openRepay}
              onOpen={() => {
                setTab("lev");
                scrollToPanel();
              }}
            />
          )}
        </section>
      </div>
    </main>
  );
};
