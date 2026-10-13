"use client";

/**
 * One margin account on its own page (ported from the Solana analytics): who it is, how healthy it is, a
 * what-if slider on its own balances, how it ranks, what it holds and owes, and its recent on-chain events.
 * Everything is read from the chain (the protocol snapshot, or `/api/account/[addr]` for an account outside
 * it); the only maths here is the shared pure helpers (lib/analytics/v3/model, whatif).
 */
import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { clock, explorerUrl, finite, hfText, levText, pct, pct1, short, usd } from "@/lib/analytics/v3/format";
import { trailFor, type From } from "@/lib/analytics/v3/links";
import { classify, DISPLAY_BANDS, liquidationPrices, LIQUIDATION_LINE, standingOf, STATUS_LABEL, type AccountRow, type Standing } from "@/lib/analytics/v3/model";
import { simulateAccount } from "@/lib/analytics/v3/whatif";
import { priceKey } from "@/lib/account-model";
import { CollateralDebt, MarginBreakdown } from "../accounts-monitor";
import { Sparkline } from "../charts";
import { useAccountRow, useAnalyticsData, useLiveEventFeed, useYou } from "../data";
import { Addr, Badge, Empty, Icon, InfoTip, Kpi, Panel, StatusBadge, statusTone, When, YouPill } from "../ui";

/** An asset priced within this of $1 is treated as a stable coin: a slider on it would say nothing. */
const STABLE_BAND = 0.03;
const SLIDER_RANGE = 50;

function Crumbs({ from, current }: { from: From; current: string }) {
  return (
    <nav className="an-crumbs" aria-label="Breadcrumb">
      {trailFor(from).map((c) => (
        <Fragment key={c.label}><Link href={c.href}>{c.label}</Link><span className="an-crumb-sep" aria-hidden="true">›</span></Fragment>
      ))}
      <span className="an-crumb-current" aria-current="page">{current}</span>
    </nav>
  );
}

export function AccountPage({ address, from }: { address: string; from: From }) {
  const { wallet, margin } = useYou();
  const data = useAnalyticsData();
  const { row, inList, isLoading, error, notFound } = useAccountRow(address, data);

  if (!row) {
    return (
      <>
        <Crumbs from={from} current={short(address, 5, 5)} />
        {isLoading || (!notFound && !error)
          ? <Empty title="Loading account…" text="Reading it from Soroban." />
          : <Empty title="Account not found" text={error ?? "No open Vanna margin account was found for this address."} icon="search">
              <p><Link className="an-btn an-sm" href={trailFor(from)[0].href}>Back to {trailFor(from)[0].label}</Link></p>
            </Empty>}
      </>
    );
  }

  const standing = inList && data.rows ? standingOf(data.rows, row) : null;
  const mine = row.address === margin || (!!wallet && row.owner === wallet);
  const hasDebt = row.debtUsd > 0;
  const who = row.owner || row.address;

  return (
    <>
      <Crumbs from={from} current={short(who, 5, 5)} />

      <section className="an-panel an-acct-head">
        <div className="an-acct-id">
          <div className="an-eyebrow">Margin account</div>
          <h1 className="an-acct-title" title={who}>{short(who, 5, 5)}<YouPill value={who} /></h1>
          <div className="an-acct-line">
            <span className="an-muted">Margin account</span><Addr value={row.address} head={5} tail={5} /><StatusBadge row={row} />
          </div>
          <div className="an-acct-line an-muted">
            <span>Owner wallet</span><Addr value={row.owner} head={5} tail={5} />
            <span>· read at {clock(row.readAt)}</span>
          </div>
        </div>
        <a className="an-btn an-sm" href={explorerUrl("contract", row.address)} target="_blank" rel="noreferrer">View on explorer ↗</a>
      </section>

      {mine
        ? <div className="an-acct-banner an-mine">
            <div><b>This is your account.</b>{hasDebt && row.bufferPct !== null && !row.liquidatable && <> It is {pct1(row.bufferPct)} of its collateral value away from liquidation.</>}{row.liquidatable && <> It is already below the liquidation line.</>}</div>
            <Link className="an-btn an-sm" href="/margin">Add collateral or repay on the Margin page →</Link>
          </div>
        : <div className="an-acct-banner">
            <div><b>You are viewing {wallet ? "another user's account" : "a Vanna margin account"}.</b> <span className="an-muted">Everything here is public on-chain data and read-only. Only the owner can act on it.</span></div>
          </div>}

      <div className="an-kpi-grid an-cols-6">
        <Kpi label="Health" tip="health" value={row.healthFactor === null ? "No debt" : hfText(row.healthFactor)} tone={row.liquidatable ? "danger" : statusTone(row.status) === "warn" ? "warn" : ""} sub={hasDebt ? `Liquidated at ${LIQUIDATION_LINE.toFixed(2)}` : "Nothing owed"} />
        <Kpi label="Leverage" value={levText(row.leverage)} na={row.leverage === null} sub="Account value ÷ own money" />
        <Kpi label="Account value" tip="accountValue" value={usd(row.collateralUsd)} sub="Everything it holds" />
        <Kpi label="Debt" value={usd(row.debtUsd)} sub={row.debts.length ? `${row.debts.map((d) => d.symbol).join(", ")} · ${row.debts.map((d) => pct(d.borrowApr)).join(", ")} APR` : "No borrowing"} />
        <Kpi label="Own money" value={usd(row.equityUsd)} tone={row.equityUsd < 0 ? "danger" : ""} sub="Value minus debt" />
        <Kpi label="Room before liquidation" tip="buffer" value={row.liquidatable ? "None" : row.bufferPct === null ? "-" : pct1(row.bufferPct)} na={!row.liquidatable && row.bufferPct === null} tone={row.liquidatable ? "danger" : ""} sub={row.bufferUsd !== null && !row.liquidatable ? usd(row.bufferUsd) : row.liquidatable ? "Already below the line" : ""} />
      </div>

      <div className="an-grid-main">
        <Scenario row={row} prices={data.prices} />
        <StandingPanel row={row} standing={standing} />
      </div>

      <section className="an-panel">
        <div className="an-panel-head"><div><h2 className="an-panel-title">Collateral and debt</h2><p className="an-panel-sub">What the account holds and what it owes</p></div></div>
        <div className="an-acct-stack">
          <MarginBreakdown row={row} />
          <CollateralDebt row={row} />
        </div>
      </section>

      <Activity row={row} />
    </>
  );
}

