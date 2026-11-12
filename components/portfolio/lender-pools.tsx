"use client";

/**
 * Portfolio → Lender → Lending pools: Lender Stats, the Lending P&L card and the Positions Table
 * (Current position | Position history). Positions = the wallet's Vanna lending supply at the pool's
 * exchange rate (`useUserPositions`), APY from the pools route (`usePoolData`), interest and history
 * from the CONNECTED wallet's own supply / withdraw events (`useEarnTransactions`, Mercury + RPC).
 * Supply more / Withdraw hand off to the Earn pool page, whose form runs the real supply / redeem.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon, IC } from "@/components/v3/icons";
import { pct, sUsd, tokFmt, usd } from "@/components/v3/format";
import { VannaLoader } from "@/components/v3/vanna-loader";
import type { Portfolio } from "./use-portfolio";
import { LEND_ASSETS, lendSym } from "./portfolio-math";
import { Badge, ChartCard, Ct, Dropdown, EYE_IC, FILTER_IC, Grid, HistNav, InfoCard, Success, TT, Tag, TxCell, when } from "./pf-ui";

const HIST_COLS = ".9fr .9fr 1.8fr .7fr 1fr";
const HIST_HEADS = ["Date", "Type", "Amount", "Status", "Tx Hash"];
const COLS = ["Amount Supplied", "Supply APY", "Earned", "Value"] as const;
type Col = (typeof COLS)[number];

export function LendingPools({ p }: { p: Portfolio }) {
  const router = useRouter();
  const [view, setView] = useState<"cur" | "hist">("cur");
  const [pool, setPool] = useState("All");
  const [hide, setHide] = useState<Col[]>([]);
  const { priceOf, deposited, pools, earn, earned } = p;

  const rows = useMemo(
    () =>
      LEND_ASSETS.map(({ asset, sym, route }) => {
        const amt = deposited[asset] ?? 0;
        const e = earned[asset] ?? null;
        const px = priceOf(sym);
        return {
          asset,
          sym,
          route,
          amt,
          apy: parseFloat(pools[asset]?.supplyAPY ?? "0") || 0,
          val: amt * px,
          earned: e,
          earnUsd: e === null ? null : e * px,
        };
      }).filter((r) => r.amt > 0),
    [deposited, pools, earned, priceOf],
  );
  const sup = rows.reduce((t, r) => t + r.val, 0);
  const avgApy = sup > 0 ? rows.reduce((t, r) => t + r.val * r.apy, 0) / sup : 0;
  const lendEarned = p.totals.lendEarned;

  const stats = (
    <InfoCard
      title="Lender Stats"
      rows={[
        ["Total Holdings", usd(sup), "", TT.holdings],
        ["Supplied Assets", String(rows.length)],
        ["Avg Supply APY", pct(avgApy), rows.length ? "pf-up" : ""],
        ["Interest earned", sUsd(lendEarned), lendEarned > 0.004 ? "pf-up" : "", TT.lendInt],
      ]}
    />
  );
  // The chain keeps no exchange-rate series for Stellar supply events, so only the current
  // figure is shown (no fabricated curve).
  const chart = (
    <ChartCard
      title="Lending P&L"
      value={sUsd(lendEarned)}
      sub="Interest earned"
      series={null}
      empty={earn.isLoading ? <VannaLoader size="block" /> : "Interest over time isn't recorded on-chain; the current figure is above."}
    />
  );

  const history = earn.transactions.filter((x) => pool === "All" || lendSym(x.asset) === pool);
  if (!rows.length && !earn.transactions.length)
    return (
      <>
        <div className="pf-row2">
          {stats}
          {chart}
        </div>
        <div className="pf-emptyc">
          {p.lendLoading || earn.isLoading ? (
            <VannaLoader size="block" caption="Loading lending positions" />
          ) : (
            "No lending positions yet. Supply assets on the Earn page to start earning."
          )}
          <button type="button" className="pf-lnk" onClick={() => router.push("/earn")}>
            Go to Earn
          </button>
        </div>
      </>
    );

  const colDefs: [Col, string, (r: (typeof rows)[number]) => React.ReactNode][] = [
    ["Amount Supplied", "1.3fr", (r) => <Ct tags={<Tag>{usd(r.val)}</Tag>}>{tokFmt(r.amt, r.sym)}</Ct>],
    // A live but tiny rate reads "<0.01%", not a flat 0.00%.
    ["Supply APY", ".8fr", (r) => <Ct>{r.apy > 0 && r.apy < 0.005 ? "<0.01%" : pct(r.apy)}</Ct>],
    [
      "Earned",
      ".9fr",
      (r) =>
        r.earnUsd === null ? (
          <Ct desc="supply history not indexed yet">{usd(0)}</Ct>
        ) : (
          <Ct desc={tokFmt(r.earned ?? 0, r.sym)}>
            <span className={r.earnUsd > 0.004 ? "pos" : ""}>{sUsd(r.earnUsd)}</span>
          </Ct>
        ),
    ],
    ["Value", "1fr", (r) => <Ct>{usd(r.val)}</Ct>],
  ];
  const vis = colDefs.filter((c) => !hide.includes(c[0]));
  // Earn pool route ids: XLM, BLUSDC, AqUSDC, SoUSDC (app/earn/[id] maps them to the pool).
  const goEarn = (route: string, action?: "supply" | "withdraw") =>
    router.push(`/earn/${route}?tab=your-positions${action ? `&action=${action}` : ""}`);
  const poolSyms = Array.from(new Set([...rows.map((r) => r.sym), ...earn.transactions.map((x) => lendSym(x.asset))]));

  const filter = (
    <Dropdown
      right
      trigger={(open, toggle) => (
        <button type="button" className="pf-allf" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
          <b>{pool === "All" ? "All:" : "Pool:"}</b>
          {pool === "All" ? (
            FILTER_IC
          ) : (
            <>
              <Icon sym={pool} className="ico pf-i16" />
              <span className="pf-allv">{pool}</span>
            </>
          )}
        </button>
      )}
    >
      {(close) =>
        ["All", ...poolSyms].map((x) => (
          <button
            key={x}
            type="button"
            className={`mi ${pool === x ? "on" : ""}`}
            onClick={() => {
              setPool(x);
              close();
            }}
          >
            {x === "All" ? (
              <>
                <span className="pf-mi-ic">{FILTER_IC}</span>All pools
              </>
            ) : (
              <>
                <Icon sym={x} className="ico pf-i20" />
                {x}
              </>
            )}
            {pool === x && <span className="pf-mi-ok">{IC.check}</span>}
          </button>
        ))
      }
    </Dropdown>
  );
  const customize = (
    <Dropdown
      right
      trigger={(open, toggle) => (
        <button type="button" className="pf-cust" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
          {EYE_IC}Customize {IC.chev}
        </button>
      )}
    >
      {() => (
        <>
          <div className="pf-pop-h">Columns</div>
          {COLS.map((c) => (
            <button key={c} type="button" className="mi" onClick={() => setHide((h) => (h.includes(c) ? h.filter((x) => x !== c) : [...h, c]))}>
              <span className={`pf-cb ${hide.includes(c) ? "" : "on"}`}>{IC.check}</span>
              {c}
            </button>
          ))}
        </>
      )}
    </Dropdown>
  );

  return (
    <>
      <div className="pf-row2">
        {stats}
        {chart}
      </div>
      <section className="pf-tbl">
        <header className="pf-tblh">
          <h2>Positions Table</h2>
          <div className="pf-tools">
            {filter}
            {view === "cur" && customize}
          </div>
        </header>
        <div className="pf-tbar">
          <HistNav value={view} onChange={setView} />
        </div>
        {view === "hist" ? (
          <Grid
            cols={HIST_COLS}
            heads={HIST_HEADS}
            empty={earn.isLoading ? <VannaLoader size="block" /> : "No transactions yet"}
            rows={history.map((x, i) => {
              const sym = lendSym(x.asset);
              const amt = parseFloat(x.amount) || 0;
              return {
                key: `${x.hash}-${x.type}-${x.asset}-${i}`,
                cells: [
                  <Ct key="d">{when(x.timestamp)}</Ct>,
                  <Badge key="t" act={x.type === "supply" ? "Supply" : "Withdraw"} />,
                  <Ct key="a" desc={usd(amt * priceOf(sym))}>
                    <Icon sym={sym} className="ico pf-i16" />
                    {(x.type === "supply" ? "+" : "−") + tokFmt(amt, sym)}
                  </Ct>,
                  <Success key="s" />,
                  <TxCell key="h" sig={x.hash} />,
                ],
              };
            })}
          />
        ) : (
          <Grid
            cols={["1fr", ...vis.map((c) => c[1]), "1.25fr"].join(" ")}
            heads={["Pool", ...vis.map((c) => c[0]), ""]}
            empty="No positions in this pool"
            rows={rows
              .filter((r) => pool === "All" || r.sym === pool)
              .map((r) => ({
                key: r.asset,
                onClick: () => goEarn(r.route),
                cells: [
                  <>
                    <span className="pf-pool">
                      <Icon sym={r.sym} className="ico pf-i16" />
                      {r.sym}
                    </span>
                    <span className="pf-tags">
                      <Tag cls="pf-t-on">Active</Tag>
                    </span>
                  </>,
                  ...vis.map((c) => c[2](r)),
                  <span className="pf-acts" key="acts">
                    <button
                      type="button"
                      className="pf-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        goEarn(r.route, "supply");
                      }}
                    >
                      Supply more
                    </button>
                    <button
                      type="button"
                      className="pf-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        goEarn(r.route, "withdraw");
                      }}
                    >
                      Withdraw
                    </button>
                  </span>,
                ],
              }))}
          />
        )}
      </section>
    </>
  );
}
