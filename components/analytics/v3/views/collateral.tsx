"use client";

/** Collateral: the assets accounts use, how each is priced and lent, and what accounts actually hold. */
import { ACTIVE_ASSETS } from "@/lib/analytics/stellar/canon";
import { kindOf, underlyingOf } from "@/lib/analytics/v3/model";
import { poolSymbolFor } from "@/lib/analytics/v3/pools";
import { num, usd, usdC } from "@/lib/analytics/v3/format";
import { useAnalyticsData } from "../data";
import { AssetCell, Badge, Empty, InfoTip, Kpi } from "../ui";
import { ViewHead } from "../shell";

const HOW: Record<ReturnType<typeof kindOf>, string> = { held: "Token", lending: "Blend deposit", lp: "LP position" };

export function CollateralView() {
  const d = useAnalyticsData();
  const s = d.summary;
  const held = new Map((s?.collateralBy ?? []).map((c) => [c.symbol, c]));
  const symbols = [...new Set<string>([...ACTIVE_ASSETS, ...(s?.collateralBy ?? []).map((c) => c.symbol)])];
  const loaded = !!s || d.poolsLoaded;
  const priceSource = (sym: string) => {
    const kind = kindOf(sym);
    if (kind === "lp") return "Valued as one position by the Risk Engine";
    if (kind === "lending") return `Reflector · priced as ${underlyingOf(sym)}`;
    return (ACTIVE_ASSETS as readonly string[]).includes(sym) ? "Reflector (via the Vanna Oracle contract)" : "Reflector";
  };
  const livePrice = (sym: string) => {
    if (kindOf(sym) === "lp") return null;
    const direct = d.oraclePrices[sym];
    if (direct != null) return direct;
    const key = underlyingOf(sym);
    return d.prices[key] ?? null;
  };
  const poolOf = (sym: string) => (kindOf(sym) === "held" ? d.pools.find((p) => p.symbol === poolSymbolFor(sym)) ?? null : null);

  return (
    <>
      <ViewHead title="Collateral" blurb="The assets margin accounts hold, how each is priced, and what accounts actually hold." />
      <div className="an-kpi-grid an-cols-3">
        <Kpi label="Assets with a lending pool" value={d.poolsLoaded ? String(d.pools.length) : "-"} na={!d.poolsLoaded} sub="Can be supplied and borrowed" />
        <Kpi label="Kinds of collateral held" value={s ? String(s.collateralBy.length) : "-"} na={!s} sub="Tokens, Blend deposits and LP positions" />
        <Kpi label="Collateral held" tip="countedCollateral" value={s ? usdC(s.collateralUsd) : "-"} na={!s} sub={s ? `Across ${s.total - s.statusCounts.empty} account${s.total - s.statusCounts.empty === 1 ? "" : "s"}` : "Waiting for accounts"} />
      </div>
      <section className="an-panel an-flush">
        <div className="an-panel-head"><div><h2 className="an-panel-title">Assets</h2><p className="an-panel-sub">The lending assets, plus every other kind of collateral an account holds</p></div></div>
        {loaded ? (
          <div className="an-table-wrap"><table className="an-t an-compact an-fit">
            <thead><tr><th>Asset</th><th>Held as</th><th>Lending pool</th><th>Borrowing</th><th>Price source</th><th className="an-r">Live price</th><th className="an-r">Held in accounts <InfoTip k="countedCollateral" /></th></tr></thead>
            <tbody>{symbols.map((sym) => {
              const h = held.get(sym);
              const pool = poolOf(sym);
              const px = livePrice(sym);
              return (
                <tr key={sym}>
                  <td className="an-nowrap"><AssetCell symbol={sym} size="sm" /></td>
                  <td>{HOW[kindOf(sym)]}</td>
                  <td>{pool ? <Badge tone="ok">{pool.name}</Badge> : <Badge tone="neutral">None</Badge>}</td>
                  <td><Badge tone={pool ? "ok" : "neutral"}>{pool ? "On" : "Off"}</Badge></td>
                  <td>{priceSource(sym)}</td>
                  <td className="an-r">{px != null ? usd(px) : <span className="an-muted">-</span>}</td>
                  <td className="an-r">{h ? <><b>{h.usd > 0 ? usd(h.usd) : `${num(h.amount, 2)} ${sym}`}</b><small>{num(h.amount, 2)} · {h.accounts} account{h.accounts === 1 ? "" : "s"}</small></> : <span className="an-muted">None</span>}</td>
                </tr>
              );
            })}</tbody></table></div>
        ) : <Empty title="Loading…" />}
      </section>
      <p className="an-muted" style={{ fontSize: 12.5 }}>Amounts are what each margin account reports on-chain. Dollar values are the Risk Engine&apos;s valuation from the latest read ({usdC(s?.collateralUsd ?? null)} in total). Per-asset collateral limits and liquidator bonuses are not shown here.</p>
    </>
  );
}
