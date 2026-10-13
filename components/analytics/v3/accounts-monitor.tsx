"use client";

/**
 * Accounts table (ported from the Solana analytics): filter / sort / search / paging over the live
 * protocol-wide snapshot, the connected wallet pinned on top ("YOU"), and row expansion with
 * collateral/debt lines and per-asset liquidation prices. The only maths here is the pure helpers
 * from lib/analytics/v3/model.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { clock, hfText, levText, num, pct, pct1, short, usd, usdC } from "@/lib/analytics/v3/format";
import { DEFAULT_SORT_DIR, inBand, liquidationPrices, matchesFilter, protocolsOf, searchRows, sortRows, type AccountFilter, type AccountRow, type AccountSortKey } from "@/lib/analytics/v3/model";
import { poolSymbolFor } from "@/lib/analytics/v3/pools";
import { accountHref } from "@/lib/analytics/v3/links";
import { lookupAddress, STELLAR_ADDR, useAnalyticsData, useYou } from "./data";
import { Addr, AssetCell, Empty, Icon, InfoTip, StatusBadge, statusTone, YouPill } from "./ui";
import { SERIES, Sparkline, StackBar } from "./charts";

const FILTERS: Array<[AccountFilter, string]> = [["all", "All"], ["liquidatable", "Liquidatable"], ["atrisk", "At risk"], ["healthy", "Safe"], ["nodebt", "No debt"]];
const FILTER_TONE: Partial<Record<AccountFilter, string>> = { liquidatable: "danger", atrisk: "warn", healthy: "ok" };
const TABS = [["health", "By health", "health"], ["leverage", "By leverage", "activity"]] as const;
type Tab = (typeof TABS)[number][0];
const PER = 10;
const COLS = 10;

/** Labels and colours for how collateral is held (shared by the table, the breakdown and the Overview donut). */
export const COMPOSITION = [["held", "Held in account", SERIES[0]], ["lending", "Blend deposits", SERIES[1]], ["lp", "Aquarius / Soroswap LP", SERIES[2]]] as const;

const hfClass = (r: AccountRow) => (r.healthFactor === null ? "an-na" : `an-${statusTone(r.status) === "ok" ? "ok" : statusTone(r.status)}`);
const hfCell = (r: AccountRow) => (r.healthFactor === null ? <span className="an-hf an-na">{r.status === "empty" ? "-" : "No debt"}</span> : <span className={`an-hf ${hfClass(r)}`}>{hfText(r.healthFactor)}</span>);
const protocolCell = (r: AccountRow) => { const p = protocolsOf(r); return p.length ? p.join(" · ") : <span className="an-muted">-</span>; };

