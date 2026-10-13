"use client";

/** Overview: the few numbers that answer "is anything wrong?", then the accounts, then lending. */
import { useState } from "react";
import Link from "next/link";
import { LIQUIDATION_LINE, type AccountsSummary } from "@/lib/analytics/v3/model";
import { hfText, levText, pct, usd, usdC } from "@/lib/analytics/v3/format";
import { AccountsMonitor, COMPOSITION } from "../accounts-monitor";
import { ColumnChart, Donut, TONE_VAR } from "../charts";
import { useAnalyticsData } from "../data";
import { Badge, Empty, Icon, Kpi, Panel } from "../ui";
import { ViewHead } from "../shell";
import { SCENARIOS } from "./risk-explorer";

const WAIT = "Waiting for accounts";

function HealthPanel({ s, band, onPick }: { s: AccountsSummary | null; band: string | null; onPick: (k: string) => void }) {
  if (!s) return <Panel title="Accounts by health" tip="hfDistribution"><Empty title={WAIT} text="This chart appears once accounts have been read." /></Panel>;
  const items = s.healthBands.map((b) => ({
    key: b.key, label: b.label, value: b.debtUsd, color: TONE_VAR[b.tone], active: !band || band === b.key,
    tip: `Health ${b.label}\nDebt ${usd(b.debtUsd)} · ${b.count} account${b.count === 1 ? "" : "s"}${b.tone === "danger" ? "\nCan be liquidated" : ""}`,
    aria: `${usd(b.debtUsd)} debt, ${b.count} accounts`,
  }));
  return (
    <Panel title="Accounts by health" sub="Debt at each health level · click a bar to filter the table" tip="hfDistribution">
      {s.borrowers === 0
        ? <Empty title="No account has debt" text="Debt appears here once a margin account borrows." />
        : <ColumnChart items={items} yFmt={usdC} ariaLabel="Debt by health factor" divider={{ after: 2, label: `Liquidation line ${LIQUIDATION_LINE.toFixed(2)}` }} onPick={onPick} />}
    </Panel>
  );
}

function CompositionPanel({ s }: { s: AccountsSummary | null }) {
  const comp = s?.composition;
  const total = comp ? comp.held + comp.lending + comp.lp : 0;
  return (
    <Panel title="What collateral is made of" sub="Across all accounts" tip="composition">
      {comp && total > 0 ? (
        <div className="an-comp-box"><div className="an-grid-2 an-comp" style={{ alignItems: "center", gap: 16 }}>
          <Donut segments={COMPOSITION.map(([k, label, color]) => ({ label, value: comp[k], color, tip: `${label}
${usd(comp[k])} · ${pct(comp[k] / total, 1)}` }))} center={["Collateral", usdC(total)]} />
          <div className="an-comp-list">{COMPOSITION.map(([k, label, color]) => (
            <div className="an-comp-row" key={k}>
              <span className="an-row" style={{ gap: 8 }}><i style={{ width: 10, height: 10, borderRadius: 3, background: color, flex: "none" }} /><b>{label}</b></span>
              <span className="an-comp-vals"><span>{usd(comp[k])}</span><span className="an-muted">{pct(comp[k] / total, 1)}</span></span>
            </div>
          ))}</div>
        </div></div>
      ) : <Empty title={s ? "No collateral yet" : WAIT} text="This appears once margin accounts hold collateral." />}
    </Panel>
  );
}

