"use client";

/**
 * The pool page's tabs (V3 design `#earn-<SYM>`): Positions, Details, Activity, Collateral and
 * Limits, Analytics. Every figure is on-chain or indexed: live pool stats (GET /api/pools), the
 * wallet's vToken position, its supply / withdraw events (Mercury + RPC fallback, wallet-scoped),
 * Reflector oracle prices, and the deployed RateModelContract's own borrow-rate curve.
 */
import { useMemo, useState, type ReactNode } from "react";
import toast from "react-hot-toast";
import { useQuery } from "@tanstack/react-query";
import { Info, Modal } from "@/components/v3/ui";
import { usd } from "@/components/v3/format";
import { VannaLoader } from "@/components/v3/vanna-loader";
import { LIQ_HF } from "@/lib/account-model";
import { ContractService } from "@/lib/stellar-utils";
import { calculateSupplyAPY } from "@/lib/pool-stats";
import type { EarnTxEntry } from "@/lib/mercury-earn";
import { ChartCard, EarnChart } from "./earn-chart";
import { Customize, LiveTable, type Cell, type Col, type Row } from "./earn-table";
import { NoData, Pie, SV, usePop } from "./earn-ui";
import { fL, fLoc, fP, fT, fU, fXr, shortAddr, usdOr } from "./earn-format";
import { EARN_POOLS, explorerAccount, explorerContract, explorerTx, poolAddresses, type EarnPoolDef } from "./earn-pools";
import { seriesFor, useEarnV3 } from "./use-earn-v3";
import type { Tf } from "./earn-series";

type D = ReturnType<typeof useEarnV3>;

/** Small stat block (`.earn-sc`). */
function StatCard({ h, main, sub, tip }: { h: string; main: string; sub?: string; tip?: string }) {
  return (
    <div className="earn-sc">
      <div className="earn-sch">
        {h}
        {tip && <Info text={tip} />}
      </div>
      <div className="earn-scv num">{main}</div>
      {sub && <div className="earn-scs num">{sub}</div>}
    </div>
  );
}

/** Ring + figures card (`.earn-pc`). */
function PieCard({ pct, h, main, sub, tip }: { pct: number; h: string; main: string; sub: string; tip?: string }) {
  return (
    <div className="earn-pc">
      <div className="earn-pcp">
        <Pie pct={pct} size={79} stroke={7} />
        <span className="num">{fP(pct)}</span>
      </div>
      <div className="earn-pct">
        <div className="earn-sch">
          {h}
          {tip && <Info text={tip} />}
        </div>
        <div className="earn-pcv num">{main}</div>
        <div className="earn-scs num">{sub}</div>
      </div>
    </div>
  );
}

