"use client";

/** Liquidations: who can be liquidated now, how close others are, what has been liquidated, and the line behind it. */
import Link from "next/link";
import { LIQUIDATION_LINE, sortRows } from "@/lib/analytics/v3/model";
import { hfText, pct1, short, usd } from "@/lib/analytics/v3/format";
import { accountHref } from "@/lib/analytics/v3/links";
import { AccountsMonitor } from "../accounts-monitor";
import { HBars, Legend, StackBar, TONE_VAR } from "../charts";
import { useAnalyticsData, useLiveEventFeed } from "../data";
import { Addr, Empty, Kpi, Notice, Panel, When, YouPill } from "../ui";
import { ViewHead } from "../shell";

const WAIT = "Waiting for accounts";

function Closest() {
  const d = useAnalyticsData();
  const rows = sortRows((d.rows ?? []).filter((r) => r.debtUsd > 0), "buffer", 1).slice(0, 6);
  return (
    <Panel title="Closest to being liquidated" sub="Accounts with debt, riskiest first · a longer bar means more room" tip="buffer">
      {rows.length === 0 ? <Empty title="No account has debt" text="Nothing to rank yet." /> : (
        <HBars rows={rows.map((r) => ({
          key: r.address,
          name: <span title={r.owner || r.address}><Link href={accountHref(r.address, "liquidations")} className="an-acct-link">{short(r.owner || r.address, 4, 4)}</Link><YouPill value={r.owner || r.address} /></span>,
          segments: [{ value: r.bufferPct ?? 0, color: r.liquidatable ? TONE_VAR.danger : r.status === "healthy" ? TONE_VAR.ok : TONE_VAR.warn, tip: `Can lose ${pct1(r.bufferPct)} of its collateral value (${usd(r.bufferUsd)}) before liquidation\nHealth ${hfText(r.healthFactor)}` }],
          valueText: `Health ${hfText(r.healthFactor)}`,
        }))} />
      )}
    </Panel>
  );
}

