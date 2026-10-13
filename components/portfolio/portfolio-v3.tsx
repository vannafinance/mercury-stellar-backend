"use client";

/**
 * Portfolio (V3 design, index.html portfolio.js 7974–8514), Stellar: title, three header cards (Net
 * worth, Net earnings, Health factor), Lender | Trader | Balances tabs with their sub-tabs. Every
 * number comes from `usePortfolio()` (on-chain / Mercury reads scoped to the connected wallet).
 * Stellar has no Predict, Perps or Flash repay, so those sub-tabs / buttons are not shown.
 * View state is in-memory only.
 */
import { useState } from "react";
import "./portfolio-v3.css";
import { OPEN_CONNECT_WALLET_EVENT } from "@/lib/assistant/client-tools";
import { Info } from "@/components/v3/ui";
import { hfFmt, hfLabel, levFmt, sUsd, usd } from "@/components/v3/format";
import { hfZone } from "@/lib/account-model";
import { usePortfolio, type Portfolio } from "./use-portfolio";
import { HfBar, TT, sign } from "./pf-ui";
import { LendingPools } from "./lender-pools";
import { TraderMargin } from "./trader-margin";
import { TraderSpot } from "./trader-spot";
import { TraderFarm } from "./trader-farm";
import { Balances } from "./balances";

