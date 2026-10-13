"use client";

/**
 * Positions section of the V3 Margin screen:
 *
 * - Current Positions — the whole cross-collateral account as ONE row (Vanna margin accounts share
 *   one health factor across every deposit, so a debt has no single "owning" deposit): collateral
 *   deposited (gross balance minus same-token debt, so borrowed funds sitting in the account aren't
 *   counted as deposits; farm / LP receipts excluded), borrowed assets with their share of total
 *   debt and an accrued-interest tooltip, account leverage, health factor, interest accrued, and one
 *   Repay per borrowed asset. Same derivation as the previous positions-table.tsx.
 * - Positions History — Mercury margin events merged with the bounded RPC fallback
 *   (`useMarginHistory`), paginated, each linking to its transaction on Stellar Expert.
 *
 * The header chip links to the Farm page with the account's live farm-position count.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { Info } from "@/components/v3/ui";
import { Icon } from "@/components/v3/icons";
import { hfFmt, levFmt, timeFmt, tokFmt } from "@/components/v3/format";
import { hfZone } from "@/lib/account-model";
import { isTrackingSymbol } from "@/lib/analytics/stellar/canon";
import { buildNetBorrowCashByToken, calculateAccruedBorrowInterest } from "@/lib/margin-position-attribution";
import { formatUsdValue } from "@/lib/utils/format-amount";
import { useMarginHistory } from "@/hooks/use-margin";
import { LblTip, MI, TIPS } from "./mg-ui";
import { noDebt } from "./mg-sim";
import { ckey, explorerTx, type MarginScreen } from "./use-margin-screen";

// Match the store's USD-denominated dust floor: a repaid loan often leaves a sub-cent residual.
const DUST_USD = 0.01;
const DUST = 1e-6;
const PER_PAGE = 5;
/** "$0.00" for zero, "<$0.01" for sub-cent dust, "$X.XX" otherwise. */
const usdL = (v: number) => formatUsdValue(v);
const detailed = (v: number) => (Number.isFinite(v) ? v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 7 }) : "0");

/** History event → badge class / label. */
const BADGE: Record<string, [string, string]> = {
  deposit: ["deposit", "Deposit"],
  withdraw: ["withdraw", "Withdraw"],
  borrow: ["borrow", "Borrow"],
  repay: ["repay", "Repay"],
};

/** A history row's asset (the Blend tracking symbol BLEND_XLM reads as XLM). */
const histSym = (asset: string) => (asset.toUpperCase() === "BLEND_XLM" ? "XLM" : ckey(asset));

interface Asset {
  sym: string;
  amt: number;
  usd: number;
}
interface Debt extends Asset {
  /** Accrued interest in tokens; null = unknown (opened before indexing). */
  interest: number | null;
}

