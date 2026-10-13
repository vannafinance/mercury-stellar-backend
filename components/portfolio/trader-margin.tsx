"use client";

/**
 * Portfolio → Trader → Margin: the margin stats grid (2 × 4), the health-factor meter and the margin
 * "Positions" table (Current position | Position history). Health maths from `useV3Account()`
 * (RiskEngine-exact: HF = holdings ÷ debt, liquidatable at 1.10); token amounts from the margin
 * store; interest and history from the margin's own events (`useMarginHistory`, Mercury + RPC).
 * The account is cross-collateralised, so it is ONE row listing every collateral and every debt
 * (same rules as components/margin/positions-table.tsx: farm tracking receipts are not collateral
 * rows, and same-token debt sitting in the account is netted out of that token's collateral).
 * Repay hands off to the Margin page (`/margin?repay=<asset>`), which opens its Repay tab.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Info } from "@/components/v3/ui";
import { Icon } from "@/components/v3/icons";
import { hfFmt, levFmt, nf, pct, tokFmt, usd } from "@/components/v3/format";
import { VannaLoader } from "@/components/v3/vanna-loader";
import { LIQ_HF, hfPos, hfZone } from "@/lib/account-model";
import { isTrackingSymbol } from "@/lib/account-snapshot";
import { canonicalMarginPositionToken } from "@/lib/margin-position-attribution";
import type { Portfolio } from "./use-portfolio";
import { HfBar, HistNav, TT, TxCell, when } from "./pf-ui";

/** Debt below this many tokens is gone; collateral below 1¢ is dust (positions-table.tsx rules). */
const DUST = 1e-6;
const DUST_USD = 0.01;

const TYPE_LABEL: Record<string, string> = {
  deposit: "Deposit",
  withdraw: "Withdraw",
  borrow: "Borrow",
  repay: "Repay",
};
const mBadge = (t: string) =>
  /borrow/.test(t) ? "pf-mb-red" : /repay/.test(t) ? "pf-mb-green" : /withdraw/.test(t) ? "pf-mb-amber" : /liquid/.test(t) ? "pf-mb-rose" : "pf-mb-blue";

function Stat({ k, v, tip }: { k: string; v: React.ReactNode; tip: string }) {
  return (
    <div className="pf-ms-c">
      <div className="pf-ms-k">
        {k}
        <Info text={tip} />
      </div>
      <div className="pf-ms-v num">{v}</div>
    </div>
  );
}