/* live stat icons (/margin/dollar.png, bag.png, health.png) redrawn as inline SVG */
const IP = {
  dollar: (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="currentColor" />
      <path d="M12 5.2v13.6M15.3 8.7c-.5-1.1-1.8-1.8-3.3-1.8-1.9 0-3.3 1-3.3 2.4 0 3.4 6.7 1.8 6.7 5.3 0 1.5-1.4 2.6-3.4 2.6-1.6 0-3-.8-3.5-2.1" stroke="#fff" strokeWidth="2.1" fill="none" strokeLinecap="round" />
    </svg>
  ),
  bag: (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8.6 7V5.6c0-.9.7-1.6 1.6-1.6h3.6c.9 0 1.6.7 1.6 1.6V7" stroke="currentColor" strokeWidth="2" fill="none" />
      <rect x="2" y="7" width="20" height="14" rx="2.6" fill="currentColor" />
      <path d="M2 13.2h20" stroke="#fff" strokeWidth="1.6" />
      <rect x="10.5" y="11.3" width="3" height="3.8" rx=".7" fill="#fff" />
    </svg>
  ),
  pulse: (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="currentColor" />
      <path d="M4.8 12.6h3.4l2.1-4.6 3.3 8.2 2.1-4.3h3.5" stroke="#fff" strokeWidth="2.1" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

type Tab = "lender" | "trader" | "balances";
type LenderSub = "pools";
type TraderSub = "margin" | "spot" | "farm";
const SUBS = {
  lender: [["pools", "Lending pools"]] as [LenderSub, string, string?][],
  trader: [["margin", "Margin"], ["spot", "Spot"], ["farm", "Farm"]] as [TraderSub, string, string?][],
};

function Card({ ic, label, tip, children, cls = "" }: { ic: React.ReactNode; label: string; tip: string; children: React.ReactNode; cls?: string }) {
  return (
    <section className={`pf-card ${cls}`}>
      <div className="pf-k">
        <span className="pf-ic">{ic}</span>
        <span>{label}</span>
        <Info text={tip} />
      </div>
      {children}
    </section>
  );
}

const Chip = ({ label, v, title }: { label: string; v: number | null; title?: string }) => (
  <span title={title} className={`pf-chip ${v === null ? "" : v > 0.004 ? "pf-ok" : v < -0.004 ? "pf-bad" : ""}`}>
    {label} {sUsd(v ?? 0)}
  </span>
);

/** The three header cards. Disconnected: zeros, as in the design. */
function Header({ p }: { p: Portfolio }) {
  const on = p.connected;
  const T = p.totals;
  const now = p.acct.now;
  const parts: [string, number, string][] = [
    ["Wallet", on ? T.wallet : 0, "w"],
    ["Lending", on ? T.lending : 0, "l"],
    ["Margin equity", on ? T.marginEquity : 0, "m"],
  ];
  const tot = parts.reduce((s, x) => s + Math.max(0, x[1]), 0);
  const hf = now?.hf ?? Infinity;
  const live = Boolean(now) && Number.isFinite(hf) && hf < 100;
  const zone = live ? hfZone(hf) : on ? "z-ok" : "";
  return (
    <div className="pf-hd">
      <Card ic={IP.dollar} label="Net worth" tip={TT.net} cls="pf-nw">
        <div className="pf-big num">{usd(on ? T.net : 0)}</div>
        <div className="pf-split">
          {tot > 0 && parts.map(([, v, c]) => <i key={c} className={`pf-c-${c}`} style={{ width: `${((Math.max(0, v) / tot) * 100).toFixed(2)}%` }} />)}
        </div>
        <div className="pf-parts num">
          {parts.map(([l, v, c]) => (
            <div key={c}>
              <small>
                <span className={`pf-dot pf-c-${c}`} />
                {l}
              </small>
              <b>{usd(v)}</b>
            </div>
          ))}
        </div>
      </Card>
      <Card ic={IP.bag} label="Net earnings" tip={TT.earn}>
        <div className={`pf-big num ${on ? sign(T.netEarnings) : ""}`}>{on ? sUsd(T.netEarnings) : usd(0)}</div>
        <div className="pf-chips num">
          <Chip label="Lending" v={on ? T.lendEarned : 0} />
          <Chip label="Trading" v={on ? T.trading : 0} title={TT.trading} />
        </div>
      </Card>
      <Card ic={IP.pulse} label="Health factor" tip={TT.hf}>
        <div className={`pf-big num ${zone}`}>
          {hfFmt(now ? hf : null)}
          {live && <span className={`pf-pill ${zone}`}>{hfLabel(hf)}</span>}
        </div>
        <HfBar hf={live ? hf : null} />
        <div className="pf-chips num">
          <span className="pf-chip">Borrowed {usd(now?.debt ?? 0)}</span>
          <span className="pf-chip">Leverage {now ? levFmt(now.leverage) : "0.00x"}</span>
          <span className="pf-chip">
            Interest accrued {usd(on ? T.interest : 0)}
            <Info text={TT.interest} />
          </span>
        </div>
      </Card>
    </div>
  );
}

/** Opens the navbar's Connect modal (Freighter / Privy chooser), as the Spot page's Login does. */
const openConnect = () => window.dispatchEvent(new CustomEvent(OPEN_CONNECT_WALLET_EVENT, { detail: { prefer: "modal" } }));

/** The Portfolio page body (wrapped in `.v3 .page` by app/portfolio/page.tsx). */
export function PortfolioV3() {
  const p = usePortfolio();
  const [tab, setTab] = useState<Tab>("lender");
  const [lsub, setLsub] = useState<LenderSub>("pools");
  const [tsub, setTsub] = useState<TraderSub>("margin");
  const cur = tab === "lender" ? lsub : tsub;

  return (
    <div className="pf">
      <h1 className="ptitle pf-title">Portfolio</h1>
      <Header p={p} />
      <div className="pf-side">
        <nav className="pf-tabs" role="tablist" aria-label="Portfolio side">
          {(["lender", "trader", "balances"] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {k === "lender" ? "Lender" : k === "trader" ? "Trader" : "Balances"}
            </button>
          ))}
        </nav>
        {!p.connected ? (
          <div className="pf-login">
            <button type="button" className="pf-login-b" onClick={openConnect}>
              Login
            </button>
          </div>
        ) : tab === "balances" ? (
          <div className="pf-body">
            <Balances p={p} />
          </div>
        ) : (
          <div className="pf-body">
            <div className="pf-subbar">
              <div className="pf-sub" role="tablist" aria-label={tab === "lender" ? "Lender views" : "Trader views"}>
                {SUBS[tab].map(([k, l, b]) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={cur === k}
                    className={cur === k ? "on" : ""}
                    onClick={() => (tab === "lender" ? setLsub(k as LenderSub) : setTsub(k as TraderSub))}
                  >
                    {l}
                    {b && <span className="pf-beta">{b}</span>}
                  </button>
                ))}
              </div>
            </div>
            {tab === "lender" ? (
              <LendingPools p={p} />
            ) : tsub === "margin" ? (
              <TraderMargin p={p} />
            ) : tsub === "spot" ? (
              <TraderSpot p={p} />
            ) : (
              <TraderFarm p={p} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
