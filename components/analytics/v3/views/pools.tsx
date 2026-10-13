"use client";

/** Lending Pools: pool table, selected-pool inspector and the on-chain rate model. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ContractService } from "@/lib/stellar-utils";
import type { PoolRow } from "@/lib/analytics/v3/pools";
import { num, pct, usd, usdC } from "@/lib/analytics/v3/format";
import { useAnalyticsData } from "../data";
import { Addr, AssetCell, Badge, Empty, InfoTip, Kpi, Notice, Panel } from "../ui";
import { ViewHead } from "../shell";
import { Gauge, HBars, Legend, LineChart, Meter, SERIES } from "../charts";

/** RateModelContract's own SECS_PER_YEAR (lib/pool-stats.ts uses the same constant). */
const SECS_PER_YEAR = BigInt(31_556_952);
const CURVE_POINTS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1];

/**
 * The borrow-rate curve, read point by point from the deployed RateModelContract
 * (`get_borrow_rate_per_sec`) - the same curve every lending pool accrues with. Read once per visit.
 */
function useRateCurve() {
  return useQuery({
    queryKey: ["analytics", "v3-rate-curve"],
    staleTime: Infinity,
    queryFn: async () => {
      const total = BigInt("1000000000000000000000000"); // 1e6 tokens, WAD-scaled
      const points = await Promise.all(CURVE_POINTS.map(async (u) => {
        const borrows = (total * BigInt(Math.round(u * 1000))) / BigInt(1000);
        const r = await ContractService.getBorrowRatePerSecWad(total - borrows, borrows);
        return r === null ? null : { utilization: u, annualRate: Number(r * SECS_PER_YEAR) / 1e18 };
      }));
      const ok = points.filter((p): p is { utilization: number; annualRate: number } => p !== null);
      if (ok.length < 3) throw new Error("rate model unreadable");
      return ok;
    },
  });
}

function Inspector({ row }: { row: PoolRow }) {
  const curve = useRateCurve();
  const pts = curve.data ?? [];
  const marker = pts.length && row.borrowApr !== null ? { x: row.utilization, y: row.borrowApr, label: `Now ${pct(row.utilization)} → ${pct(row.borrowApr)} APR` } : null;
  const fact = (k: React.ReactNode, v: React.ReactNode) => <div><dt>{k}</dt><dd>{v}</dd></div>;
  return (
    <section className="an-panel">
      <div className="an-panel-head"><AssetCell symbol={row.symbol} sub={row.name} /></div>
      <div className="an-grid-main" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.5fr)", gap: 24 }}>
        <div className="an-gauge-wrap" style={{ gap: 14, alignContent: "start" }}>
          <Gauge value={row.utilization} label="Utilization" />
          <div className="an-mini-stats" style={{ width: "100%" }}>
            <div><span className="an-k">Supplied</span><span className="an-v">{usdC(row.usdSupplied)}</span></div>
            <div><span className="an-k">Borrowed</span><span className="an-v">{usdC(row.usdBorrowed)}</span></div>
            <div><span className="an-k">Available</span><span className="an-v">{usdC(row.usdCash)}</span></div>
          </div>
        </div>
        <div>
          <div className="an-panel-title" style={{ marginBottom: 2 }}>How the borrow rate changes</div>
          <p className="an-panel-sub" style={{ marginBottom: 8 }}>Interest rate for borrowers at each level of utilization, read from the on-chain rate model</p>
          {pts.length ? <LineChart points={pts.map((c) => ({ x: c.utilization, y: c.annualRate, tip: `Utilization ${pct(c.utilization, 0)}\nBorrow APR ${pct(c.annualRate)}` }))}
            xFmt={(v) => pct(v, 0)} yFmt={(v) => pct(v, v < 0.1 ? 1 : 0)} marker={marker} ariaLabel={`${row.symbol} borrow APR by utilization`} xTicks={[0, 0.25, 0.5, 0.75, 1]} />
            : curve.isLoading ? <Empty title="Reading the rate model…" text="Asking the RateModel contract for each utilization level." />
            : <Empty title="Rate model not available" text="The pool's rate settings could not be read from the chain." />}
        </div>
      </div>
      <div className="an-grid-2 an-mt an-kv-rows" style={{ gap: 32 }}>
        <dl className="an-kv">
          {fact("Status", <Badge tone="ok">Active</Badge>)}
          {fact(<>Borrow APR <InfoTip k="borrowApr" /></>, pct(row.borrowApr))}
          {fact(<>Supply APR <InfoTip k="supplyApr" /></>, pct(row.supplyApr))}
          {fact("Value of one deposit share", row.exchangeRate === null ? "Not available" : `${num(row.exchangeRate, 7)} ${row.symbol}`)}
          {fact("Deposit shares issued", num(row.vTokenSupply, 2))}
          {fact("Reflector price", row.price === null ? "No live price" : usd(row.price))}
        </dl>
        <details className="an-more" open><summary>More details</summary>
          <dl className="an-kv">
            {fact("Pool contract", <Addr value={row.address} head={6} tail={6} />)}
            {fact("Supplied", `${num(row.totalSupplied)} ${row.symbol}`)}
            {fact("Borrowed", `${num(row.totalBorrowed)} ${row.symbol}`)}
            {fact("Available", `${num(row.availableLiquidity)} ${row.symbol}`)}
          </dl>
        </details>
      </div>
    </section>
  );
}