export function LiquidationsView() {
  const d = useAnalyticsData();
  const { data: ev, isLoading: evLoading } = useLiveEventFeed();
  const s = d.summary;
  const ok = !!s && s.total > 0;
  const liquidated = ev?.liquidations ?? [];
  const rest = ok ? Math.max(0, s!.debtUsd - s!.liquidatableDebtUsd - s!.bufferZoneDebtUsd) : 0;
  const segs = ok ? [
    { label: "Can be liquidated", value: s!.liquidatableDebtUsd, color: "var(--danger-bar)", tip: `Can be liquidated\n${usd(s!.liquidatableDebtUsd)}` },
    { label: `Close to the line (${LIQUIDATION_LINE.toFixed(2)}–1.30)`, value: s!.bufferZoneDebtUsd, color: "var(--warn-bar)", tip: `Health ${LIQUIDATION_LINE.toFixed(2)}–1.30\n${usd(s!.bufferZoneDebtUsd)}` },
    { label: "Safe", value: rest, color: "var(--ok-bar)", tip: `Health above 1.30\n${usd(rest)}` },
  ] : [];

  return (
    <>
      <ViewHead title="Liquidations" blurb="Who can be liquidated now, how close others are, and what has been liquidated." />
      <div className="an-kpi-grid">
        <Kpi label="Can be liquidated now" tip="liquidatable" value={s ? String(s.liquidatableCount) : "-"} na={!s} tone={s && s.liquidatableCount ? "danger" : ""} sub={s ? `Out of ${s.total} accounts` : WAIT} />
        <Kpi label="Liquidatable debt" tip="eligibleDebt" value={s ? usd(s.liquidatableDebtUsd) : "-"} na={!s} sub={s ? `Backed by ${usd(s.liquidatableCollateralUsd)} of collateral` : WAIT} />
        <Kpi label="Bad debt (estimated)" tip="shortfall" value={s ? usd(s.badDebtUsd) : "-"} na={!s} tone={s && s.badDebtUsd > 0 ? "danger" : ""} sub={s ? `${s.underwaterCount} account${s.underwaterCount === 1 ? " owes" : "s owe"} more than ${s.underwaterCount === 1 ? "it holds" : "they hold"}` : WAIT} />
        <Kpi label="Liquidations recorded" tip="coverage" value={ev ? String(liquidated.length) : "-"} na={!ev} sub="Soroban events in the last ~24 hours" />
      </div>

      {s && s.liquidatableCount > 0
        ? <AccountsMonitor band={null} onClearBand={() => undefined} title="Accounts that can be liquidated" fixedFilter="liquidatable" />
        : <Panel title="Accounts that can be liquidated">{s ? <Notice>No account can be liquidated right now. {s.borrowers} of {s.total} accounts have debt, and all are above the liquidation line.</Notice> : <Empty title={WAIT} />}</Panel>}

      <div className="an-grid-2" style={{ alignItems: "start" }}>
        <Closest />
        <Panel title="Debt by risk" sub="How much debt sits close to liquidation" tip="shortfall">
          {!ok ? <Empty title={WAIT} text="This appears once accounts have been read." />
            : s!.debtUsd > 0 ? <><StackBar segments={segs} tall /><div className="an-mt"><Legend items={segs.map((x) => ({ label: `${x.label} · ${usd(x.value)}`, color: x.color }))} /></div></>
            : <Notice><strong>No outstanding debt</strong> among the accounts read.</Notice>}
        </Panel>
      </div>

      <Panel title="Past liquidations" sub="AccountManager liquidation events in the last ~24 hours of ledgers · older history is not covered" flush>
        {liquidated.length ? (
          <div className="an-table-wrap"><table className="an-t">
            <thead><tr><th>When</th><th>Account</th><th>Liquidator</th><th className="an-r">Debt repaid</th><th className="an-r">Collateral</th><th>Transaction</th></tr></thead>
            <tbody>{liquidated.map((e) => (
              <tr key={e.txHash}>
                <td className="an-nowrap"><When t={e.timestamp} /></td>
                <td title={e.account}>{e.account ? <Link href={accountHref(e.account, "liquidations")} className="an-acct-link">{short(e.account, 5, 5)}</Link> : "-"}<YouPill value={e.account} /></td>
                <td>{e.liquidatorAddress ? <Addr value={e.liquidatorAddress} /> : <span className="an-muted" data-tip="The liquidation event does not emit the liquidator." tabIndex={0}>Not emitted</span>}</td>
                <td className="an-r">{e.debtAmount > 0 ? usd(e.debtAmount) : <span className="an-muted">-</span>}</td>
                <td className="an-r">{e.recoveryAmount > 0 ? usd(e.recoveryAmount) : <span className="an-muted">-</span>}</td>
                <td>{e.txHash.startsWith("live-") ? "-" : <Addr value={e.txHash} />}</td>
              </tr>
            ))}</tbody></table></div>
        ) : <Empty title={ev ? "No liquidations in the last ~24 hours" : evLoading ? "Loading…" : "Liquidation events couldn't be read"} text={ev ? "None of the AccountManager events read was a liquidation. Older history is not covered." : "Recent ledgers are still being read."} />}
        {liquidated.length > 0 && <p className="an-panel-foot">The contract&apos;s liquidation event does not emit debt repaid, collateral seized or the liquidator, so those columns stay empty.</p>}
      </Panel>

      <Panel title="Liquidation line" sub={`An account can be liquidated when its health is ${LIQUIDATION_LINE.toFixed(2)} or lower (Risk Engine BALANCE_TO_BORROW_THRESHOLD)`}>
        <p className="an-panel-foot" style={{ padding: 0, margin: 0 }}>Health is total collateral value ÷ total debt value, unweighted. <Link href="/analytics/collateral">See how each asset is priced</Link></p>
      </Panel>
    </>
  );
}
