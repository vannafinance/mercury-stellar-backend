"use client";

/**
 * V3 Farm pool page (/farm/:id) — the design's single-vault view (`kamView`) for every Stellar farm
 * pool: back link, title + tags, pool stats bar, All Transactions | Analytics panel, and the
 * Add / Remove column ({@link PoolAction}).
 *
 * - Blend (`xlm` / `usdc`): reserve stats (`useBlendPoolStats`), the margin account's b-tokens
 *   (`useUserBlendPositions`) and its supply / withdraw history (`useBlendEvents`).
 * - Aquarius / Soroswap (`aquarius-*` / `soroswap-*`): reserves, LP supply and fee
 *   (`useAquariusPoolStats` / `useSoroswapPoolStats`), the margin account's LP shares and its
 *   add / remove history (`useAquariusEvents` / `useSoroswapEvents`).
 *
 * Position history comes from the useQuery-based event hooks (Mercury + bounded RPC fallback),
 * which refresh on ledger ticks, window focus and the `['farm']` invalidation after a transaction.
 * The position chart replays that real history plus a live "now" point — no browser storage.
 */
import "./farm-v3.css";
import { useMemo, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { Icon } from "@/components/v3/icons";
import { AreaChart, Info } from "@/components/v3/ui";
import { cmp, nf, pct, usd } from "@/components/v3/format";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useAquariusEvents, useAquariusLpPosition, useAquariusPoolStats, useBlendEvents, useBlendPoolStats, useUserBlendPositions } from "@/hooks/use-farm";
import { useSoroswapEvents, useSoroswapLpPosition, useSoroswapPoolStats } from "@/hooks/use-soroswap";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { PoolAction } from "./pool-action";
import { BackLink, Cell, HowItWorks, TabsBox, Tiles, Venue, VTag, YieldList } from "./fm-ui";
import { PositionTxPanel, type HistoryRow, type TxCols } from "./position-tx";
import { FARM_PRICE_SYMBOLS, normalizeTimestamp, poolTitle, priceFor, resolveFarmPool, txUrl, type FarmPoolRef } from "./farm-pools";

/**
 * Hide dust left over after a 100% withdrawal so the Current Position table doesn't show a
 * "0.00 b/0.00" ghost row. Guarded on the underlying / LP amount (not the bToken count) so tiny
 * b-rate rounding remnants that map to zero underlying are suppressed.
 */
const DETAIL_DUST = 0.001;

/**
 * Builds the farm position chart directly from real, Mercury-sourced add/remove-liquidity history
 * (replayed as a running total), plus a final live "current value" point. Previously ALSO merged in
 * localStorage-polled snapshots layered on top of this same real history — pure redundancy that
 * could show stale curves and disappeared when the browser cache was cleared. Dropped entirely;
 * the real event history is the only source.
 */
const buildRealtimeChartData = (history: Array<{ timestamp: number; delta: number }>, currentValue: number, decimals: number): Array<{ ts: number; amount: number }> => {
  const round = (value: number) => parseFloat(Math.max(0, value).toFixed(decimals));
  const points: Array<{ ts: number; amount: number }> = [];
  const events = history
    .map((item) => ({ timestamp: normalizeTimestamp(item.timestamp), delta: Number(item.delta ?? 0) }))
    .filter((item) => item.timestamp > 0 && Number.isFinite(item.delta))
    .sort((a, b) => a.timestamp - b.timestamp);

  let running = 0;
  if (events.length > 0) {
    points.push({ ts: Math.max(events[0].timestamp - 1, 1), amount: 0 });
    events.forEach((item) => {
      running = Math.max(0, running + item.delta);
      points.push({ ts: item.timestamp, amount: round(running) });
    });
  }

  const nowTs = Date.now();
  const nowValue = round(currentValue);
  if (points.length === 0) {
    if (nowValue <= 0) return [];
    return [
      { ts: Math.max(nowTs - 60_000, 1), amount: nowValue },
      { ts: nowTs, amount: nowValue },
    ];
  }
  const last = points[points.length - 1];
  if (nowTs > last.ts || Math.abs(nowValue - last.amount) >= 0.000001) points.push({ ts: nowTs, amount: nowValue });
  else points[points.length - 1] = { ts: last.ts, amount: nowValue };

  const dedupByTs = new Map<number, number>();
  points.forEach((item) => dedupByTs.set(item.ts, item.amount));
  return Array.from(dedupByTs.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([ts, amount]) => ({ ts, amount }));
};