export function AccountsMonitor({ band, onClearBand, title = "Accounts", fixedFilter }: { band: string | null; onClearBand: () => void; title?: string; fixedFilter?: AccountFilter }) {
  const router = useRouter();
  const { wallet, margin } = useYou();
  const data = useAnalyticsData();
  const [filter, setFilter] = useState<AccountFilter>(fixedFilter ?? "all");
  const [sort, setSort] = useState<AccountSortKey>("health");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [tab, setTab] = useState<Tab>("health");
  const [page, setPage] = useState(1);
  const section = useRef<HTMLElement>(null);
  // A page change starts at the top of the table: the last page is shorter, so staying put would leave the view below it.
  const goPage = (n: number) => { setPage(n); section.current?.scrollIntoView({ block: "start", behavior: "smooth" }); };
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [lookup, setLookup] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });

  useEffect(() => { const t = setTimeout(() => { setQ(text); setPage(1); }, 300); return () => clearTimeout(t); }, [text]);
  useEffect(() => { setPage(1); }, [band, filter]);
  // Arriving from an alert (/analytics?filter=atrisk#accounts): open that list and scroll to it.
  useEffect(() => {
    const f = new URLSearchParams(window.location.search).get("filter");
    if (f && !fixedFilter && FILTERS.some(([k]) => k === f)) { setFilter(f as AccountFilter); document.getElementById("accounts")?.scrollIntoView({ block: "start" }); }
  }, [fixedFilter]);

  const all = useMemo(() => data.rows ?? [], [data.rows]);
  const activeFilter = fixedFilter ?? filter;
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([k]) => [k, all.filter((r) => matchesFilter(r, k)).length])) as Record<AccountFilter, number>, [all]);
  const filtered = useMemo(
    () => sortRows(searchRows(all.filter((r) => matchesFilter(r, activeFilter) && (!band || inBand(r, band))), q), sort, dir === "asc" ? 1 : -1),
    [all, activeFilter, band, q, sort, dir],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PER));
  const safePage = Math.min(page, pages);
  const rows = filtered.slice((safePage - 1) * PER, safePage * PER);

  // Your own row is pinned on top only when it belongs in the list being shown (same filter and band, no search).
  const mineIdx = filtered.findIndex((r) => r.address === margin || (!!wallet && r.owner === wallet));
  const mine = mineIdx >= 0 ? filtered[mineIdx] : null;
  const pinned = mine && safePage === 1 && !q ? mine : null;
  const shown = pinned ? [pinned, ...rows.filter((r) => r.address !== pinned.address)] : rows;
  const filteredTotal = filtered.length, total = all.length;

  const th = (key: AccountSortKey, label: string, cls = "", tip?: Parameters<typeof InfoTip>[0]["k"]) => (
    <th className={cls}>
      <button type="button" className="an-sort" aria-sort={sort === key ? (dir === "asc" ? "ascending" : "descending") : undefined}
        onClick={() => { if (sort === key) setDir(dir === "asc" ? "desc" : "asc"); else { setSort(key); setDir(DEFAULT_SORT_DIR[key] === 1 ? "asc" : "desc"); } }}>
        {label}{sort === key ? (dir === "asc" ? " ↑" : " ↓") : ""}
      </button>
      {tip && <InfoTip k={tip} />}
    </th>
  );
  const heads = tab === "health"
    ? <><th></th><th>#</th><th>Wallet</th>{th("health", "Health", "an-r", "health")}<th>Health trend</th>{th("debt", "Total debt", "an-r")}<th>Collateral mix</th><th className="an-nowrap">Where it sits</th>{th("buffer", "Room to fall", "an-r")}{th("status", "Status", "", "status")}</>
    : <><th></th><th>#</th><th>Wallet</th>{th("leverage", "Leverage", "an-r")}{th("equity", "Own money", "an-r")}{th("collateral", "Collateral", "an-r")}{th("debt", "Borrowed", "an-r")}<th className="an-r">Debt ÷ collateral</th>{th("buffer", "Room to fall", "an-r")}{th("status", "Status", "", "status")}</>;

  const isAddress = STELLAR_ADDR.test(text.trim()) && !data.isLoading && shown.length === 0;
  async function doLookup() {
    setLookup({ loading: true, error: null });
    try {
      const addr = await lookupAddress(text.trim());
      router.push(accountHref(addr, "overview"));
    } catch (e) { setLookup({ loading: false, error: e instanceof Error ? e.message : "Lookup failed" }); }
  }

  return (
    <section className="an-panel an-flush an-scroll-top" id="accounts" ref={section}>
      <div className="an-panel-head">
        <div>
          <h2 className="an-panel-title">{title}</h2>
          <p className="an-panel-sub">{filteredTotal === total ? `${total} account${total === 1 ? "" : "s"}` : `${filteredTotal} of ${total} accounts`}</p>
        </div>
      </div>
      <div className="an-tabs" role="tablist" style={{ padding: "0 20px" }}>
        {TABS.map(([k, l, ic]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}><Icon name={ic} />{l}</button>)}
      </div>
      <div className="an-toolbar">
        {!fixedFilter && (
          <div className="an-seg" role="group" aria-label="Status filter">
            {FILTERS.filter(([k]) => k === "all" || counts[k] > 0 || filter === k).map(([k, l]) => (
              <button key={k} aria-pressed={filter === k} data-tone={FILTER_TONE[k]} onClick={() => setFilter(k)}>{FILTER_TONE[k] && <i className="an-dot" />}{l}<span className="an-muted"> {counts[k]}</span></button>
            ))}
          </div>
        )}
        {band && <span className="an-badge an-accent">Filtered by health band <button className="an-btn an-sm an-ghost" onClick={onClearBand}>Clear</button></span>}
        <span className="an-grow" />
        <label className="an-input-wrap"><Icon name="search" />
          <input className="an-input" placeholder="Search wallet or margin address" aria-label="Search accounts" value={text} onChange={(e) => setText(e.target.value)} style={{ width: 260 }} />
        </label>
      </div>
      <div className="an-table-wrap">
        <table className="an-t an-compact">
          <thead><tr>{heads}</tr></thead>
          <tbody>
            {shown.length ? shown.map((r, i) => {
              const isYou = r.address === margin || (!!wallet && r.owner === wallet);
              const isOpen = open.has(r.address);
              const tone = statusTone(r.status);
              const rank = isYou && mine?.address === r.address ? mineIdx + 1 : (safePage - 1) * PER + (pinned ? i : i + 1);
              return (
                <Fragment key={r.address}>
                  <tr className={`an-row-link ${tone === "danger" ? "an-tone-danger" : ""} ${isOpen ? "an-expanded" : ""} ${isYou ? "an-you" : ""}`} tabIndex={0} role="button" aria-expanded={isOpen}
                    onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(r.address)) n.delete(r.address); else n.add(r.address); return n; })}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); (e.currentTarget as HTMLElement).click(); } }}>
                    <td className="an-c" style={{ width: 26 }}><Icon name="chevron" className="an-chev" /></td>
                    <td className={isYou ? "an-you-rank" : "an-muted"} style={{ width: 30 }}>{rank}</td>
                    <td className="an-nowrap"><span className="an-strong" title={r.owner || r.address}>{short(r.owner || r.address, 5, 5)}</span><YouPill value={r.owner || r.address} /></td>
                    {tab === "health" ? (
                      <>
                        <td className="an-r">{hfCell(r)}</td>
                        <td><Sparkline w={72} values={r.hfTrend} label="Health factor readings" color={tone === "danger" ? "var(--danger-bar)" : tone === "warn" ? "var(--warn-bar)" : "var(--c2)"} /></td>
                        <td className="an-r">{usd(r.debtUsd)}</td>
                        <td>{r.collateralUsd > 0 ? <div style={{ width: 96 }}><StackBar segments={COMPOSITION.map(([k, l, c]) => ({ label: l, value: r.composition[k], color: c, tip: `${l} ${usd(r.composition[k])}` }))} /></div> : "-"}</td>
                        <td>{protocolCell(r)}</td>
                        <td className="an-r">{r.liquidatable ? <span className="an-strong" style={{ color: "var(--danger)" }}>Below the line</span> : r.bufferPct === null ? <span className="an-muted">-</span> : <><span className="an-strong">{pct1(r.bufferPct)}</span><small>{usdC(r.bufferUsd)}</small></>}</td>
                      </>
                    ) : (
                      <>
                        <td className="an-r"><span className="an-hf">{levText(r.leverage)}</span></td>
                        <td className="an-r">{usd(r.equityUsd)}</td>
                        <td className="an-r">{usd(r.collateralUsd)}</td>
                        <td className="an-r">{usd(r.debtUsd)}</td>
                        <td className="an-r">{r.collateralUsd > 0 ? pct1(r.debtUsd / r.collateralUsd) : "-"}</td>
                        <td className="an-r">{r.liquidatable ? <span style={{ color: "var(--danger)", fontWeight: 600 }}>Below the line</span> : r.bufferPct === null ? "-" : `−${pct1(r.bufferPct)}`}</td>
                      </>
                    )}
                    <td><StatusBadge row={r} /></td>
                  </tr>
                  {isOpen && <AccountDetail row={r} colSpan={COLS} prices={data.prices} />}
                </Fragment>
              );
            }) : (
              <tr><td colSpan={COLS}>
                {isAddress ? (
                  <div className="an-group-note" style={{ margin: "14px 20px" }}>
                    <div><b>Not in the list</b><span>Look up this address directly on-chain.</span></div>
                    <button className="an-btn an-sm" onClick={doLookup} disabled={lookup.loading}>{lookup.loading ? "Looking…" : "Look up"}</button>
                    {lookup.error && <p className="an-panel-foot" style={{ color: "var(--danger)", padding: "0 20px" }}>{lookup.error}</p>}
                  </div>
                ) : data.isLoading ? <Empty title="Loading accounts…" text="Reading every open margin account from Soroban." />
                  : total ? <Empty title="No accounts match" text="Adjust the status filter, band or search." icon="search" />
                  : <Empty title="No margin accounts found yet" text="Open margin accounts registered with the AccountManager appear here." />}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="an-table-foot">
        <span>{pinned ? "Your margin account is shown first; # is still your real rank in this list" : "Click a row for details · riskiest first"}</span>
        {pages > 1 && <Pager page={safePage} pages={pages} total={filteredTotal} per={PER} onPage={goPage} />}
      </div>
    </section>
  );
}

