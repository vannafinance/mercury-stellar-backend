"use client";

/** Prices: each asset's Reflector price as the protocol reads it, and whether the latest read returned a live one. */
import { useState } from "react";
import { ACTIVE_ASSETS, ORACLE } from "@/lib/analytics/stellar/canon";
import { clock, usd } from "@/lib/analytics/v3/format";
import { useAnalyticsData } from "../data";
import { Addr, AssetCell, Badge, Empty, Icon, InfoTip, Kpi } from "../ui";
import { ViewHead } from "../shell";

type St = "live" | "none";
const STATUSES: Array<["all" | St, string]> = [["all", "All"], ["live", "Live"], ["none", "No price"]];

export function PricesView() {
  const d = useAnalyticsData();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | St>("all");
  const loaded = d.oracleLoaded;
  const all = ACTIVE_ASSETS.map((sym) => {
    const p = d.oraclePrices[sym] ?? null;
    const st: St = p !== null && p > 0 ? "live" : "none";
    return { sym, p, st, pool: d.pools.find((x) => x.symbol === sym) ?? null };
  });
  const count = (s: St) => all.filter((r) => r.st === s).length;
  const list = all.filter((r) => (!q.trim() || `${r.sym} ${r.pool?.name ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())) && (filter === "all" || r.st === filter));

  return (
    <>
      <ViewHead title="Prices" blurb="The Reflector prices the protocol uses, and whether the latest read returned a live one." />
      <div className="an-kpi-grid an-cols-3">
        <Kpi label="Live prices" tip="oracleFresh" value={loaded ? `${count("live")} / ${all.length}` : "-"} na={!loaded} tone={loaded && count("live") === all.length ? "ok" : "warn"} sub={loaded ? "Returned by Reflector on the latest read" : d.error ? "Couldn't reach the service." : "Loading…"} />
        <Kpi label="No live price" value={loaded ? String(count("none")) : "-"} na={!loaded} tone={count("none") ? "warn" : ""} sub={count("none") ? "The Risk Engine blocks borrows and withdrawals that need these" : "None"} />
        <Kpi label="Oracle" value={ORACLE.name} sub={`Expected heartbeat ≤ ${ORACLE.expectedHeartbeatSec}s · read at ${clock(d.oracleReadAt)}`} />
      </div>
      <div className="an-row">
        <label className="an-input-wrap"><Icon name="search" /><input className="an-input" placeholder="Search asset" aria-label="Search assets" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <div className="an-seg" role="group" aria-label="Price status">{STATUSES.map(([k, l]) => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}</div>
        <span className="an-muted">{list.length} assets shown</span>
      </div>
      <div className="an-rcards" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(290px,1fr))" }}>
        {list.map(({ sym, p, st, pool }) => (
          <article className="an-oracle-card" key={sym}>
            <div className="an-row an-between"><AssetCell symbol={sym} sub={pool?.name} /><Badge tone={st === "live" ? "ok" : "warn"}>{st === "live" ? "Live" : "No price"}</Badge></div>
            <div>
              <div style={{ fontSize: 24, fontWeight: 700, color: st === "live" ? undefined : "var(--ink-3)" }}>{p !== null && p > 0 ? usd(p) : "-"}</div>
              {st === "none" && <div style={{ fontSize: 12, color: "var(--warn, var(--critical))", fontWeight: 600 }}>Reflector returned no usable price on the latest read</div>}
              <div className="an-muted" style={{ fontSize: 12.5 }}>{sym === "XLM" ? "Reflector · XLM feed" : "Reflector · USDC feed (all three USDC pools price as USDC)"}</div>
            </div>
            <div className="an-fresh-box">
              <div className="an-k">Last read <InfoTip k="oracleFresh" /></div>
              <div className="an-v">{clock(d.oracleReadAt)}<small>{" "}· refreshed every ledger</small></div>
            </div>
            <div className="an-muted" style={{ fontSize: 12 }}>Used by: {pool ? `${pool.name} lending pool · ` : ""}Margin collateral and debt</div>
          </article>
        ))}
        {!list.length && <Empty title={loaded ? "No assets match" : "Loading prices…"} text={loaded ? "Change the search or filter." : undefined} icon="search" />}
      </div>
      <p className="an-muted" style={{ fontSize: 12.5 }}>Oracle contract <Addr value={ORACLE.contractAddress} head={6} tail={6} />. Blend deposits follow their underlying asset&apos;s price; Aquarius / Soroswap LP positions are valued as a whole by the Risk Engine.</p>
    </>
  );
}