type Measure = "usd" | "share" | "rates";

export function PoolsView() {
  const d = useAnalyticsData();
  const rows = d.pools;
  const t = d.poolTotals;
  const [pick, setPick] = useState<string | null>(null);
  const [measure, setMeasure] = useState<Measure>("usd");
  const selected = rows.find((r) => r.symbol === pick) ?? rows[0] ?? null;
  const unvalued = rows.filter((r) => !r.valued);
  const why = !d.poolsLoaded ? (d.error ? "Couldn't reach the service." : "Waiting for the first data load.") : unvalued.length ? `${unvalued.map((r) => r.symbol).join(", ")} ${unvalued.length === 1 ? "has" : "have"} no live price yet.` : "Prices and balances are out of sync. Try again in a moment.";
  const partial = t?.partial ? <Badge tone="warn">Partial</Badge> : null;
  const sub = (base: string) => (!t ? why : t.partial ? `Without ${t.excluded.join(", ")} (no live price)` : base);

  const cmpRows = rows.filter((r) => measure === "rates" || r.valued).map((r) => {
    const a = r.usdCash ?? 0, b = r.usdBorrowed ?? 0, tot = a + b || 1;
    const segments = measure === "rates"
      ? [{ value: r.borrowApr ?? 0, color: SERIES[0], tip: `${r.symbol} borrow APR ${pct(r.borrowApr)}` }, { value: r.supplyApr ?? 0, color: SERIES[1], tip: `${r.symbol} supply APR ${pct(r.supplyApr)}` }]
      : measure === "share"
        ? [{ value: a / tot, color: SERIES[0], tip: `Cash ${pct(a / tot, 1)}` }, { value: b / tot, color: SERIES[1], tip: `Debt ${pct(b / tot, 1)}` }]
        : [{ value: a, color: SERIES[0], tip: `${r.symbol} cash ${usd(a)}` }, { value: b, color: SERIES[1], tip: `${r.symbol} debt ${usd(b)}` }];
    return { key: r.symbol, name: <AssetCell symbol={r.symbol} sub="" size="sm" />, segments, valueText: measure === "rates" ? pct(r.borrowApr) : measure === "share" ? `${pct(b / tot, 1)} debt` : usdC(a + b) };
  });

  return (
    <>
      <ViewHead title="Lending Pools" blurb="What lenders have supplied, what is borrowed and what is left to withdraw." />
      <div className="an-kpi-grid an-cols-5">
        <Kpi label="Supplied by lenders" tip="supplied" value={t ? usdC(t.supplied) : "-"} na={!t} badge={partial} sub={sub(`${rows.length} pools · USD`)} />
        <Kpi label="Borrowed" tip="borrowed" value={t ? usdC(t.borrowed) : "-"} na={!t} badge={partial} sub={sub("What borrowers owe")} />
        <Kpi label="Available to withdraw" tip="cash" value={t ? usdC(t.cash) : "-"} na={!t} badge={partial} sub={sub("Withdrawable cash")} />
        <Kpi label="Borrowed share" tip="ratio" value={t?.ratio != null ? pct(t.ratio) : "-"} na={t?.ratio == null} badge={partial} sub={t ? `${t.partial ? "Counted pools only · " : ""}Busiest: ${t.maxUtilizationSymbol} ${pct(t.maxUtilization)}` : why} />
        <Kpi label="Average borrow rate" tip="borrowApr" value={t?.borrowApr != null ? pct(t.borrowApr) : "-"} na={t?.borrowApr == null} sub={t ? `Supply APR ${pct(t.supplyApr)}` : why} />
      </div>
      {!rows.length ? <Empty title={d.poolsLoaded ? "No lending pools could be read" : "Loading pools…"} text={d.poolsLoaded ? "The lending pool contracts did not answer. Try Refresh." : undefined} icon="pools" /> : (
        <>
          <section className="an-panel an-flush">
            <div className="an-panel-head"><div><h2 className="an-panel-title">Pools</h2><p className="an-panel-sub">{rows.length} lending pools · select one to inspect</p></div></div>
            <div className="an-table-wrap"><table className="an-t">
              <thead><tr><th>Pool</th><th className="an-r">Supplied</th><th className="an-r">Borrowed</th><th className="an-r">Available</th><th>Utilization</th><th className="an-r">Borrow APR</th><th>Status</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.symbol} className={`an-row-link ${selected?.symbol === r.symbol ? "an-expanded" : ""}`} tabIndex={0} role="button" aria-pressed={selected?.symbol === r.symbol}
                  onClick={() => setPick(r.symbol)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPick(r.symbol); } }}>
                  <td><AssetCell symbol={r.symbol} sub={r.name} /></td>
                  <td className="an-r"><b>{usd(r.usdSupplied)}</b><small>{num(r.totalSupplied)} {r.symbol}</small></td>
                  <td className="an-r"><b>{usd(r.usdBorrowed)}</b><small>{num(r.totalBorrowed)} {r.symbol}</small></td>
                  <td className="an-r"><b>{usd(r.usdCash)}</b><small>{num(r.availableLiquidity)} {r.symbol}</small></td>
                  <td style={{ minWidth: 130 }}><span className="an-strong">{pct(r.utilization)}</span><div style={{ marginTop: 6 }}><Meter fraction={r.utilization} /></div></td>
                  <td className="an-r"><b>{pct(r.borrowApr)}</b><small>Supply {pct(r.supplyApr)}</small></td>
                  <td><Badge tone={r.valued ? "ok" : "warn"}>{r.valued ? "Active" : "No price"}</Badge></td>
                </tr>
              ))}</tbody></table></div>
          </section>
          {selected && <Inspector row={selected} />}
          <Panel title="Liquidity structure" sub="How much of each pool is cash and how much is lent out"
            actions={<div className="an-seg" role="group" aria-label="Chart measure">{([["usd", "USD values"], ["share", "Cash vs debt"], ["rates", "Annual rates"]] as const).map(([k, l]) => <button key={k} aria-pressed={measure === k} onClick={() => setMeasure(k)}>{l}</button>)}</div>}>
            {measure !== "rates" && !rows.some((r) => r.valued)
              ? <Notice tone="warn">{why}</Notice>
              : <><HBars rows={cmpRows} /><div className="an-mt"><Legend items={measure === "rates" ? [{ label: "Borrow APR", color: SERIES[0] }, { label: "Supply APR", color: SERIES[1] }] : [{ label: "Available cash", color: SERIES[0] }, { label: "Outstanding debt", color: SERIES[1] }]} /></div></>}
            {measure !== "rates" && unvalued.length > 0 && rows.some((r) => r.valued) && <p className="an-panel-foot">Excludes {unvalued.map((r) => r.symbol).join(", ")}: no live price yet.</p>}
          </Panel>
        </>
      )}
    </>
  );
}