export function OverviewView() {
  const d = useAnalyticsData();
  const [band, setBand] = useState<string | null>(null);
  const s = d.summary;
  const ok = !!s;
  const active = s ? s.total - s.statusCounts.empty : 0;
  const rows = d.pools;
  const t = d.poolTotals;
  const why = !d.poolsLoaded ? "Waiting for the first data load." : rows.length === 0 ? "No lending pool could be read." : `${rows.filter((r) => !r.valued).map((r) => r.symbol).join(", ")} ${rows.filter((r) => !r.valued).length === 1 ? "has" : "have"} no live price yet.`;
  const partial = t?.partial ? <Badge tone="warn">Partial</Badge> : null;
  const tSub = (base: string) => (!t ? why : t.partial ? `Without ${t.excluded.join(", ")} (no live price)` : base);

  return (
    <>
      <ViewHead title="Overview" blurb="Is anything wrong? The key numbers at a glance." />
      <div className="an-kpi-grid">
        <Kpi label="Bad debt (estimated)" tip="shortfall" value={ok ? usd(s!.badDebtUsd) : "-"} na={!ok} tone={ok && s!.badDebtUsd > 0 ? "danger" : ""}
          sub={ok ? (s!.badDebtUsd > 0 ? `${s!.underwaterCount} account${s!.underwaterCount === 1 ? " owes" : "s owe"} more than ${s!.underwaterCount === 1 ? "it holds" : "they hold"}` : "No account owes more than it holds") : WAIT} />
        <Kpi label="Can be liquidated" tip="liquidatable" value={ok ? String(s!.liquidatableCount) : "-"} na={!ok} tone={ok && s!.liquidatableCount ? "danger" : ""}
          sub={ok ? `${usd(s!.liquidatableDebtUsd)} of debt` : WAIT} />
        <Kpi label="Liquidatable debt" tip="eligibleDebt" value={ok ? usd(s!.liquidatableDebtUsd) : "-"} na={!ok}
          sub={ok ? `Backed by ${usdC(s!.liquidatableCollateralUsd)} of collateral` : WAIT} />
        <Kpi label="Accounts at risk / active" tip="accountsAtRisk" value={ok ? `${s!.atRiskCount} / ${active}` : "-"} na={!ok} tone={ok && s!.atRiskCount ? "warn" : ""}
          sub={ok && active > 0 ? `${pct(s!.atRiskCount / active, 1)} of active accounts · ${s!.statusCounts.empty} empty accounts not counted` : ok ? "No active accounts" : WAIT} />
        <Kpi label="Average health" tip="averageHealth" value={ok ? hfText(s!.averageHealth) : "-"} na={!ok || s!.averageHealth === null}
          sub={ok && s!.averageHealth !== null ? `Higher is safer · ${s!.borrowers} account${s!.borrowers === 1 ? "" : "s"} with debt` : ok ? "No account has debt" : WAIT} />
        <Kpi label="Collateral at risk" tip="collateralAtRisk" value={ok ? usdC(s!.atRiskCollateralUsd) : "-"} na={!ok}
          sub={ok ? `${pct(s!.collateralUsd > 0 ? s!.atRiskCollateralUsd / s!.collateralUsd : null, 1)} of collateral · health under 1.50` : WAIT} />
        <Kpi label="Average leverage" tip="averageLeverage" value={ok && s!.averageLeverage !== null ? levText(s!.averageLeverage) : "-"} na={!ok || s!.averageLeverage === null}
          sub={ok ? `Across ${s!.borrowers} account${s!.borrowers === 1 ? "" : "s"} with debt` : WAIT} />
        <Kpi label="Total debt" tip="totalDebt" value={ok ? usdC(s!.debtUsd) : "-"} na={!ok}
          sub={ok ? `Against ${usdC(s!.collateralUsd)} of collateral · ${s!.total} account${s!.total === 1 ? "" : "s"}` : WAIT} />
      </div>
      <AccountsMonitor band={band} onClearBand={() => setBand(null)} />
      <div className="an-grid-2">
        <HealthPanel s={s} band={band} onPick={(k) => setBand((b) => (b === k ? null : k))} />
        <CompositionPanel s={s} />
      </div>
      <div className="an-kpi-grid">
        <Kpi label="Supplied by lenders" tip="supplied" value={t ? usdC(t.supplied) : "-"} na={!t} badge={partial} sub={tSub(`Across ${rows.length} lending pools`)} />
        <Kpi label="Borrowed" tip="borrowed" value={t ? usdC(t.borrowed) : "-"} na={!t} badge={partial} sub={tSub("Owed by borrowers")} />
        <Kpi label="Available to withdraw" tip="cash" value={t ? usdC(t.cash) : "-"} na={!t} badge={partial} sub={tSub("Cash left in the pools")} />
        <Kpi label="Borrowed share" tip="ratio" value={t?.ratio != null ? pct(t.ratio) : "-"} na={t?.ratio == null} badge={partial}
          sub={t && t.maxUtilizationSymbol ? `Busiest pool: ${t.maxUtilizationSymbol} at ${pct(t.maxUtilization)}` : why} />
      </div>
      <Panel title="Test a price drop" sub="See which accounts would be affected if prices fall. Nothing is sent to the chain."
        actions={<Link className="an-btn an-gradient" href="/analytics/what-if">Open What-if Calculator <Icon name="arrow" /></Link>} />
      <Panel title="Stress-test scenarios" sub={`${SCENARIOS.length} modelled scenarios for the Stellar deployment: XLM crashes, USDC depegs, Reflector outages, LP impermanent loss and more.`}
        actions={<Link className="an-btn" href="/analytics/risk-explorer">Open Risk Explorer <Icon name="arrow" /></Link>} />
    </>
  );
}
