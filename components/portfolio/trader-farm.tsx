"use client";

/**
 * Portfolio → Trader → Farm: every farm position the margin account holds — Blend single-asset
 * supply plus Soroswap / Aquarius LP shares — valued with the same hooks and maths as the previous
 * Portfolio Farm tab (components/portfolio/farm-section.tsx) and the Farm page's Positions view.
 * APY is real for Blend (supply APY) and Aquarius (pool APY); Soroswap's public testnet API exposes
 * no APY, so its row honestly reads 0%. There is no on-chain cost basis for farm positions yet, so
 * no "earned" figure is shown, and Farm Equity shows the current value only (no value-over-time
 * series). History merges the margin account's Blend / Aquarius / Soroswap add / remove events.
 */
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { IC, Icon } from "@/components/v3/icons";
import { pct, usd } from "@/components/v3/format";
import { VannaLoader } from "@/components/v3/vanna-loader";
import { useFarmStore } from "@/store/farm-store";
import {
  useUserBlendPositions,
  useAllAquariusLpPositions,
  useAllAquariusPoolStats,
  useBlendPoolStats,
  useBlendEvents,
  useAquariusEvents,
} from "@/hooks/use-farm";
import { useSoroswapPoolStats, useSoroswapLpPosition, useSoroswapEvents } from "@/hooks/use-soroswap";
import { AQUARIUS_POOLS, aquariusLpUnderlyingAmounts } from "@/lib/aquarius-utils";
import type { Portfolio } from "./use-portfolio";
import { Badge, ChartCard, Ct, Grid, HistNav, InfoCard, Success, TT, Tag, TokCell, TxCell, Venue, when } from "./pf-ui";

const HIST_COLS = ".9fr .9fr 1.8fr .9fr .7fr 1fr";
const POSITION_DUST = 1e-4;

/** Legacy table cell shape: the Farm detail page's add / remove forms read `selectedRow.cell`. */
type LegacyCell = { title?: string; description?: string; chain?: string; titles?: string[]; tags?: string[] };

interface FarmRow {
  id: string;
  protocol: "Blend" | "Aquarius" | "Soroswap";
  /** Logo token(s). */
  tokens: string[];
  label: string;
  kind: "Supply" | "LP";
  holdings: string;
  desc?: string;
  /** APY in % (null = none published). */
  apy: number | null;
  usd: number;
  /** Row handed to the Farm detail page (same shape as the previous Positions table). */
  legacy: { id: string; cell: LegacyCell[] };
}

/** Aquarius returns APY as a decimal string ("0.0234"); Blend as a percent string. */
const decApy = (raw?: string) => {
  const n = parseFloat(raw ?? "");
  return Number.isFinite(n) && n > 0 ? n * 100 : null;
};