/** Supply / withdraw history cells (design `histCells`). */
function histCells(h: EarnTxEntry, sym: string, price: number): Cell[] {
  const d = new Date(h.timestamp);
  const amt = parseFloat(h.amount) || 0;
  return [
    { t: h.timestamp ? d.toLocaleDateString("en-US") : "N/A", d: h.timestamp ? d.toLocaleTimeString("en-US") : "", v: h.timestamp },
    { node: <span className={`earn-badge ${h.type === "supply" ? "g" : "o"}`}>{h.type === "supply" ? "Supply" : "Withdraw"}</span>, t: h.type, text: h.type },
    { ic: sym, t: `${fLoc(amt, 6)} ${sym}`, text: h.amount, v: amt, d: price > 0 ? usd(amt * price) : "" },
    { node: <span className="earn-badge g">Success</span>, t: "Success" },
    h.hash
      ? {
          node: (
            <a className="earn-hash" href={explorerTx(h.hash)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
              {h.hash.slice(0, 8)}…{h.hash.slice(-4)}
            </a>
          ),
          t: h.hash,
        }
      : { t: "N/A" },
  ];
}
const HIST_COLS: Col[] = [
  { id: "date", label: "Date" },
  { id: "type", label: "Type" },
  { id: "amt", label: "Amount" },
  { id: "st", label: "Status" },
  { id: "tx", label: "Tx Hash" },
];

/** This pool's events for the connected wallet, newest first. */
const poolHistory = (d: D, def: EarnPoolDef) => (d.address ? d.transactions.filter((h) => h.asset === def.key).sort((a, b) => b.timestamp - a.timestamp) : []);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Details
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Statistics, supplied / borrowed rings, the pool's figures and the on-chain addresses. */
export function TabDetails({ def, d }: { def: EarnPoolDef; d: D }) {
  const sym = def.sym;
  const p = d.pools[def.key];
  const px = d.prices[def.key];
  const u = (n: number) => (px > 0 ? `$${fL(n * px)}` : `$${fL(0)}`);

  if (d.poolsLoading) {
    return (
      <section className="earn-det" aria-label="Vault Details">
        <div className="earn-detin">
          <h2>Statistics</h2>
          <NoData text={<VannaLoader size="block" caption="Loading vault statistics" />} />
          <div style={{ height: 20 }} />
        </div>
      </section>
    );
  }
  const util = Math.max(0, Math.min(100, p.utilization));
  const supPct = p.totalSupplied > 0 ? 100 - util : 0;
  const grid: [string, string, string | undefined, string][] = [
    ["Available Liquidity", `${fL(p.availableLiquidity)} ${sym}`, u(p.availableLiquidity), `Total ${sym} available for borrowing (and for suppliers to withdraw).`],
    ["Supply APY", fP(p.supplyApy), `${fL(p.totalSupplied)} ${sym}`, "Yearly interest suppliers earn now: borrow APY × utilization (borrower interest flows to suppliers in full)."],
    ["Borrow APY", fP(p.borrowApy), undefined, "Yearly interest borrowers pay now, read live from the on-chain rate model; it moves with utilization."],
    ["Utilization Rate", fP(p.utilization), undefined, "Ratio of borrowed assets to supplied assets."],
    ["Liquidation Penalty", "Dynamic Range", "0–15%", "Penalty applied during liquidation events."],
    ["Oracle Price", px > 0 ? `$${px.toFixed(px < 1 ? 4 : 2)}` : usd(0), def.priceSym === "USDC" ? "USDC oracle price" : undefined, `Current oracle price of ${sym}.`],
    ["Share Token Exchange Rate", fXr(p.exchangeRate), `${sym} per v${sym}`, `Exchange rate between v${sym} and ${sym}; it rises as interest accrues.`],
    ["vToken Supply", `${fL(p.vTokenSupply)} v${sym}`, undefined, `All v${sym} share tokens in circulation.`],
  ];
  const copy = (s: string) => {
    navigator.clipboard?.writeText(s).then(
      () => toast.success("Copied to clipboard"),
      () => toast.error("Clipboard blocked"),
    );
  };
  return (
    <section className="earn-det" aria-label="Vault Details">
      <div className="earn-detin">
        <h2>Statistics</h2>
        <article className="earn-pies" aria-label="Supply and Borrow Overview">
          <PieCard pct={supPct} h="Total Supplied" main={`${fL(p.totalSupplied)} ${sym}`} sub={u(p.totalSupplied)} tip={`All ${sym} supplied to this vault; the ring shows the part not borrowed.`} />
          <PieCard pct={util} h="Total Borrowed" main={`${fL(p.totalBorrowed)} ${sym}`} sub={u(p.totalBorrowed)} tip={`${sym} borrowed from this vault by margin accounts; the ring shows utilization.`} />
        </article>
        <article className="earn-sgrid" aria-label="Vault Statistics">
          {grid.map(([h, m, s, tp]) => (
            <StatCard key={h} h={h} main={m} sub={s} tip={tp} />
          ))}
        </article>
        <article className="earn-addrs" aria-label="On-chain Addresses">
          <h3>Addresses</h3>
          <div className="earn-agrid">
            {poolAddresses(def).map(([h, v]) => (
              <div key={h} className="earn-ad">
                <div className="earn-sch">{h}</div>
                <div className="earn-adr">
                  <span>{v ? shortAddr(v) : "N/A"}</span>
                  {v && (
                    <>
                      <button type="button" className="earn-adb" aria-label="Copy address" onClick={() => copy(v)}>
                        {SV.copy}
                      </button>
                      <a className="earn-adb" href={explorerContract(v)} target="_blank" rel="noopener noreferrer" aria-label="Open in explorer">
                        {SV.link}
                      </a>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Positions
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** My Supply chart, then the current position / position history (or the no-position card). */
export function TabPositions({ def, d }: { def: EarnPoolDef; d: D }) {
  const [tf, setTf] = useState<Tf>("All Time");
  const [mp, setMp] = useState<"current" | "history">("current");
  const [hideCur, setHideCur] = useState<string[]>([]);
  const [hideHist, setHideHist] = useState<string[]>([]);
  const pop = usePop();
  const sym = def.sym;
  const connected = Boolean(d.address);
  const pool = d.pools[def.key];
  const px = d.prices[def.key];
  const v = d.supplied[def.key];
  const has = connected && v > 0;
  const apy = pool.supplyApy;
  const hs = useMemo(() => poolHistory(d, def), [d, def]);
  const myValue = connected ? v * px : 0;

  const my = useMemo(() => (connected ? seriesFor(tf, [def.key], d.seriesInput, d.now, myValue) : { pts: [], excluded: [] }), [connected, tf, def.key, d.seriesInput, d.now, myValue]);
  const noHistory = !hs.length && !has;
  const note = !has
    ? null
    : !(px > 0)
      ? `No oracle price for ${sym} right now.`
      : my.excluded.includes(def.key)
        ? "Past values can't be rebuilt from your indexed history, so only today's value is drawn."
        : "Past points replay your supplied amounts; today's point includes accrued interest.";

  const earnedE = d.earned[def.key];
  const curCols: Col[] = [
    { id: "pool", label: "Pool" },
    { id: "sh", label: "Vault Shares" },
    { id: "sup", label: `${sym} Supplied` },
    { id: "usd", label: "USD Value" },
    { id: "apy", label: "APY" },
    { id: "earn", label: "Interest Earned" },
  ];
  const curRows: Row[] = has
    ? [
        {
          key: "d",
          cells: [
            { ic: sym, t: sym, tags: ["Vanna", "Vault"] },
            { t: `${fT(d.shares[def.key])} v${sym}` },
            { t: `${fT(v)} ${sym}` },
            { t: fU(px > 0 ? v * px : 0) },
            { t: fP(apy) },
            earnedE.earned === null
              ? { t: `${fT(0)} ${sym}`, d: earnedE.reason ?? <VannaLoader size="inline" caption="Reading history" /> }
              : { t: `${fT(earnedE.earned)} ${sym}`, d: px > 0 ? usd(earnedE.earned * px) : "" },
          ],
        },
      ]
    : [];
  const histRows: Row[] = hs.map((h) => ({ key: `${h.hash}:${h.type}`, cells: histCells(h, sym, px) }));
  const cur = mp === "current";

  return (
    <section className="earn-ypos" aria-label="Your Positions Overview">
      <figure className="earn-myc">
        <ChartCard
          className="my"
          label="My Supply"
          value={usd(myValue)}
          tf={tf}
          onTf={setTf}
          pts={noHistory ? [] : my.pts}
          kind="my"
          h={320}
          mobile={false}
          empty={connected ? "No supply position yet" : "Connect your wallet to see your supply"}
          note={note}
        />
      </figure>
      <article className="earn-ypa" aria-label="My Position">
        {!connected || noHistory ? (
          <div className="earn-nopos">
            <span className="earn-noic">{SV.layers}</span>
            <div>
              <p className="t">No active position</p>
              <p className="s">Supply liquidity to start earning {sym} yield</p>
            </div>
            <div className="earn-noapy">
              <div>
                <span>Current Supply APY</span>
                <b className="num">{fP(apy)}</b>
              </div>
              <span className="earn-acc">{SV.clock}Accrues every ledger</span>
            </div>
          </div>
        ) : (
          <>
            <div className="earn-mph">
              <h2>My Position</h2>
              <Customize
                popId="cust"
                cols={cur ? curCols : HIST_COLS}
                hidden={cur ? hideCur : hideHist}
                onChange={cur ? setHideCur : setHideHist}
                open={pop.open === "cust"}
                onToggle={() => pop.toggle("cust")}
              />
            </div>
            <nav className="earn-seg sm" aria-label="Position tabs">
              <button type="button" className={cur ? "on" : ""} onClick={() => setMp("current")}>
                Current Position
              </button>
              <button type="button" className={cur ? "" : "on"} onClick={() => setMp("history")}>
                Position History
              </button>
            </nav>
            {cur ? (
              curRows.length ? <LiveTable cols={curCols} rows={curRows} hidden={hideCur} /> : <NoData text="No active position" />
            ) : histRows.length ? (
              <LiveTable cols={HIST_COLS} rows={histRows} hidden={hideHist} />
            ) : (
              <NoData text="No transactions yet" />
            )}
          </>
        )}
      </article>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Activity
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Pool composition (idle vs borrowed, from the live pool stats) and the connected wallet's own
 * supply / withdraw events for this pool. (A per-holder distribution needs a vToken-holder index
 * that isn't available, so it is not shown.)
 */
export function TabActivity({ def, d }: { def: EarnPoolDef; d: D }) {
  const sym = def.sym;
  const p = d.pools[def.key];
  const px = d.prices[def.key];
  const connected = Boolean(d.address);
  const avail = p.availableLiquidity;
  const bor = p.totalBorrowed;
  const total = p.totalSupplied;
  const sh = total > 0 ? Math.min(100, (avail / total) * 100) : 0;
  const comp: Row[] =
    total > 0
      ? [
          { key: "a", cells: [{ ic: sym, t: "Available liquidity" }, { ic: sym, t: `${fLoc(avail, 4)} ${sym}`, d: usdOr(avail, px) }, { pie: sh, t: fP(sh) }] },
          { key: "b", cells: [{ ic: sym, t: "Borrowed by margin accounts" }, { ic: sym, t: `${fLoc(bor, 4)} ${sym}`, d: usdOr(bor, px) }, { pie: 100 - sh, t: fP(100 - sh) }] },
        ]
      : [];
  const hs = poolHistory(d, def);
  const txRows: Row[] = hs.length
    ? hs.map((h) => ({ key: `${h.hash}:${h.type}`, cells: histCells(h, sym, px) }))
    : [{ key: "none", cells: [{ t: "None", d: connected && d.historyLoading ? <VannaLoader size="inline" label="Loading transactions" /> : "No transactions yet" }, { t: "N/A" }, { t: `0 ${sym}` }, { t: "N/A" }, { t: "None" }] }];
  return (
    <section className="earn-act" aria-label="Activity Overview">
      <h2>Pool Composition</h2>
      {comp.length ? (
        <LiveTable
          cols={[
            { id: "b", label: "Bucket" },
            { id: "a", label: "Assets" },
            { id: "s", label: "Share of Supply (%)" },
          ]}
          rows={comp}
        />
      ) : (
        <NoData text={d.poolsLoading ? <VannaLoader /> : "This pool has no supply yet"} />
      )}
      <div className="earn-acth">
        <h3>Your Recent Transactions</h3>
        <span className="num">
          {hs.length} transaction{hs.length === 1 ? "" : "s"}
        </span>
      </div>
      <LiveTable cols={HIST_COLS} rows={txRows} />
      {!connected ? (
        <div className="earn-actnote">Connect your wallet to see your supply / withdraw activity.</div>
      ) : (
        <div className="earn-actnote">
          <a className="earn-hash" href={explorerAccount(d.address!)} target="_blank" rel="noopener noreferrer">
            View all your transactions on Stellar Expert
          </a>
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Collateral and Limits
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Account-wide liquidation rule and every pool's live borrow usage (borrowed of supplied). The
 * Stellar lending pools expose no supply / borrow cap or per-asset collateral parameters on-chain
 * to the app, so those tables are not drawn rather than shown with made-up limits.
 */
export function TabCollateral({ d }: { d: D }) {
  if (d.poolsLoading) return <NoData text={<VannaLoader size="block" caption="Loading collateral and limits" />} />;
  const rows: Row[] = EARN_POOLS.map((pd) => {
    const p = d.pools[pd.key];
    return {
      key: pd.sym,
      cells: [
        { ic: pd.sym, t: pd.sym, d: `v${pd.sym} Pool` },
        { t: "", bar: { pct: Math.max(0, Math.min(100, p.utilization)), v: `${fT(p.totalBorrowed)} of ${fT(p.totalSupplied)} ${pd.sym} borrowed` } },
      ],
    };
  });
  return (
    <section className="earn-coll" aria-label="Collateral Limits Overview">
      <article className="earn-hfc" aria-label="Account-wide Liquidation Rule">
        <span className="t">Account-wide health factor</span>
        <span className="s">
          A margin account&apos;s health factor is the sum of collateral value ÷ the sum of debt value across all assets. It becomes liquidatable at HF {LIQ_HF.toFixed(2)} or below;
          borrowed tokens stay in the margin account and count as collateral.
        </span>
      </article>
      <article aria-label="Borrow Usage">
        <LiveTable
          cols={[
            { id: "a", label: "Assets" },
            { id: "u", label: "Borrow Usage" },
          ]}
          rows={rows}
          cls="cap"
        />
      </article>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Analytics
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Matches RateModelContract's own SECS_PER_YEAR_U128 (same constant lib/pool-stats.ts uses). */
const SECS_PER_YEAR = 31_556_952;
/** Utilization samples for the curve (every 5%). */
const CURVE_STEPS = Array.from({ length: 21 }, (_, i) => i * 5);

/**
 * Borrow APY (%) at each sampled utilization, read from the deployed RateModelContract's
 * `get_borrow_rate_per_sec(liquidity_wad, borrows_wad)` — the exact curve the lending pools accrue
 * with (all pools share the one rate model). Sampled at the pool's order of magnitude (so the
 * 21 reads aren't repeated every time the pool's size moves a little); a failed read leaves that
 * point out instead of guessing it.
 */
function useRateCurve(total: number) {
  const size = total > 0 ? 10 ** Math.ceil(Math.log10(total)) : 1000;
  return useQuery({
    // Not under ["earn"]: the post-tx earn re-sync shouldn't re-read the (unchanged) rate model.
    queryKey: ["rateModel", "curve", size],
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    queryFn: async () => {
      const toWad = (n: number) => BigInt(Math.floor(n * 1e7)) * BigInt(10 ** 11);
      const out = await Promise.all(
        CURVE_STEPS.map(async (u) => {
          const borrows = (size * u) / 100;
          const rate = await ContractService.getBorrowRatePerSecWad(toWad(size - borrows), toWad(borrows));
          return rate === null ? null : { u, borrow: Number(rate * BigInt(SECS_PER_YEAR)) / 1e16 };
        }),
      );
      return out.filter((x): x is { u: number; borrow: number } => x !== null);
    },
  });
}

/**
 * Deposit / Borrow APY now, and the pool's real rate curve (APY at every utilization, from the
 * on-chain rate model). The design's APY-history chart is not drawn: no indexer records past
 * rates, and a made-up history would be fake data.
 */
export function TabAnalytics({ def, d }: { def: EarnPoolDef; d: D }) {
  const [kind, setKind] = useState<"Deposit APY" | "Borrow APY">("Deposit APY");
  const [expanded, setExpanded] = useState(false);
  const pop = usePop();
  const p = d.pools[def.key];
  const curve = useRateCurve(p.totalSupplied);
  const cur = kind === "Borrow APY" ? p.borrowApy : p.supplyApy;
  const pts = useMemo(
    () =>
      (curve.data ?? []).map((q) => ({
        t: q.u,
        // Supply APY = borrow APY × utilization (lib/pool-stats calculateSupplyAPY), same as the live figure.
        v: kind === "Borrow APY" ? q.borrow : parseFloat(calculateSupplyAPY(q.borrow, String(q.u))),
      })),
    [curve.data, kind],
  );
  const [ts] = useState(() => new Date().toLocaleString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }));
  const util = p.utilization;
  const tipSub = (q: { t: number }) => `at ${q.t}% utilization${Math.abs(q.t - util) < 2.5 ? " (now)" : ""}`;
  const empty = curve.isLoading ? <VannaLoader caption="Reading the on-chain rate model" /> : "Rate model unavailable right now";
  return (
    <section className="earn-an" aria-label="Analytics Dashboard">
      <div className="earn-cc an">
        <div className="earn-cch">
          <div className="earn-anl">
            <div className="earn-apsw" data-earn-pop="apysel">
              <button type="button" className="earn-aps" aria-expanded={pop.open === "apysel"} onClick={() => pop.toggle("apysel")}>
                {kind} {SV.chev14}
              </button>
              {pop.open === "apysel" && (
                <div className="pop earn-pop apysel">
                  {(["Deposit APY", "Borrow APY"] as const).map((x) => (
                    <button
                      key={x}
                      type="button"
                      className={x === kind ? "on" : ""}
                      onClick={() => {
                        setKind(x);
                        pop.close();
                      }}
                    >
                      {x}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p className="num v">{fP(cur)}</p>
            <time className="num">
              {ts} · utilization {fP(util)}
            </time>
          </div>
          <button type="button" className="earn-exp" aria-label="Expand chart" onClick={() => setExpanded(true)}>
            {SV.expand}
          </button>
        </div>
        <div className="earn-ccr">
          <span className="earn-note">
            Rate curve: {kind === "Borrow APY" ? "borrow" : "supply"} APY at each utilization (x-axis), from the on-chain rate model
          </span>
        </div>
        <EarnChart pts={pts} kind="curve" h={393} tipSub={tipSub} empty={empty} />
      </div>
      {expanded && <AnalyticsModal kind={kind} cur={cur} pts={pts} tipSub={tipSub} empty={empty} onClose={() => setExpanded(false)} />}
    </section>
  );
}

/** Expanded rate-curve chart. */
function AnalyticsModal({
  kind,
  cur,
  pts,
  tipSub,
  empty,
  onClose,
}: {
  kind: string;
  cur: number;
  pts: { t: number; v: number }[];
  tipSub: (q: { t: number }) => string;
  empty: ReactNode;
  onClose: () => void;
}) {
  return (
    <Modal wide className="earn-xmodal" onClose={onClose}>
      <div className="earn earn-xm">
        <div className="earn-xmh">
          <div>
            <h2>{kind}</h2>
            <p className="num">{fP(cur)}</p>
          </div>
        </div>
        <EarnChart pts={pts} kind="curve" h={450} tipSub={tipSub} empty={empty} />
      </div>
    </Modal>
  );
}