export function Positions({ m, onRepay, onOpen }: { m: MarginScreen; onRepay: (sym: string) => void; onOpen: () => void }) {
  const [tab, setTab] = useState<"cur" | "hist">("cur");
  const [page, setPage] = useState(1);
  const { history, isLoading: historyLoading } = useMarginHistory();
  const n = m.now;
  const nd = noDebt(n);

  const data = useMemo(() => {
    // ── Deduplicate borrowed tokens by canonical symbol; keep any real (non-zero) debt ──
    const borrowed = new Map<string, { amount: number; usd: number }>();
    for (const [token, bal] of Object.entries(m.borrowedBalances)) {
      const amount = parseFloat(bal.amount || "0");
      if (!(amount > DUST)) continue;
      const k = ckey(token);
      const cur = borrowed.get(k);
      if (!cur || amount > cur.amount) borrowed.set(k, { amount, usd: parseFloat(bal.usdValue || "0") });
    }
    // ── Net deposited collateral per token (gross − same-token debt), receipts excluded ──
    const coll = new Map<string, Asset>();
    let farm = 0;
    for (const [token, bal] of Object.entries(m.collateralBalances)) {
      const grossAmt = parseFloat(bal.amount || "0");
      const grossUsd = parseFloat(bal.usdValue || "0");
      if (isTrackingSymbol(token)) {
        if (grossUsd > DUST_USD) farm += 1;
        continue;
      }
      if (!(grossAmt > DUST) || !(grossUsd > DUST_USD)) continue;
      const k = ckey(token);
      const b = borrowed.get(k);
      const amt = Math.max(0, grossAmt - (b?.amount ?? 0));
      const u = Math.max(0, grossUsd - (b?.usd ?? 0));
      if (!(amt > DUST) || !(u > DUST_USD)) continue;
      const cur = coll.get(k);
      if (!cur || u > cur.usd) coll.set(k, { sym: k, amt, usd: u });
    }
    // ── Interest from Mercury/RPC history: current debt − (Σ borrow − Σ repay); unknown stays null ──
    const netBorrowCash = historyLoading ? new Map<string, number>() : buildNetBorrowCashByToken(history);
    const debts: Debt[] = [...borrowed.entries()]
      .map(([sym, b]) => ({ sym, amt: b.amount, usd: b.usd, interest: historyLoading ? null : calculateAccruedBorrowInterest(b.amount, netBorrowCash.get(sym)) }))
      .sort((a, b) => b.usd - a.usd);
    // Same dust filter for the Borrowed column and its Repay buttons, so they line up 1:1.
    const visible = debts.filter((d) => d.usd >= DUST_USD);
    const totalDebt = visible.reduce((t, d) => t + d.usd, 0);
    const px = (d: Debt) => (d.amt > 0 ? d.usd / d.amt : 0);
    // Interest only counts loans whose principal is known, and only while real (non-dust) debt remains.
    const interestUsd = totalDebt >= DUST_USD ? visible.reduce((t, d) => t + (d.interest && d.interest > 0 ? d.interest * (m.prices[d.sym] ?? px(d)) : 0), 0) : 0;
    return { coll: [...coll.values()].sort((a, b) => b.usd - a.usd), debts, visible, totalDebt, interestUsd, farm, px };
  }, [m.borrowedBalances, m.collateralBalances, m.prices, history, historyLoading]);

  const hist = useMemo(() => history.filter((r) => r.type in BADGE), [history]);
  const pages = Math.max(1, Math.ceil(hist.length / PER_PAGE));
  const pg = Math.min(page, pages);
  const has = m.hasAccount && (data.coll.length > 0 || data.debts.length > 0);

  const asset = (a: Asset, i: number) => (
    <div key={`${a.sym}-${i}`} className="mg-as">
      <Icon sym={a.sym} />
      <div>
        <div className="mg-an num">{tokFmt(a.amt, a.sym)}</div>
        <div className="mg-au num">{usdL(a.usd)}</div>
      </div>
    </div>
  );
  const debtTip = (d: Debt) =>
    d.interest === null
      ? `Total outstanding loan: ${detailed(d.amt)} ${d.sym}. Principal and interest breakdown is unavailable until the original on-chain borrow is indexed.`
      : `Net borrowed amount: ${detailed(Math.max(0, d.amt - d.interest))} ${d.sym}. Interest accrued till date: ${detailed(d.interest)} ${d.sym} (≈ ${usdL(d.interest * data.px(d))}). Total outstanding loan: ${detailed(d.amt)} ${d.sym}.`;
  const debtCell = data.visible.length ? (
    data.visible.map((d) => {
      const sh = data.totalDebt > 0 ? Math.round((d.usd / data.totalDebt) * 100) : 0;
      return (
        <div key={d.sym} className="mg-as">
          <Icon sym={d.sym} />
          <div>
            <div className="mg-an num">
              {tokFmt(d.amt, d.sym)} <Info text={debtTip(d)} />
            </div>
            <div className="mg-au num">
              {usdL(d.usd)}
              {sh > 0 && <span className="mg-shp num">{sh}%</span>}
            </div>
          </div>
        </div>
      );
    })
  ) : (
    <span className="mg-mut">$0</span>
  );
  // No deposited collateral but debt outstanding: the loan is backed by the whole account (e.g. funds
  // deployed into farm positions) — say so instead of a misleading "$0".
  const collCell = data.coll.length ? data.coll.map(asset) : data.visible.length ? <span className="mg-mut">Portfolio · cross-collateral</span> : <span className="mg-mut">$0</span>;
  const hfCell = <span className={nd ? "z-ok" : hfZone(n.hf)}>{hfFmt(n.hf)}</span>;
  const intr = data.visible.length ? usdL(data.interestUsd) : "$0.00";
  const repayBtns = data.visible.length ? (
    data.visible.map((d) => (
      <button key={d.sym} type="button" className="mg-rp" aria-label={`Repay ${d.sym}`} onClick={() => onRepay(d.sym)}>
        Repay <Icon sym={d.sym} className="ico mg-rp-i" />
      </button>
    ))
  ) : (
    <button type="button" className="mg-rp" disabled>
      Repay
    </button>
  );

  const cur = (
    <>
      <div className="mg-tbl">
        <div className="mg-thr" role="row">
          <span>Collateral Deposited</span>
          <span>
            <LblTip k="Borrowed Assets" tip={TIPS.borrowed} />
          </span>
          <span>
            <LblTip k="Leverage Taken" tip={TIPS.lev} />
          </span>
          <span>
            <LblTip k="Health Factor" tip={TIPS.hf} />
          </span>
          <span>
            <LblTip k="Interest accrued till date" tip={TIPS.interest} />
          </span>
          <span>Action</span>
        </div>
        <div className="mg-tb">
          <div className="mg-tr2">
            <div className="mg-td">{collCell}</div>
            <div className="mg-td">{debtCell}</div>
            <div className="mg-td big num">{levFmt(n.leverage)}</div>
            <div className="mg-td big num">{hfCell}</div>
            <div className="mg-td num">{intr}</div>
            <div className="mg-td">{repayBtns}</div>
          </div>
        </div>
      </div>
      <div className="mg-mob">
        <div className="mg-mc">
          <div className="mg-g2">
            <div>
              <p className="mg-ml">Collateral Deposited</p>
              <div className="mg-col">{collCell}</div>
            </div>
            <div>
              <p className="mg-ml">Borrowed Assets</p>
              <div className="mg-col">{debtCell}</div>
            </div>
          </div>
          <div className="mg-mst">
            <div>
              <p>Leverage</p>
              <p className="num">{levFmt(n.leverage)}</p>
            </div>
            <div>
              <p>Health Factor</p>
              <p className="num">{hfCell}</p>
            </div>
            <div>
              <p>Interest Accrued</p>
              <p className="num">{intr}</p>
            </div>
          </div>
          <div className="mg-mra">{repayBtns}</div>
        </div>
      </div>
    </>
  );

  const rows = hist.slice((pg - 1) * PER_PAGE, pg * PER_PAGE);
  const badge = (t: string) => <span className={`mg-badge2 ${BADGE[t]?.[0] ?? "deposit"}`}>{BADGE[t]?.[1] ?? t}</span>;
  const tx = (hash: string) =>
    hash ? (
      <a className="mg-tx-l" href={explorerTx(hash)} target="_blank" rel="noopener noreferrer">
        {hash.slice(0, 8)}…{hash.slice(-4)}
      </a>
    ) : (
      <span className="mg-mut">N/A</span>
    );
  const when = (ms: number) => timeFmt(Math.floor((ms || 0) / 1000));
  const pager =
    pages > 1 ? (
      <div className="mg-pg">
        <button type="button" disabled={pg === 1} aria-label="Previous page" onClick={() => setPage(pg - 1)}>
          {MI.prev}
        </button>
        <span className="num">
          {pg} of {pages}
        </span>
        <button type="button" disabled={pg === pages} aria-label="Next page" onClick={() => setPage(pg + 1)}>
          {MI.next}
        </button>
      </div>
    ) : null;
  const histView = (
    <>
      <div className="mg-tbl">
        <div className="mg-thr" role="row">
          {["Date", "Type", "Asset", "Amount", "Tx Hash"].map((h) => (
            <span key={h}>{h}</span>
          ))}
        </div>
        <div className="mg-tb">
          {rows.map((r, i) => {
            const s = histSym(r.asset || "");
            return (
              <div key={`${r.hash}${r.type}${r.asset}${i}`} className="mg-tr2">
                <div className="mg-td mg-dt num">{when(r.timestamp)}</div>
                <div className="mg-td">{badge(r.type)}</div>
                <div className="mg-td">
                  {r.asset ? (
                    <div className="mg-as">
                      <Icon sym={s} />
                      <span className="mg-an">{s}</span>
                    </div>
                  ) : (
                    "N/A"
                  )}
                </div>
                <div className="mg-td num">{tokFmt(parseFloat(String(r.amount ?? "0")) || 0, s, false)}</div>
                <div className="mg-td">{tx(r.hash)}</div>
              </div>
            );
          })}
        </div>
        {pager}
      </div>
      <div className="mg-mob">
        {rows.map((r, i) => {
          const s = histSym(r.asset || "");
          return (
            <div key={`${r.hash}${r.type}${r.asset}${i}`} className="mg-mh">
              <Icon sym={s || "XLM"} />
              <div className="mg-mt">
                <div>
                  {badge(r.type)}
                  <span className="num">{tokFmt(parseFloat(String(r.amount ?? "0")) || 0, s)}</span>
                </div>
                <small className="num">{when(r.timestamp)}</small>
              </div>
              {tx(r.hash)}
            </div>
          );
        })}
        {pager}
      </div>
    </>
  );

  return (
    <section className="mg-pos" id="mg-pos">
      <div className="mg-ph">
        <div className="mg-pt">
          <h2>Positions</h2>
          {has && <span className="mg-cnt num">1</span>}
        </div>
        {data.farm > 0 && (
          <div className="mg-pa">
            <Link href="/farm" className="mg-oc" aria-label="Open Farm">
              Farm <b className="num">{data.farm}</b>
            </Link>
          </div>
        )}
      </div>
      <nav className="mg-ptabs" role="tablist">
        {(
          [
            ["cur", "Current Positions", "Current"],
            ["hist", "Positions History", "History"],
          ] as const
        ).map(([k, l, s]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={tab === k ? "on" : ""}
            onClick={() => {
              setTab(k);
              setPage(1);
            }}
          >
            <span className="mg-s">{s}</span>
            <span className="mg-l">{l}</span>
          </button>
        ))}
      </nav>
      {tab === "hist" ? (
        hist.length ? (
          histView
        ) : (
          <section className="mg-empty">
            <p>{historyLoading ? "Loading transaction history…" : "No transaction history"}</p>
          </section>
        )
      ) : has ? (
        cur
      ) : (
        <section className="mg-empty">
          <button type="button" className="mg-ghost" onClick={onOpen}>
            Open Position
          </button>
        </section>
      )}
    </section>
  );
}