export function TraderMargin({ p }: { p: Portfolio }) {
  const router = useRouter();
  const [view, setView] = useState<"cur" | "hist">("cur");
  const { acct, priceOf, store, totals: T } = p;
  const now = acct.now;
  const hf = now?.hf ?? Infinity;
  const live = Boolean(now) && Number.isFinite(hf) && hf < 100;
  const debt = now?.debt ?? 0;
  const holdings = now?.holdings ?? 0;
  const noDebt = !(debt > 0.005);
  // Unweighted HF: value the holdings can lose before holdings ÷ debt hits 1.10.
  const left = Math.max(0, holdings - LIQ_HF * debt);

  const pNow = live ? hfPos(hf) : null;
  const pLiq = hfPos(LIQ_HF);

  // Until the margin account has loaded (`now` null) every figure shows its zero form.
  const cells: [string, React.ReactNode, string][] = [
    ["Total Margin Balance", usd(holdings), TT.value],
    ["Total Collateral Deposited", usd(T.gross), TT.coll],
    ["Total Loan Taken", usd(debt), TT.borrowed],
    ["Cross Account Leverage", levFmt(now?.leverage ?? 0), TT.lev],
    ["Health Factor", live ? <span className={hfZone(hf)}>{hfFmt(hf)}</span> : hfFmt(hf), TT.hf],
    ["Cross Margin Ratio", pct(holdings > 0 ? (debt / holdings) * 100 : 0, 1), TT.ratio],
    ["Collateral Left Before Liquidation", noDebt ? "No debt" : usd(left), TT.left],
    ["Net Borrowed Interest Accrued", usd(T.interest), TT.interest],
  ];

  const { colls, debts } = useMemo(() => {
    // Debts, deduped by canonical symbol (largest leg wins, as the snapshot does).
    const d = new Map<string, { sym: string; amt: number; usd: number }>();
    for (const [raw, b] of Object.entries(store.borrowedBalances)) {
      const amt = parseFloat(b.amount || "0") || 0;
      if (!(amt > DUST)) continue;
      const sym = canonicalMarginPositionToken(raw);
      if (!d.has(sym) || amt > d.get(sym)!.amt) d.set(sym, { sym, amt, usd: parseFloat(b.usdValue || "0") || amt * priceOf(sym) });
    }
    // Collateral, net of same-token debt sitting in the account (borrowed proceeds), farm receipts excluded.
    const c = new Map<string, { sym: string; amt: number; usd: number }>();
    for (const [raw, b] of Object.entries(store.collateralBalances)) {
      if (isTrackingSymbol(raw)) continue;
      const sym = canonicalMarginPositionToken(raw);
      const owed = d.get(sym);
      const amt = Math.max(0, (parseFloat(b.amount || "0") || 0) - (owed?.amt ?? 0));
      const v = Math.max(0, (parseFloat(b.usdValue || "0") || 0) - (owed?.usd ?? 0));
      if (!(amt > DUST) || !(v > DUST_USD)) continue;
      if (!c.has(sym) || v > c.get(sym)!.usd) c.set(sym, { sym, amt, usd: v });
    }
    const byUsd = (a: { usd: number }, b: { usd: number }) => b.usd - a.usd;
    return { colls: [...c.values()].sort(byUsd), debts: [...d.values()].sort(byUsd) };
  }, [store.borrowedBalances, store.collateralBalances, priceOf]);
  const farmUsd = Object.entries(store.collateralBalances)
    .filter(([k]) => isTrackingSymbol(k))
    .reduce((t, [, b]) => t + (parseFloat(b.usdValue || "0") || 0), 0);
  const debtTot = debts.reduce((t, x) => t + x.usd, 0);
  const any = colls.length > 0 || debts.length > 0 || farmUsd > 0.005;
  const repay = (sym?: string) => router.push(sym ? `/margin?repay=${encodeURIComponent(sym)}` : "/margin");

  const hist = p.margin.history;
  const cols = "1.3fr 1.45fr .8fr .85fr 1fr .8fr";
  const hcols = "1fr .9fr .9fr 1.4fr 1fr";

  return (
    <>
      <section className="pf-ms">
        <div className="pf-ms-r">
          {cells.slice(0, 4).map(([k, v, t]) => (
            <Stat key={k} k={k} v={v} tip={t} />
          ))}
        </div>
        <div className="pf-ms-r">
          {cells.slice(4).map(([k, v, t]) => (
            <Stat key={k} k={k} v={v} tip={t} />
          ))}
        </div>
        <div className="pf-liq">
          <div className="pf-liq-m">
            <div className="pf-ms-k">
              Health factor
              <Info text={TT.hf} />
            </div>
            <div className="pf-meter">
              {pNow !== null && (
                <span className="pf-ml pf-ml-t num" style={{ left: `${pNow}%`, transform: `translateX(-${pNow}%)` }}>
                  Now {hfFmt(hf)}
                </span>
              )}
              <HfBar hf={live ? hf : null} />
              <span className="pf-ml pf-ml-b num" style={{ left: `${pLiq}%`, transform: `translateX(-${pLiq}%)` }}>
                Liquidation {nf(LIQ_HF, 2)}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="pf-mp">
        <div className="pf-mh">
          <h2>Positions</h2>
          {any && view === "cur" && <span className="pf-cnt">1</span>}
        </div>
        <div className="pf-tbar">
          <HistNav value={view} onChange={setView} />
        </div>
        {view === "hist" ? (
          !hist.length ? (
            <div className="pf-mempty">{p.margin.isLoading ? <VannaLoader size="block" /> : "No transaction history"}</div>
          ) : (
            <div className="pf-mt">
              <div className="pf-mth" style={{ gridTemplateColumns: hcols }}>
                <span>Date</span>
                <span>Type</span>
                <span>Asset</span>
                <span>Amount</span>
                <span>Tx Hash</span>
              </div>
              {hist.map((r, i) => {
                const sym = r.asset ? canonicalMarginPositionToken(r.asset) : "";
                return (
                  <div key={`${r.hash}-${r.type}-${r.asset}-${i}`} className="pf-mrow" style={{ gridTemplateColumns: hcols }}>
                    <span className="pf-mc pf-mdate" data-l="Date">
                      {when(r.timestamp)}
                    </span>
                    <span className="pf-mc" data-l="Type">
                      <span className={`pf-mb ${mBadge(r.type)}`}>{TYPE_LABEL[r.type] ?? r.type}</span>
                    </span>
                    <span className="pf-mc" data-l="Asset">
                      {sym ? (
                        <>
                          <Icon sym={sym} className="ico pf-i20" />
                          {sym}
                        </>
                      ) : (
                        "None"
                      )}
                    </span>
                    <span className="pf-mc num" data-l="Amount">
                      {sym ? tokFmt(parseFloat(r.amount) || 0, sym) : "0"}
                    </span>
                    <span className="pf-mc" data-l="Tx Hash">
                      <TxCell sig={r.hash} />
                    </span>
                  </div>
                );
              })}
            </div>
          )
        ) : !any ? (
          <div className="pf-mempty">
            <button type="button" className="pf-ghost" onClick={() => router.push("/margin")}>
              Open Position
            </button>
          </div>
        ) : (
          <div className="pf-mt">
            <div className="pf-mth" style={{ gridTemplateColumns: cols }}>
              <span>Collateral Deposited</span>
              <span>Borrowed Assets</span>
              <span>Leverage Taken</span>
              <span>Health Factor</span>
              <span>Interest accrued till date</span>
              <span>Action</span>
            </div>
            <div className="pf-mrow" style={{ gridTemplateColumns: cols }}>
              <div className="pf-mc pf-stack" data-l="Collateral Deposited">
                {colls.map((c) => (
                  <div className="pf-asset" key={c.sym}>
                    <Icon sym={c.sym} className="ico pf-i20" />
                    <div>
                      <b className="num">{tokFmt(c.amt, c.sym)}</b>
                      <small className="num">{usd(c.usd)}</small>
                    </div>
                  </div>
                ))}
                {farmUsd > 0.005 && (
                  <div className="pf-asset">
                    <Icon sym="BLEND" className="ico pf-i20" />
                    <div>
                      <b className="num">Farm positions</b>
                      <small className="num">{usd(farmUsd)}</small>
                    </div>
                  </div>
                )}
                {!colls.length && farmUsd <= 0.005 && <span className="pf-zero">{usd(0)}</span>}
              </div>
              <div className="pf-mc pf-stack" data-l="Borrowed Assets">
                {debts.length ? (
                  debts.map((d) => {
                    const share = debtTot > 0 ? Math.round((d.usd / debtTot) * 100) : 0;
                    return (
                      <div className="pf-asset" key={d.sym}>
                        <Icon sym={d.sym} className="ico pf-i20" />
                        <div>
                          <b className="num">
                            {tokFmt(d.amt, d.sym)}
                            <Info text={`You owe ${tokFmt(d.amt, d.sym)} in total, interest included.`} />
                          </b>
                          <small className="num">{usd(d.usd)}</small>
                        </div>
                        {share > 0 && debts.length > 1 && <span className="pf-share num">{share}%</span>}
                      </div>
                    );
                  })
                ) : (
                  <span className="pf-zero">{usd(0)}</span>
                )}
              </div>
              <div className="pf-mc pf-strong num" data-l="Leverage Taken">
                {levFmt(now?.leverage ?? 0)}
              </div>
              <div className="pf-mc pf-strong num" data-l="Health Factor">
                <span className={live ? hfZone(hf) : ""}>{hfFmt(hf)}</span>
              </div>
              <div className="pf-mc num" data-l="Interest accrued">
                {usd(T.interest)}
              </div>
              <div className="pf-mc pf-stack" data-l="Action">
                {debts.length ? (
                  debts.map((d) => (
                    <button key={d.sym} type="button" className="pf-repay" aria-label={`Repay ${d.sym}`} onClick={() => repay(d.sym)}>
                      Repay <Icon sym={d.sym} className="ico pf-i14" />
                    </button>
                  ))
                ) : (
                  <button type="button" className="pf-repay" disabled>
                    Repay
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