export function TraderFarm({ p }: { p: Portfolio }) {
  const router = useRouter();
  const setFarmData = useFarmStore((s) => s.set);
  const [view, setView] = useState<"cur" | "hist">("cur");
  const [q, setQ] = useState("");
  const { priceOf } = p;
  const marginAccountAddress = p.store.marginAccountAddress;

  const { positions: blendPositions, isLoading: blendLoading } = useUserBlendPositions();
  const { stats: blendPoolStats } = useBlendPoolStats();
  const { stats: ssStats } = useSoroswapPoolStats(Boolean(marginAccountAddress));
  const { lpBalance: ssLpBalanceRaw } = useSoroswapLpPosition(marginAccountAddress);
  const mySSLpBalance = parseFloat(ssLpBalanceRaw ?? "0");
  const { positions: aqLpPositions } = useAllAquariusLpPositions(marginAccountAddress);
  const aquariusPools = useAllAquariusPoolStats();

  const rows = useMemo(() => {
    const out: FarmRow[] = [];

    (["XLM", "USDC"] as const)
      .filter((sym) => parseFloat(blendPositions[sym]?.underlyingValue ?? "0") > POSITION_DUST)
      .forEach((sym) => {
        const pos = blendPositions[sym];
        const amount = parseFloat(pos.underlyingValue || "0");
        // Display-only label; the legacy cell[0].title stays the raw "XLM"/"USDC" (read by
        // remove-liquidity.tsx's getInitialToken() when the user clicks through from this row).
        const symLabel = sym === "USDC" ? "BLUSDC" : sym;
        const apy = parseFloat(blendPoolStats[sym]?.supplyAPY ?? "");
        out.push({
          id: sym.toLowerCase(),
          protocol: "Blend",
          tokens: [symLabel],
          label: symLabel,
          kind: "Supply",
          holdings: `${amount.toFixed(4)} ${symLabel}`,
          desc: pos.bTokenBalance ? `${pos.bTokenBalance} b${sym}` : undefined,
          apy: Number.isFinite(apy) && apy > 0 ? apy : null,
          usd: amount * priceOf(symLabel),
          legacy: {
            id: sym.toLowerCase(),
            cell: [
              { chain: sym, title: sym, tags: ["Blend", "Supply"] },
              { title: "Blend" },
              { title: `${pos.underlyingValue} ${symLabel}`, description: pos.bTokenBalance ? `${pos.bTokenBalance} b${sym}` : undefined },
              { title: blendPoolStats[sym]?.supplyAPY ? `${blendPoolStats[sym]!.supplyAPY}%` : "0%" },
            ],
          },
        });
      });

    if (mySSLpBalance > POSITION_DUST) {
      const totalShares = parseFloat(ssStats?.totalShares ?? "0");
      const ratio = totalShares > 0 ? mySSLpBalance / totalShares : 0;
      const xlmShare = ratio * parseFloat(ssStats?.reserveXLM ?? "0");
      const usdcShare = ratio * parseFloat(ssStats?.reserveUSDC ?? "0");
      out.push({
        id: "soroswap-xlm-usdc",
        protocol: "Soroswap",
        tokens: ["XLM", "SOUSDC"],
        label: "XLM / SoUSDC",
        kind: "LP",
        holdings: `${mySSLpBalance.toFixed(2)} LP`,
        desc: `${xlmShare.toFixed(2)} XLM + ${usdcShare.toFixed(2)} SoUSDC`,
        apy: null,
        usd: xlmShare * priceOf("XLM") + usdcShare * priceOf("SOUSDC"),
        legacy: {
          id: "soroswap-xlm-usdc",
          // titles stays the raw functional pair — read by add/remove-liquidity's poolTokens detection.
          cell: [
            { chain: "XLM", titles: ["XLM", "USDC"], tags: ["Soroswap", "LP"] },
            { title: "Soroswap" },
            { title: `${mySSLpBalance.toFixed(2)} LP`, description: `${xlmShare.toFixed(2)} XLM + ${usdcShare.toFixed(2)} SoUSDC` },
            { title: "0%" },
          ],
        },
      });
    }

    AQUARIUS_POOLS.forEach((pool) => {
      const lpBal = parseFloat(aqLpPositions[pool.id] ?? "0");
      if (lpBal <= POSITION_DUST) return;
      const aqPoolStats = aquariusPools.find((x) => x.pool.id === pool.id)?.stats ?? null;
      const [tokenA, tokenB] = pool.tokens;
      const tokenBLabel = tokenB === "USDC" ? "AqUSDC" : tokenB;
      const { amountA: shareA, amountB: shareB } = aquariusLpUnderlyingAmounts(
        lpBal,
        aqPoolStats ?? { reserveA: "0", reserveB: "0", totalShares: "0", feeFraction: "0.30%", feeRaw: 30 },
        tokenA,
        tokenB,
      );
      const rawApy = aqPoolStats?.totalApy ?? aqPoolStats?.apy;
      out.push({
        id: pool.id,
        protocol: "Aquarius",
        tokens: [tokenA, tokenB === "USDC" ? "AQUSDC" : tokenB],
        label: `${tokenA} / ${tokenBLabel}`,
        kind: "LP",
        holdings: `${lpBal.toFixed(2)} LP`,
        desc: `${shareA.toFixed(2)} ${tokenA} + ${shareB.toFixed(2)} ${tokenBLabel}`,
        apy: decApy(rawApy),
        usd: shareA * priceOf(tokenA) + shareB * priceOf(tokenB === "USDC" ? "AQUSDC" : tokenB),
        legacy: {
          id: pool.id,
          cell: [
            { chain: tokenA, titles: [tokenA, tokenB], tags: ["Aquarius", "LP"] },
            { title: "Aquarius" },
            { title: `${lpBal.toFixed(2)} LP`, description: `${shareA.toFixed(2)} ${tokenA} + ${shareB.toFixed(2)} ${tokenBLabel}` },
            { title: decApy(rawApy) === null ? "0%" : `${decApy(rawApy)!.toFixed(2)}%` },
          ],
        },
      });
    });

    return out;
  }, [blendPositions, blendPoolStats, mySSLpBalance, ssStats, aqLpPositions, aquariusPools, priceOf]);

  const tot = rows.reduce((t, r) => t + r.usd, 0);
  const withApy = rows.filter((r) => r.apy !== null);
  const wBase = withApy.reduce((t, r) => t + r.usd, 0);
  const wApy = wBase > 0 ? withApy.reduce((t, r) => t + r.usd * (r.apy ?? 0), 0) / wBase : null;
  const holdings = p.acct.now?.holdings ?? 0;

  // Overall Farm TVL — every tracked Soroswap / Aquarius pool's reserves at live oracle prices
  // (Blend's pool-side TVL isn't exposed by the user-scoped Blend hook).
  const farmTvl = useMemo(() => {
    let total = 0;
    if (ssStats) {
      total += parseFloat(ssStats.reserveXLM || "0") * priceOf("XLM");
      total += parseFloat(ssStats.reserveUSDC || "0") * priceOf("SOUSDC");
    }
    aquariusPools.forEach(({ pool, stats }) => {
      if (!stats) return;
      const [tokenA, tokenB] = pool.tokens;
      total += parseFloat(stats.reserveA || "0") * priceOf(tokenA);
      total += parseFloat(stats.reserveB || "0") * priceOf(tokenB === "USDC" ? "AQUSDC" : tokenB);
    });
    return total;
  }, [ssStats, aquariusPools, priceOf]);

  // Position History — every add / remove the margin account made across Blend + Soroswap +
  // Aquarius (real on-chain events, Mercury + RPC fallback), newest first.
  const { events: blendEvents } = useBlendEvents();
  const { events: aqEvents } = useAquariusEvents(null, marginAccountAddress);
  const { events: ssEvents } = useSoroswapEvents(ssStats?.pairAddress, marginAccountAddress);
  const hist = useMemo(() => {
    if (!marginAccountAddress) return [];
    return [
      ...blendEvents.map((ev) => ({
        key: `blend:${ev.txHash}:${ev.type}:${ev.tokenSymbol}`,
        venue: "Blend",
        add: ev.type === "supply",
        amount: `${ev.underlyingAmount} ${ev.tokenSymbol}`,
        sym: ev.tokenSymbol === "USDC" ? "BLUSDC" : ev.tokenSymbol,
        hash: ev.txHash ?? "",
        timestamp: ev.timestamp,
      })),
      ...aqEvents.map((ev) => ({
        key: `aquarius:${ev.txHash}:${ev.type}`,
        venue: "Aquarius",
        add: ev.type === "deposit",
        amount: `${ev.shareAmount} LP`,
        sym: "AQUARIUS",
        hash: ev.txHash ?? "",
        timestamp: ev.timestamp,
      })),
      ...ssEvents.map((ev) => ({
        key: `soroswap:${ev.txHash}:${ev.type}`,
        venue: "Soroswap",
        add: ev.type === "deposit",
        amount: `${ev.shareAmount} LP`,
        sym: "SOROSWAP",
        hash: ev.txHash ?? "",
        timestamp: ev.timestamp,
      })),
    ].sort((a, b) => b.timestamp - a.timestamp);
  }, [marginAccountAddress, blendEvents, aqEvents, ssEvents]);

  // Same navigation as the Farm page's Positions tab: Blend rows open their single-asset page,
  // Soroswap / Aquarius LP rows their pool page.
  const open = useCallback(
    (r: FarmRow) => {
      setFarmData({ selectedRow: r.legacy, tabType: r.protocol === "Blend" ? "single" : "multi" });
      router.push(`/farm/${r.id}`);
    },
    [router, setFarmData],
  );
  const shown = rows.filter((r) => !q || `${r.label} ${r.protocol} ${r.kind}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <div className="pf-row2">
        <InfoCard
          title="Farming Info"
          rows={[
            ["Total Farm Value", usd(tot)],
            ["Active Positions", String(rows.length)],
            ["APY before borrow cost", pct(wApy ?? 0), wApy !== null && wApy > 0 ? "pf-up" : "", TT.farmApy],
            ["Share of Margin Account", pct(holdings > 0 ? (tot / holdings) * 100 : 0, 1), "", TT.farmShare],
            ["Overall Farm TVL", usd(farmTvl), "", TT.farmTvl],
          ]}
        />
        <ChartCard
          title="Farm Equity"
          value={usd(tot)}
          sub={`${rows.length} position${rows.length === 1 ? "" : "s"}`}
          series={null}
          empty="Value over time isn't recorded on-chain; the current figure is above."
        />
      </div>
      <section className="pf-tbl">
        <div className="pf-tbar">
          <HistNav value={view} onChange={setView} />
        </div>
        {view === "cur" && (
          <div className="pf-ftools">
            <label className="search pf-search">
              {IC.search}
              <input placeholder="Pools" aria-label="Search pools" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <span className="pf-flex" />
            <button type="button" className="pf-lnk" onClick={() => router.push("/farm")}>
              Open Farm
            </button>
          </div>
        )}
        {view === "hist" ? (
          <Grid
            cols={HIST_COLS}
            heads={["Date", "Type", "Amount", "Protocol", "Status", "Tx Hash"]}
            empty="No transactions yet"
            rows={hist.map((x) => ({
              key: x.key,
              cells: [
                <Ct key="d">{when(x.timestamp)}</Ct>,
                <Badge key="t" act={x.add ? "Supply" : "Withdraw"} />,
                <Ct key="a">
                  <Icon sym={x.sym} className="ico pf-i16" />
                  {x.amount}
                </Ct>,
                <Ct key="v">
                  <Venue name={x.venue} />
                </Ct>,
                <Success key="s" />,
                <TxCell key="h" sig={x.hash} />,
              ],
            }))}
          />
        ) : (
          <Grid
            cols="1.7fr 1.2fr 1.5fr .7fr .8fr"
            heads={["Asset", "Protocol", "Holdings", "APY", "Value"]}
            empty={q ? "No pools match" : blendLoading && !rows.length ? <VannaLoader size="block" /> : "No farm positions yet"}
            rows={shown.map((r) => ({
              key: r.id,
              onClick: () => open(r),
              cells: [
                <TokCell
                  key="a"
                  sym={r.tokens[0]}
                  label={r.label}
                  tags={
                    <>
                      <Tag cls="pf-t-ic">
                        <Icon sym={r.protocol} className="ico pf-i12" />
                        {r.protocol}
                      </Tag>
                      <Tag>{r.kind}</Tag>
                    </>
                  }
                />,
                <Ct key="p">
                  <Venue name={r.protocol} />
                </Ct>,
                <Ct key="h" desc={r.desc}>
                  {r.holdings}
                </Ct>,
                <Ct key="y">{pct(r.apy ?? 0)}</Ct>,
                <Ct key="v">{usd(r.usd)}</Ct>,
              ],
            }))}
          />
        )}
      </section>
    </>
  );
}