function Pager({ page, pages, total, per, onPage }: { page: number; pages: number; total: number; per: number; onPage: (n: number) => void }) {
  const nums: Array<number | "…"> = [];
  for (let i = 1; i <= pages; i++) { if (i === 1 || i === pages || Math.abs(i - page) <= 1) nums.push(i); else if (nums[nums.length - 1] !== "…") nums.push("…"); }
  return (
    <nav className="an-pager" aria-label="Pages">
      <span>{(page - 1) * per + 1}–{Math.min(total, page * per)} of {total}</span>
      <button className="an-btn an-sm" disabled={page === 1} onClick={() => onPage(page - 1)}>←</button>
      {nums.map((n, i) => n === "…" ? <span key={`e${i}`}>…</span> : <button key={n} className={`an-btn an-sm ${n === page ? "an-primary" : ""}`} aria-current={n === page ? "page" : undefined} onClick={() => onPage(n)}>{n}</button>)}
      <button className="an-btn an-sm" disabled={page === pages} onClick={() => onPage(page + 1)}>→</button>
    </nav>
  );
}

/** Row-expansion wrapper. */
function AccountDetail({ row, colSpan, prices }: { row: AccountRow; colSpan: number; prices: Record<string, number | null> }) {
  return (
    <tr className="an-detail"><td colSpan={colSpan}>
      <AccountDetailBody row={row} prices={prices} />
      <div className="an-detail-foot">
        <span>Liquidation price, price scenarios, how it ranks and its recent activity are on the full page.</span>
        <Link className="an-btn an-primary" href={accountHref(row.address, "overview")}>View full details <Icon name="arrow" /></Link>
      </div>
    </td></tr>
  );
}