// ---- what if the price moves ----------------------------------------------------------------------
function Scenario({ row, prices }: { row: AccountRow; prices: Record<string, number | null> }) {
  const [pick, setPick] = useState<string | null>(null);
  const [change, setChange] = useState(0);
  const movable = useMemo(() => {
    const exposure = new Map<string, number>();
    for (const l of row.collateral) if (l.kind !== "lp") exposure.set(l.underlying, (exposure.get(l.underlying) ?? 0) + l.usd);
    for (const d of row.debts) exposure.set(priceKey(d.symbol), (exposure.get(priceKey(d.symbol)) ?? 0) + d.usd);
    return [...exposure].filter(([s]) => { const p = prices[s]; return finite(p) && Math.abs(p - 1) > STABLE_BAND; }).sort((a, b) => b[1] - a[1]).map(([s]) => s);
  }, [row, prices]);

  if (row.debtUsd <= 0) return <Panel title="If the price moves" sub="Needs an account with debt"><p className="an-muted">This account owes nothing, so a price move cannot put it at risk of liquidation.</p></Panel>;
  if (!movable.length) return <Panel title="If the price moves" sub="Not available for this account"><p className="an-muted">It holds and owes only assets priced at about $1 (or LP positions, valued as a whole), so a price move says nothing here.</p></Panel>;

  const symbol = pick && movable.includes(pick) ? pick : movable[0];
  const now = prices[symbol] as number;
  const run = simulateAccount({ owner: row.owner, address: row.address, collateral: row.collateral, debts: row.debts }, { [symbol]: change });
  const r = run.result;
  const status = classify({ collateralUsd: r.collateral, debtUsd: r.debt, healthFactor: r.health, liquidatable: r.eligible });
  const marker = r.health === null ? 100 : Math.min(100, Math.max(0, (r.health - 1) * 100));
  const liq = liquidationPrices(row, prices).find((l) => l.symbol === symbol);
  const room = r.debt > 0 && r.collateral > 0 ? Math.max(0, 1 - (LIQUIDATION_LINE * r.debt) / r.collateral) : null;

  return (
    <Panel title="If the price moves" sub="Drag to move the price. Worked out in your browser from this account's own balances; nothing is sent anywhere."
      actions={movable.length > 1 ? <div className="an-seg" role="group" aria-label="Asset to move">{movable.slice(0, 5).map((s) => <button key={s} aria-pressed={s === symbol} onClick={() => { setPick(s); setChange(0); }}>{s}</button>)}</div> : <Badge tone="warn">Simulated</Badge>}>
      <div className="an-hmeter" role="img" aria-label={`Health ${hfText(r.health)} on a scale from 1.00 to 2.00, liquidation at ${LIQUIDATION_LINE.toFixed(2)}`}>
        <i className="an-hmeter-line" style={{ left: `${(LIQUIDATION_LINE - 1) * 100}%` }} />
        <i className="an-hmeter-mark" style={{ left: `${marker}%` }}><span>{hfText(r.health)}</span></i>
        <span className="an-hmeter-tick" style={{ left: "0%" }}>1.00</span>
        <span className="an-hmeter-tick an-liq" style={{ left: `${(LIQUIDATION_LINE - 1) * 100}%` }}>{LIQUIDATION_LINE.toFixed(2)} liquidation</span>
        <span className="an-hmeter-tick" style={{ left: `${(DISPLAY_BANDS.warning - 1) * 100}%` }}>{DISPLAY_BANDS.warning.toFixed(2)}</span>
        <span className="an-hmeter-tick" style={{ left: "100%" }}>2.00</span>
      </div>
      <div className="an-scn-row">
        <div><span className="an-scn-price">{usd(now * (1 + change / 100))}</span> <span className="an-muted">{symbol} price{change !== 0 ? ` (now ${usd(now)})` : ""}</span></div>
        <Badge tone={statusTone(status)}>{STATUS_LABEL[status]}</Badge>
      </div>
      <input type="range" className="an-range" min={-SLIDER_RANGE} max={SLIDER_RANGE} step={1} value={change} onChange={(e) => setChange(Number(e.target.value))} aria-label={`Change in ${symbol} price`} />
      <div className="an-scn-scale an-muted"><span>−{SLIDER_RANGE}%</span><span>{change === 0 ? "0% (now)" : `${change > 0 ? "+" : "−"}${Math.abs(change)}%`}</span><span>+{SLIDER_RANGE}%</span></div>
      <div className="an-mini-stats">
        <div><span className="an-k">Account value</span><span className="an-v">{usd(r.collateral)}</span></div>
        <div><span className="an-k">Own money</span><span className="an-v">{usd(r.equity)}</span></div>
        <div><span className="an-k">Room before liquidation</span><span className="an-v">{room === null ? "-" : pct1(room)}</span></div>
      </div>
      <p className="an-panel-foot" style={{ padding: 0 }}>
        {liq ? <>Liquidation happens if {symbol} {liq.direction === "down" ? "falls" : "rises"} to <b>{usd(liq.price)}</b> ({liq.change >= 0 ? "+" : "−"}{pct1(Math.abs(liq.change))}), all else equal.</> : <>No move of {symbol} alone reaches the liquidation line.</>} Interest and liquidations actually happening are not modelled.
      </p>
    </Panel>
  );
}