const dateFmt = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const clockFmt = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
const fmtAmt = (n: number, d = 2) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

/** One unified view model per pool kind, so the layout below is written once. */
interface PoolView {
  stats: { label: string; value: string; sub?: string; tip?: string }[];
  analytics: { heading: string; main: string; sub: string; tip: string }[];
  tiles: [string, string][];
  yieldRows: [string, string][];
  summary: [string, string, string?][];
  cols: TxCols;
  current: ReactNode[][];
  history: HistoryRow[];
  typeOptions: string[];
  chart: { title: string; sub: string; unit: string; points: Array<{ ts: number; amount: number }> };
  steps: [string, string][];
}

export function PoolDetail() {
  const params = useParams();
  const id = (params?.id as string) ?? "";
  const pool = useMemo(() => resolveFarmPool(id), [id]);
  return pool ? <PoolPage key={pool.id} pool={pool} /> : <NotFound id={id} />;
}

function NotFound({ id }: { id: string }) {
  return (
    <div className="v3">
      <div className="page">
        <BackLink />
        <section className="fm-nf">
          <h1>Pool not found</h1>
          <p>&ldquo;{id}&rdquo; isn&apos;t a Farm pool.</p>
        </section>
      </div>
    </div>
  );
}

function PoolPage({ pool }: { pool: FarmPoolRef }) {
  const [left, setLeft] = useState<"tx" | "an">("tx");
  const view = usePoolView(pool);
  const title = poolTitle(pool);
  const stat = (s: PoolView["stats"][number]) => (
    <article key={s.label}>
      <div className="lbl">
        {s.label}
        {s.tip && <Info text={s.tip} />}
      </div>
      <div className="fm-sv">
        {s.value}
        {s.sub && <small> {s.sub}</small>}
      </div>
    </article>
  );

  return (
    <div className="v3">
      <div className="page">
        <BackLink />
        <div className="fm-vh">
          {pool.kind === "blend" ? (
            <Icon sym={pool.token} className="fm-ico28" />
          ) : (
            <span className="fm-tk" style={{ gap: 0 }}>
              <Icon sym={pool.tokens[0]} className="fm-ico28" />
              <Icon sym={pool.tokens[1]} className="fm-ico28" />
            </span>
          )}
          <h1>{title}</h1>
          <span className="fm-tag">{pool.kind === "blend" ? "Supply" : "LP"}</span>
          <VTag name={pool.venue} />
        </div>
        <section className="fm-stats num">{view.stats.map(stat)}</section>
        <div className="fm-cols">
          <div className="fm-main">
            <TabsBox
              items={[
                ["tx", "All Transactions"],
                ["an", "Analytics"],
              ]}
              value={left}
              onChange={setLeft}
            />
            <div className="fm-panel kp">
              {left === "an" ? (
                <>
                  <h2 className="fm-h21">Statistics</h2>
                  <div className="fm-scg num">
                    {view.analytics.map((a) => (
                      <div key={a.heading} className="fm-sc">
                        <div className="lbl">
                          {a.heading} <Info text={a.tip} />
                        </div>
                        <b>{a.main}</b>
                        <span>{a.sub}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <PositionChart {...view.chart} />
                  <PositionTxPanel summary={view.summary} cols={view.cols} current={view.current} history={view.history} typeOptions={view.typeOptions} />
                </>
              )}
            </div>
          </div>
          <aside className="fm-aside">
            <PoolAction pool={pool} />
            <Tiles items={view.tiles} />
            <YieldList rows={view.yieldRows} />
            <HowItWorks steps={view.steps} />
          </aside>
        </div>
      </div>
    </div>
  );
}

/** The position-over-time card (real event history + live value); honest empty state without data. */
function PositionChart({ title, sub, unit, points }: PoolView["chart"]) {
  const tips = points.map((p) => `${dateFmt(p.ts)} ${clockFmt(p.ts)}`);
  const labels = points.length > 1 ? [dateFmt(points[0].ts), ...(points.length > 2 ? [dateFmt(points[Math.floor(points.length / 2)].ts)] : []), dateFmt(points[points.length - 1].ts)] : [];
  return (
    <section className="fm-card">
      <div className="fm-ch">
        <div>
          <h3>{title}</h3>
          <p className="fm-ro num">{sub}</p>
        </div>
      </div>
      {points.length > 1 ? (
        <AreaChart series={[{ name: unit, color: "var(--violet)", pts: points.map((p) => p.amount) }]} h={200} yFmt={(v) => nf(v, 2)} xLabels={labels} xTips={tips} fmtKey="num" />
      ) : (
        <div className="fm-chart-e" style={{ minHeight: 160 }}>
          <span>No position history in this pool yet. The chart replays your supply / liquidity transactions once there are some.</span>
        </div>
      )}
    </section>
  );
}

/** All the pool's numbers, from the same hooks the previous Farm pool page used. */
function usePoolView(pool: FarmPoolRef): PoolView {
  const marginAccountAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);
  const prices = useTokenPrices(FARM_PRICE_SYMBOLS);
  const isBlend = pool.kind === "blend";
  const isAquarius = pool.kind === "aquarius";
  const isSoroswap = pool.kind === "soroswap";
  const blendToken = pool.kind === "blend" ? pool.token : undefined;
  const aqAddress = pool.kind === "aquarius" ? pool.cfg.poolAddress : null;
  const ssCfg = pool.kind === "soroswap" ? pool.cfg : null;

  // Blend (single-asset)
  const { stats: blendStats, isLoading: blendLoading } = useBlendPoolStats(isBlend);
  const { positions: blendPositions } = useUserBlendPositions();
  const { events: blendEvents } = useBlendEvents(blendToken);
  // Aquarius (LP)
  const { stats: aqStats, isLoading: aqLoading } = useAquariusPoolStats(aqAddress);
  const { lpBalance: aqLpRaw } = useAquariusLpPosition(marginAccountAddress, aqAddress);
  const { events: aqEvents } = useAquariusEvents(aqAddress, isAquarius ? marginAccountAddress : null);
  // Soroswap (LP)
  const { stats: ssStats, isLoading: ssLoading } = useSoroswapPoolStats(isSoroswap, ssCfg?.pairAddress);
  const { lpBalance: ssLpRaw } = useSoroswapLpPosition(isSoroswap ? marginAccountAddress : null, ssCfg?.trackingSymbol, ssCfg?.pairAddress);
  const { events: ssEvents } = useSoroswapEvents(ssCfg ? (ssCfg.pairAddress ?? ssStats?.pairAddress) : null, marginAccountAddress);

  return useMemo<PoolView>(() => {
    if (pool.kind === "blend") {
      const sym = pool.token;
      const label = pool.label;
      const bSym = `b${sym}`;
      const price = priceFor(prices, sym);
      const r = blendStats[sym];
      const ld = blendLoading && !r;
      const supplyApy = r ? parseFloat(r.supplyAPY) || 0 : 0;
      const borrowApy = r ? parseFloat(r.borrowAPY) || 0 : 0;
      const util = r ? parseFloat(r.utilizationRate) || 0 : 0;
      const totalSupply = r ? parseFloat(r.totalSupply) || 0 : 0;
      const totalBorrow = r ? parseFloat(r.totalBorrow) || 0 : 0;
      const bRate = r ? parseFloat(r.bRate) || 0 : 0;
      const pos = blendPositions[sym];
      const underlying = parseFloat(pos?.underlyingValue ?? "0") || 0;
      const bTokens = parseFloat(pos?.bTokenBalance ?? "0") || 0;
      const held = underlying > DETAIL_DUST;
      const valueUsd = held ? underlying * price : 0;

      const history = blendEvents
        .map((ev) => ({
          ts: normalizeTimestamp(ev.timestamp),
          add: ev.type === "supply",
          amount: parseFloat(String(ev.underlyingAmount ?? "0")) || 0,
          // How many b-tokens this event minted (Supply) or burned (Withdraw).
          bTokens: parseFloat(String(ev.bTokenAmount ?? "0")) || 0,
          sym: ev.tokenSymbol,
          hash: ev.txHash ?? "",
        }))
        .sort((a, b) => b.ts - a.ts);

      return {
        stats: [
          { label: "Supply APY", value: ld ? "..." : pct(supplyApy), tip: "Blend's current yearly supply yield on this reserve (net of the backstop take rate)." },
          { label: "Borrow APY", value: ld ? "..." : pct(borrowApy) },
          { label: "Utilization Rate", value: ld ? "..." : pct(util) },
          { label: "Total Pool Supply", value: ld ? "..." : `${cmp(totalSupply)} ${label}`, sub: ld ? undefined : usd(totalSupply * price) },
        ],
        analytics: [
          { heading: "Supply APY", main: pct(supplyApy), sub: "Annual yield on supplied assets", tip: "Net APY after backstop fee" },
          { heading: "Borrow APY", main: pct(borrowApy), sub: "Annual cost to borrow", tip: "Current variable borrow rate" },
          { heading: "Utilization", main: pct(util), sub: "Borrowed / Total Supply", tip: "Pool utilization rate" },
          { heading: "Total Supply", main: `${fmtAmt(totalSupply)} ${sym}`, sub: usd(totalSupply * price), tip: "Sum of all deposits in the pool" },
          { heading: "Total Borrow", main: `${fmtAmt(totalBorrow)} ${sym}`, sub: usd(totalBorrow * price), tip: "Sum of all borrows from the pool" },
          { heading: "b-Rate", main: nf(bRate, 4), sub: `1 ${bSym} = ${nf(bRate, 4)} ${sym}`, tip: "b-token to underlying exchange rate" },
        ],
        tiles: [
          ["Total Value Locked", usd(totalSupply * price)],
          ["Supply APY", pct(supplyApy)],
        ],
        yieldRows: [
          ["Your Position", usd(valueUsd)],
          ["Receipt", bSym],
        ],
        summary: [
          ["Position value", usd(valueUsd)],
          ["Supplied", `${fmtAmt(held ? underlying : 0, 4)} ${label}`],
          ["Receipt balance", `${fmtAmt(held ? bTokens : 0, 4)} ${bSym}`, bRate > 0 ? `1 ${bSym} = ${nf(bRate, 4)} ${sym}` : undefined],
        ],
        cols: {
          current: [
            ["Asset", "1.1fr"],
            ["Protocol", ".9fr"],
            ["Supplied", "1.1fr"],
            ["b-Tokens", "1.1fr"],
            ["APY", ".7fr"],
            ["b-Rate", ".7fr"],
          ],
          history: [
            ["Date", "1.1fr"],
            ["Type", ".8fr"],
            ["Amount", "1fr"],
            ["b-Tokens", "1fr"],
            ["Status", ".7fr"],
            ["Tx Hash", "1fr"],
          ],
        },
        current: held
          ? [
              [
                <Cell
                  key="a"
                  v={
                    <span className="fm-tk">
                      <Icon sym={sym} className="fm-ico16" />
                      {label}
                    </span>
                  }
                  mini={["Blend", "Supply"]}
                />,
                <Cell key="p" v={<Venue name="Blend" />} />,
                <Cell key="s" v={`${fmtAmt(underlying, 4)} ${sym}`} mini={usd(valueUsd)} />,
                <Cell key="b" v={`${fmtAmt(bTokens, 4)} ${bSym}`} />,
                <Cell key="y" v={r ? pct(supplyApy) : "N/A"} />,
                <Cell key="r" v={r ? nf(bRate, 4) : "N/A"} />,
              ],
            ]
          : [],
        history: history.map((ev) => ({
          label: ev.add ? "Supply" : "Withdraw",
          cells: [
            <Cell key="d" v={ev.ts ? dateFmt(ev.ts) : "N/A"} mini={ev.ts ? clockFmt(ev.ts) : undefined} />,
            <Cell key="t" v={ev.add ? "Supply" : "Withdraw"} cls={ev.add ? "pos" : ""} />,
            <Cell key="m" v={`${fmtAmt(ev.amount)} ${ev.sym}`} />,
            <Cell key="b" v={`${fmtAmt(ev.bTokens, 4)} b${ev.sym}`} />,
            <Cell key="s" v={<span className="fm-ok">Success</span>} />,
            <Cell
              key="h"
              v={
                ev.hash ? (
                  <a className="fm-link" href={txUrl(ev.hash)} target="_blank" rel="noreferrer">
                    {ev.hash.slice(0, 8)}…{ev.hash.slice(-4)}
                  </a>
                ) : (
                  "N/A"
                )
              }
            />,
          ],
        })),
        typeOptions: ["Supply", "Withdraw"],
        chart: {
          title: "My Supply Position",
          sub: held ? `${fmtAmt(underlying, 4)} ${sym} supplied · 1 ${bSym} = ${nf(bRate, 4)} ${sym}` : `1 ${bSym} = ${nf(bRate, 4)} ${sym}`,
          unit: sym,
          points: buildRealtimeChartData(
            history.map((ev) => ({ timestamp: ev.ts, delta: (ev.add ? 1 : -1) * ev.amount })),
            underlying,
            4,
          ),
        },
        steps: [
          ["Choose a pool", "Pick the Blend reserve to supply"],
          ["Supply from your margin account", `Supply the ${label} already in your margin account (deposited or borrowed) to Blend`],
          ["Earn Blend supply yield", "The b-tokens stay in your margin account and count toward its health factor"],
          ["Withdraw anytime", "Redeem back into your margin account, then repay or withdraw on the Margin page"],
        ],
      };
    }

    // ── Aquarius / Soroswap LP ──
    const [tokenA, tokenB] = pool.tokens;
    const [labelA, labelB] = pool.labels;
    const venue = pool.venue;
    const ld = pool.kind === "aquarius" ? aqLoading && !aqStats : ssLoading && !ssStats;
    const reserveA = pool.kind === "aquarius" ? parseFloat(aqStats?.reserveA ?? "0") || 0 : parseFloat(ssStats?.reserveXLM ?? "0") || 0;
    const reserveB = pool.kind === "aquarius" ? parseFloat(aqStats?.reserveB ?? "0") || 0 : parseFloat(ssStats?.reserveUSDC ?? "0") || 0;
    const totalShares = parseFloat((pool.kind === "aquarius" ? aqStats?.totalShares : ssStats?.totalShares) ?? "0") || 0;
    const fee = (pool.kind === "aquarius" ? aqStats?.feeFraction : ssStats?.feeFraction) ?? `${(pool.cfg.feeFraction / 100).toFixed(2)}%`;
    const apyRaw = pool.kind === "aquarius" ? parseFloat(aqStats?.apy ?? "") : NaN;
    // Aquarius: the AMM API's base trading APY; Soroswap's testnet API exposes no APY (0%).
    const apr = Number.isFinite(apyRaw) && apyRaw > 0 ? apyRaw * 100 : 0;
    const pA = priceFor(prices, tokenA);
    const pB = priceFor(prices, tokenB);
    const tvlUsd = reserveA * pA + reserveB * pB;
    const lp = parseFloat((pool.kind === "aquarius" ? aqLpRaw : ssLpRaw) ?? "0") || 0;
    const held = lp > DETAIL_DUST;
    const ratio = held && totalShares > 0 ? lp / totalShares : 0;
    const myA = ratio * reserveA;
    const myB = ratio * reserveB;
    const valueUsd = myA * pA + myB * pB;
    const events = pool.kind === "aquarius" ? aqEvents : ssEvents;
    const history = events
      .map((ev) => ({ ts: normalizeTimestamp(ev.timestamp), add: ev.type === "deposit", shares: ev.shareAmount, amount: parseFloat(ev.shareAmount) || 0, hash: ev.txHash ?? "" }))
      .sort((a, b) => b.ts - a.ts);
    const lpLabel = `${labelA}/${labelB} LP`;

    return {
      stats: [
        { label: `${labelA} Reserve`, value: ld ? "..." : `${cmp(reserveA)} ${labelA}`, sub: ld ? undefined : usd(reserveA * pA) },
        { label: `${labelB} Reserve`, value: ld ? "..." : `${cmp(reserveB)} ${labelB}`, sub: ld ? undefined : usd(reserveB * pB) },
        { label: "Fee Rate", value: ld ? "..." : fee },
        { label: "Total LP Shares", value: ld ? "..." : cmp(totalShares) },
      ],
      analytics: [
        { heading: `${labelA} Reserve`, main: `${fmtAmt(reserveA)} ${labelA}`, sub: `Current ${labelA} reserve in pool`, tip: `Total ${labelA} held by the ${venue} pool` },
        { heading: `${labelB} Reserve`, main: `${fmtAmt(reserveB)} ${labelB}`, sub: `Current ${labelB} reserve in pool`, tip: `Total ${labelB} held by the ${venue} pool` },
        { heading: "Fee Rate", main: fee, sub: "Swap fee per trade", tip: "Fee split between LPs" },
        { heading: "Total LP Shares", main: fmtAmt(totalShares), sub: "Total outstanding LP tokens", tip: "Sum of all LP shares minted" },
        { heading: "Pool APR", main: pct(apr), sub: venue === "Aquarius" ? "Base trading APY" : "No APY source on testnet", tip: venue === "Aquarius" ? "The Aquarius AMM API's base trading APY (annualised from fees)." : "Soroswap's public testnet API doesn't expose APY yet, so this reads 0%." },
        { heading: "Your LP Balance", main: fmtAmt(held ? lp : 0), sub: "Your margin account LP shares", tip: "LP tokens held by your margin account" },
      ],
      tiles: [
        ["Pool TVL", usd(tvlUsd)],
        ["Pool APR", pct(apr)],
      ],
      yieldRows: [
        ["Your Position", usd(valueUsd)],
        ["Receipt", lpLabel],
      ],
      summary: [
        ["Position value", usd(valueUsd)],
        ["LP shares", `${fmtAmt(held ? lp : 0)} LP`],
        ["Share of pool", ratio > 0 ? (ratio * 100 < 0.01 ? "<0.01%" : pct(ratio * 100)) : pct(0), held ? `${fmtAmt(myA)} ${labelA} + ${fmtAmt(myB)} ${labelB}` : undefined],
      ],
      cols: {
        current: [
          ["Pool", "1.3fr"],
          ["LP Shares", ".9fr"],
          [`${labelA} Deposited`, "1fr"],
          [`${labelB} Deposited`, "1fr"],
          ["Fee Rate", ".7fr"],
        ],
        history: [
          ["Date", "1.1fr"],
          ["Type", "1.1fr"],
          ["Amount", "1fr"],
          ["Status", ".7fr"],
          ["Tx Hash", "1fr"],
        ],
      },
      current: held
        ? [
            [
              <Cell
                key="a"
                v={
                  <span className="fm-tk">
                    <Icon sym={tokenA} className="fm-ico16" />
                    {labelA} / {labelB}
                  </span>
                }
                mini={[venue, "LP"]}
              />,
              <Cell key="l" v={`${fmtAmt(lp)} LP`} mini={usd(valueUsd)} />,
              <Cell key="x" v={`${fmtAmt(myA)} ${labelA}`} />,
              <Cell key="y" v={`${fmtAmt(myB)} ${labelB}`} />,
              <Cell key="f" v={fee} />,
            ],
          ]
        : [],
      history: history.map((ev) => ({
        label: ev.add ? "Add Liquidity" : "Remove Liquidity",
        cells: [
          <Cell key="d" v={ev.ts ? dateFmt(ev.ts) : "N/A"} mini={ev.ts ? clockFmt(ev.ts) : undefined} />,
          <Cell key="t" v={ev.add ? "Add Liquidity" : "Remove Liquidity"} cls={ev.add ? "pos" : ""} />,
          <Cell key="m" v={`${ev.shares} LP`} />,
          <Cell key="s" v={<span className="fm-ok">Success</span>} />,
          <Cell
            key="h"
            v={
              ev.hash ? (
                <a className="fm-link" href={txUrl(ev.hash)} target="_blank" rel="noreferrer">
                  {ev.hash.slice(0, 8)}…{ev.hash.slice(-4)}
                </a>
              ) : (
                "N/A"
              )
            }
          />,
        ],
      })),
      typeOptions: ["Add Liquidity", "Remove Liquidity"],
      chart: {
        title: "My LP Position",
        sub: held ? `${fmtAmt(lp)} LP shares · ${usd(valueUsd)}` : "LP shares held by your margin account",
        unit: "LP",
        points: buildRealtimeChartData(
          history.map((ev) => ({ timestamp: ev.ts, delta: (ev.add ? 1 : -1) * ev.amount })),
          lp,
          7,
        ),
      },
      steps: [
        ["Choose a pool", `Pick the ${venue} pool to provide liquidity to`],
        ["Add both tokens from your margin account", "The second amount is paired automatically at the pool's current price"],
        ["Earn trading fees", "The LP shares stay in your margin account and count toward its health factor"],
        ["Remove anytime", "Burn LP shares to get both tokens back into your margin account"],
      ],
    };
  }, [pool, prices, blendStats, blendLoading, blendPositions, blendEvents, aqStats, aqLoading, aqLpRaw, aqEvents, ssStats, ssLoading, ssLpRaw, ssEvents]);
}