/** Everything about one account: breakdown, liquidation prices, collateral and debt lines. */
export function AccountDetailBody({ row, prices }: { row: AccountRow; prices: Record<string, number | null> }) {
  const fact = (k: React.ReactNode, v: React.ReactNode) => <div><span>{k}</span><b>{v}</b></div>;
  const liq = liquidationPrices(row, prices);
  return (
      <div className="an-detail-body">
        <MarginBreakdown row={row} />
        <div className="an-facts">
          {fact("Owner", <Addr value={row.owner} />)}
          {fact("Margin account", <Addr value={row.address} />)}
          {fact("Equity", usd(row.equityUsd))}
          {fact("Leverage", levText(row.leverage))}
          {fact(<>Room before liquidation <InfoTip k="buffer" /></>, row.liquidatable ? "Already below the line" : row.bufferPct === null ? "-" : `${pct1(row.bufferPct)} · ${usd(row.bufferUsd)}`)}
          {fact("Read at", clock(row.readAt))}
        </div>
        {liq.length > 0 && (
          <div>
            <div className="an-eyebrow" style={{ marginBottom: 8 }}>Liquidation price <span className="an-muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>· calculated, if only that asset moves</span></div>
            <div className="an-breakdown">
              {liq.slice(0, 4).map((l) => (
                <div key={l.symbol} className="an-bcell"><span>{l.symbol} {l.direction === "down" ? "falls to" : "rises to"}</span><b>{usd(l.price)}</b><small>{l.change >= 0 ? "+" : "−"}{pct1(Math.abs(l.change))} from now</small></div>
              ))}
            </div>
          </div>
        )}
        <CollateralDebt row={row} />
      </div>
  );
}

/** Where the account's value sits: held in the account, Blend deposits, Aquarius / Soroswap LP. Nothing for an account with no value. */
export function MarginBreakdown({ row }: { row: AccountRow }) {
  const total = row.collateralUsd || 1;
  if (!(row.collateralUsd > 0)) return null;
  return (
    <div>
      <div className="an-eyebrow" style={{ marginBottom: 8 }}>Margin breakdown</div>
      <div className="an-breakdown">
        {COMPOSITION.map(([k, l, c]) => (
          <div key={k} className="an-bcell"><span><i style={{ background: c }} />{l}</span><b>{usd(row.composition[k])}</b><small>{pct1(row.composition[k] / total)} of account value</small></div>
        ))}
      </div>
    </div>
  );
}

/**
 * What the account holds and owes, as two tables, plus the note on idle borrowed funds. Shared by the
 * Overview dropdown and the account page.
 */
