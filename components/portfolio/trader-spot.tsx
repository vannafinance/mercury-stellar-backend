"use client";

/**
 * Portfolio → Trader → Spot: every token the margin account holds directly (XLM / BLUSDC / AQUSDC /
 * SOUSDC SAC balances from the margin store: deposits, borrowed proceeds and swapped tokens; Blend
 * supply and LP receipts live on the Farm tab), plus its swap history (Aquarius / Soroswap swaps via
 * `getSpotHistory`, Mercury + RPC). There is no on-chain entry price for Stellar spot balances, so no
 * P&L figure or chart is drawn — the card says so instead of showing a made-up number.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@/components/v3/icons";
import { tokFmt, usd } from "@/components/v3/format";
import { VannaLoader } from "@/components/v3/vanna-loader";
import { isTrackingSymbol } from "@/lib/account-snapshot";
import { canonicalMarginPositionToken } from "@/lib/margin-position-attribution";
import { getSpotHistory } from "@/lib/spot-history";
import type { Portfolio } from "./use-portfolio";
import { ChartCard, Ct, Grid, HistNav, InfoCard, Success, TT, TokCell, TxCell, Venue, when } from "./pf-ui";

/** Balances below this many tokens are dust and not listed (spot-section.tsx's rule). */
const POSITION_DUST = 1e-4;

/** One token the margin account holds. */
interface Holding {
  sym: string;
  amt: number;
  usd: number;
}

/** Swap legs carry contract symbols; show the app's names for the venue USDC wrappers. */
const swapSym = (s: string) => canonicalMarginPositionToken(s);

export function TraderSpot({ p }: { p: Portfolio }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [view, setView] = useState<"cur" | "hist">("cur");
  const marginAccountAddress = p.store.marginAccountAddress;
  const { collateralBalances } = p.store;
  const { priceOf } = p;

  const held = useMemo<Holding[]>(() => {
    const by = new Map<string, Holding>();
    for (const [raw, b] of Object.entries(collateralBalances)) {
      if (isTrackingSymbol(raw)) continue;
      const sym = canonicalMarginPositionToken(raw);
      const amt = parseFloat(b.amount || "0") || 0;
      if (!(amt > POSITION_DUST)) continue;
      const v = parseFloat(b.usdValue || "0") || amt * priceOf(sym);
      if (!by.has(sym) || amt > by.get(sym)!.amt) by.set(sym, { sym, amt, usd: v });
    }
    return [...by.values()].sort((a, b) => b.usd - a.usd);
  }, [collateralBalances, priceOf]);
  const size = held.reduce((t, x) => t + x.usd, 0);

  // Spot History — every margin-account swap (Aquarius + Soroswap), newest first. Same query key
  // as components/portfolio/spot-section.tsx, so the Spot page's swap invalidation refreshes it.
  const { data: swaps = [], isLoading: historyLoading } = useQuery({
    queryKey: ["spot", "history", marginAccountAddress ?? null],
    queryFn: () => getSpotHistory(marginAccountAddress),
    enabled: Boolean(marginAccountAddress),
    staleTime: 4_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });

  // Bootstrap catch-up: indexer lag / first-page Mercury misses on cold open.
  useEffect(() => {
    if (!marginAccountAddress) return;
    const timers = [1_500, 4_000, 8_000].map((d) =>
      window.setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ["spot", "history", marginAccountAddress] });
      }, d),
    );
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [marginAccountAddress, qc]);

  return (
    <>
      <div className="pf-row2">
        <InfoCard
          title="Spot Info"
          rows={[
            ["Open Size", usd(size), "", TT.spotSize],
            ["Assets Held", String(held.length)],
            ["Swaps", String(swaps.length)],
          ]}
        />
        <ChartCard
          title="Spot Balance"
          value={usd(size)}
          sub={held.length ? `${held.length} asset${held.length > 1 ? "s" : ""}` : "No balances"}
          series={null}
          empty="Spot P&L isn't recorded on-chain on Stellar (no entry prices); the current balance is above."
        />
      </div>
      <section className="pf-tbl">
        <div className="pf-tbar">
          <HistNav value={view} onChange={setView} labels={["Spot Balances", "Spot History"]} />
          <button type="button" className="pf-lnk" onClick={() => router.push("/trade/spot")}>
            Open Spot
          </button>
        </div>
        {view === "hist" ? (
          <Grid
            cols=".9fr .8fr 1.7fr .8fr .7fr 1fr"
            heads={["Date", "Type", "Amount", "Swap via", "Status", "Tx Hash"]}
            empty={historyLoading ? <VannaLoader size="block" /> : "No transactions yet"}
            rows={swaps.map((x, i) => ({
              key: `${x.txHash}-${i}`,
              cells: [
                <Ct key="d">{when(x.timestamp)}</Ct>,
                <span key="t" className="pf-badge pf-ok">
                  Swap
                </span>,
                <Ct key="a" desc={`→ ${tokFmt(parseFloat(x.amountOut) || 0, swapSym(x.tokenOut))}`}>
                  <Icon sym={swapSym(x.tokenIn)} className="ico pf-i16" />
                  {tokFmt(parseFloat(x.amountIn) || 0, swapSym(x.tokenIn))}
                </Ct>,
                <Ct key="v">
                  <Venue name={x.protocol === "aquarius" ? "Aquarius" : "Soroswap"} />
                </Ct>,
                <Success key="s" />,
                <TxCell key="h" sig={x.txHash} />,
              ],
            }))}
          />
        ) : (
          <Grid
            cols="1.2fr 1fr 1fr"
            heads={["Asset", "Balance", "Size (USD)"]}
            empty={p.acct.loading && !held.length ? <VannaLoader size="block" /> : "No tokens in your margin account"}
            rows={held.map((x) => ({
              key: x.sym,
              onClick: () => router.push("/trade/spot"),
              cells: [<TokCell key="a" sym={x.sym} />, <Ct key="b">{tokFmt(x.amt, x.sym)}</Ct>, <Ct key="s">{usd(x.usd)}</Ct>],
            }))}
          />
        )}
      </section>
    </>
  );
}