// ---- where it stands -------------------------------------------------------------------------------
function StandingPanel({ row, standing }: { row: AccountRow; standing: Standing | null }) {
  const fact = (k: React.ReactNode, v: React.ReactNode) => <div><dt>{k}</dt><dd>{v}</dd></div>;
  return (
    <Panel title="Where it stands" sub="Compared with every other open margin account">
      {standing ? (
        <dl className="an-kv">
          {fact("Debt rank", standing.debtRank ? `#${standing.debtRank} of ${standing.borrowers} with debt` : "No debt")}
          {fact("Share of all debt", standing.debtShare !== null ? pct1(standing.debtShare) : "-")}
          {fact(<>Closest to liquidation <InfoTip k="buffer" /></>, standing.healthRank ? `#${standing.healthRank} of ${standing.borrowers}` : "-")}
          {fact("Health, recent readings", <Sparkline w={110} values={row.hfTrend} label="Health factor readings" color="var(--c2)" />)}
        </dl>
      ) : <p className="an-muted">This account is not in the protocol-wide snapshot yet, so it can&apos;t be ranked. Its own figures above are read directly from the chain.</p>}
      <p className="an-panel-foot" style={{ padding: 0 }}>Readings are this browser&apos;s own, one per refresh while the app is open. They are not chain history.</p>
    </Panel>
  );
}

// ---- recent on-chain events ----------------------------------------------------------------------------
function Activity({ row }: { row: AccountRow }) {
  const { data, isLoading, error } = useLiveEventFeed();
  const ids = new Set([row.address, row.owner].filter(Boolean));
  const items = [
    ...(data?.whaleActivity ?? []).filter((e) => ids.has(e.account)).map((e) => ({ key: `${e.txHash}-${e.action}-${e.timestamp}`, title: e.details, tone: e.action === "INCREASE_LEVERAGE" || e.action === "WITHDRAW" ? "warn" : e.action === "OPEN_POSITION" ? "accent" : "ok", time: e.timestamp, tx: e.txHash, usd: e.amountUsd })),
    ...(data?.liquidations ?? []).filter((e) => ids.has(e.account)).map((e) => ({ key: `${e.txHash}-liq`, title: "Liquidated", tone: "danger", time: e.timestamp, tx: e.txHash.startsWith("live-") ? "" : e.txHash, usd: 0 })),
  ].sort((a, b) => b.time - a.time);
  return (
    <section className="an-panel an-flush">
      <div className="an-panel-head"><div><h2 className="an-panel-title">Recent activity</h2><p className="an-panel-sub">AccountManager and lending-pool events for this account from the last ~24 hours of ledgers · older ones are not shown</p></div></div>
      {isLoading ? <Empty title="Reading events…" text="This can take a few seconds." />
        : error ? <Empty title="Activity can't be read right now" text="The account itself is shown above. Try again in a moment." />
        : items.length === 0 ? <Empty title="No recent events" text="None of the events in the last ~24 hours touched this account." />
        : <div className="an-feed">{items.map((i) => (
          <div className="an-feed-item" key={i.key}>
            <div className={`an-feed-icon an-${i.tone}`}><Icon name="activity" /></div>
            <div className="an-feed-main"><b>{i.title}</b><p>{i.usd > 0 ? usd(i.usd) : " "}</p></div>
            <div className="an-feed-meta"><When t={i.time} />{i.tx && <><br /><a href={explorerUrl("tx", i.tx)} target="_blank" rel="noreferrer" className="an-link">Transaction ↗</a></>}</div>
          </div>
        ))}</div>}
    </section>
  );
}