export function CollateralDebt({ row }: { row: AccountRow }) {
  // Same split as the Margin page: borrowed tokens still sitting in the account are "idle" (they belong to the loan);
  // the rest of that balance was deposited or bought. idle = min(balance held, debt in the same token).
  const key = (s: string) => poolSymbolFor(s) ?? s;
  const owed = new Map<string, number>();
  for (const d of row.debts) owed.set(key(d.symbol), (owed.get(key(d.symbol)) ?? 0) + d.amount);
  const DUST_USD = 0.01;
  const lines = row.collateral.flatMap((l) => {
    if (l.kind !== "held") return [{ ...l, key: l.symbol }];
    const idle = Math.min(l.amount, owed.get(key(l.symbol)) ?? 0);
    const px = l.amount > 0 ? l.usd / l.amount : 0;
    return (l.amount - idle) * px > DUST_USD ? [{ ...l, amount: l.amount - idle, usd: (l.amount - idle) * px, key: l.symbol }] : [];
  });
  // Idle funds are the borrowed tokens still in the account: shown with the loan (Debt), not as collateral, but still counted in health.
  const heldAmount = new Map<string, number>();
  for (const l of row.collateral.filter((c) => c.kind === "held")) heldAmount.set(key(l.symbol), (heldAmount.get(key(l.symbol)) ?? 0) + l.amount);
  const idleOf = (symbol: string) => Math.min(heldAmount.get(key(symbol)) ?? 0, owed.get(key(symbol)) ?? 0);
  const idleUsd = row.debts.reduce((s, d) => s + (d.amount > 0 ? Math.min(idleOf(d.symbol), d.amount) * (d.usd / d.amount) : 0), 0);
  const depositedUsd = lines.reduce((s, l) => s + l.usd, 0) || 1;

  return (
    <>
      <div className="an-detail-cols">
        <section className="an-dcard"><h4>Collateral</h4>
          {lines.length ? (
            <table className="an-t"><thead><tr><th>Asset</th><th className="an-r">Amount</th><th className="an-r">Value</th><th className="an-r">Share</th></tr></thead>
              <tbody>{lines.map((l) => (
                <tr key={l.key}>
                  <td className="an-nowrap">
                    <span className="an-assetrow">
                    <AssetCell symbol={l.symbol} sub={l.kind === "lending" ? "Blend deposit" : l.kind === "lp" ? "LP position" : ""} size="sm" />
                    {l.kind === "lp" && <span className="an-tag" data-tip="A liquidity position, valued as one amount by the Risk Engine." tabIndex={0}>LP</span>}
                    </span>
                  </td>
                  <td className="an-r">{num(l.amount)}</td><td className="an-r">{usd(l.usd)}</td><td className="an-r">{pct1(l.usd / depositedUsd)}</td>
                </tr>
              ))}</tbody></table>
          ) : <p className="an-muted an-dcard-empty">No active collateral.</p>}
        </section>
        <section className="an-dcard"><h4>Debt</h4>
          {row.debts.length ? (
            <table className="an-t"><thead><tr><th>Asset</th><th className="an-r">Debt</th><th className="an-r">Value</th><th className="an-r">APR</th></tr></thead>
              <tbody>{row.debts.map((l) => (
                <tr key={l.symbol}><td className="an-nowrap"><span className="an-assetrow"><AssetCell symbol={l.symbol} sub="" size="sm" />
                  {Math.min(idleOf(l.symbol), l.amount) * (l.amount > 0 ? l.usd / l.amount : 0) > DUST_USD && <span className="an-tag" data-tip="Borrowed funds still in the account. They count toward health until used or repaid." tabIndex={0}>{num(Math.min(idleOf(l.symbol), l.amount))} idle</span>}</span></td><td className="an-r">{num(l.amount)}</td><td className="an-r">{usd(l.usd)}</td><td className="an-r">{pct(l.borrowApr)}</td></tr>
              ))}</tbody></table>
          ) : <p className="an-muted an-dcard-empty">No outstanding debt.</p>}
        </section>
      </div>
      {idleUsd > DUST_USD && <p className="an-panel-foot" style={{ padding: 0 }}>The account value above also includes {usd(idleUsd)} of borrowed funds still idle in the account (shown with the debt). They count toward health until they are used or repaid.</p>}
    </>
  );
}
