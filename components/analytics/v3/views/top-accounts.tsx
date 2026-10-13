"use client";

/** Top accounts: how concentrated the debt is, the largest borrowers, and a feed of recent activity. */
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { sortRows } from "@/lib/analytics/v3/model";
import { hfText, levText, pct1, short, usd } from "@/lib/analytics/v3/format";
import { accountHref } from "@/lib/analytics/v3/links";
import type { LiveWhaleActivityRow } from "@/lib/analytics/stellar/eventFeed";
import { useAnalyticsData, useLiveEventFeed } from "../data";
import { Badge, Empty, Kpi, Panel, StatusBadge, When, YouPill } from "../ui";
import { ViewHead } from "../shell";

const WAIT = "Waiting for accounts";
const PER = 10;
type Action = LiveWhaleActivityRow["action"] | "LIQUIDATED";
const FEED: Array<[string, string, Action[]]> = [
  ["all", "All", ["INCREASE_LEVERAGE", "DECREASE_LEVERAGE", "OPEN_POSITION", "LIQUIDATED", "DEPOSIT", "WITHDRAW"]],
  ["borrow", "Borrow & repay", ["INCREASE_LEVERAGE", "DECREASE_LEVERAGE"]],
  ["lending", "Lending", ["DEPOSIT", "WITHDRAW"]],
  ["accounts", "New & liquidated", ["OPEN_POSITION", "LIQUIDATED"]],
];
const LABEL: Record<Action, string> = {
  INCREASE_LEVERAGE: "Borrowed", DECREASE_LEVERAGE: "Repaid debt", OPEN_POSITION: "Opened a margin account", LIQUIDATED: "Liquidated",
  DEPOSIT: "Supplied to a pool", WITHDRAW: "Withdrew from a pool", CLOSE_POSITION: "Closed a position",
};
const TONE: Record<Action, "ok" | "warn" | "danger" | "accent" | "neutral"> = {
  INCREASE_LEVERAGE: "warn", DECREASE_LEVERAGE: "ok", OPEN_POSITION: "accent", LIQUIDATED: "danger", DEPOSIT: "ok", WITHDRAW: "warn", CLOSE_POSITION: "neutral",
};

export function TopAccountsView() {
  const d = useAnalyticsData();
  const { data: ev } = useLiveEventFeed();
  const router = useRouter();
  const [page, setPage] = useState(1);
  const section = useRef<HTMLElement>(null);
  const goPage = (n: number) => { setPage(n); section.current?.scrollIntoView({ block: "start", behavior: "smooth" }); };
  const [feed, setFeed] = useState("all");
  const s = d.summary;
  const ok = !!s && s.borrowers > 0;
  const c = s?.concentration;
  const borrowers = useMemo(() => sortRows((d.rows ?? []).filter((r) => r.debtUsd > 0), "debt", -1), [d.rows]);
  const pages = Math.max(1, Math.ceil(borrowers.length / PER));
  const rows = borrowers.slice((page - 1) * PER, page * PER);

  const names = FEED.find((f) => f[0] === feed)![2];
  const events = useMemo(() => {
    const list: Array<{ id: string; action: Action; account: string; details: string; amountUsd: number; timestamp: number }> = [
      ...(ev?.whaleActivity ?? []).map((e, i) => ({ id: `${e.txHash || "w"}-${e.action}-${i}`, action: e.action as Action, account: e.account, details: e.details, amountUsd: e.amountUsd, timestamp: e.timestamp })),
      ...(ev?.liquidations ?? []).map((e, i) => ({ id: `${e.txHash}-liq-${i}`, action: "LIQUIDATED" as Action, account: e.account, details: "", amountUsd: 0, timestamp: e.timestamp })),
    ];
    return list.filter((e) => names.includes(e.action)).sort((a, b) => b.timestamp - a.timestamp).slice(0, 40);
  }, [ev, names]);

  return (
    <>
      <ViewHead title="Top accounts" blurb="How concentrated the debt is, who owes the most, and what has been happening." />
      <div className="an-kpi-grid an-cols-3">
        <Kpi label="Largest borrower" value={ok && c?.top1 != null ? pct1(c.top1) : "-"} na={!ok} sub={ok ? "Share of all debt owed by one account" : s ? "No account has debt" : WAIT} />
        <Kpi label="Top 3 borrowers" value={ok && c?.top3 != null ? pct1(c.top3) : "-"} na={!ok} sub={ok ? `${s!.borrowers} account${s!.borrowers === 1 ? "" : "s"} with debt in total` : s ? "No account has debt" : WAIT} />
        <Kpi label="Concentration index" tip="hhi" value={ok && c?.hhi != null ? Math.round(c.hhi).toLocaleString("en-US") : "-"} na={!ok} sub={ok ? "0 = spread out · 10,000 = one borrower" : s ? "No account has debt" : WAIT} />
      </div>

      <section className="an-panel an-flush an-scroll-top" id="borrowers" ref={section}>
        <div className="an-panel-head"><div><h2 className="an-panel-title">Largest borrowers</h2><p className="an-panel-sub">Margin accounts by debt</p></div></div>
        <div className="an-table-wrap"><table className="an-t">
          <thead><tr><th>#</th><th>Wallet</th><th className="an-r">Debt</th><th className="an-r">Share of debt</th><th className="an-r">Health</th><th className="an-r">Leverage</th><th>Status</th></tr></thead>
          <tbody>
            {rows.length ? rows.map((r, i) => (
              <tr key={r.address} className="an-row-link" tabIndex={0} role="link" onClick={() => router.push(accountHref(r.address, "top"))}
                onKeyDown={(e) => { if (e.key === "Enter") router.push(accountHref(r.address, "top")); }}>
                <td className="an-muted">{(page - 1) * PER + i + 1}</td>
                <td className="an-nowrap"><Link href={accountHref(r.address, "top")} className="an-acct-link" title="Open this account" onClick={(e) => e.stopPropagation()}>{short(r.owner || r.address, 5, 5)}</Link><YouPill value={r.owner || r.address} /></td>
                <td className="an-r">{usd(r.debtUsd)}</td>
                <td className="an-r">{s && s.debtUsd > 0 ? pct1(r.debtUsd / s.debtUsd) : "-"}</td>
                <td className="an-r">{hfText(r.healthFactor)}</td>
                <td className="an-r">{levText(r.leverage)}</td>
                <td><StatusBadge row={r} /></td>
              </tr>
            )) : <tr><td colSpan={7}><Empty title={d.rows ? "No account has debt" : "Loading…"} text={d.rows ? "Borrowers appear here once a margin account owes money." : undefined} /></td></tr>}
          </tbody>
        </table></div>
        {pages > 1 && (
          <div className="an-table-foot"><span>{(page - 1) * PER + 1}–{Math.min(borrowers.length, page * PER)} of {borrowers.length}</span>
            <span className="an-pager"><button className="an-btn an-sm" disabled={page === 1} onClick={() => goPage(page - 1)}>←</button><button className="an-btn an-sm" disabled={page >= pages} onClick={() => goPage(page + 1)}>→</button></span></div>
        )}
      </section>

      <Panel title="Recent activity" sub="AccountManager and lending-pool events from the last ~24 hours of ledgers · older history is not covered" tip="coverage"
        actions={<div className="an-seg" role="group" aria-label="Activity type">{FEED.map(([k, l]) => <button key={k} aria-pressed={feed === k} onClick={() => setFeed(k)}>{l}</button>)}</div>}>
        {events.length ? (
          <div className="an-feed">{events.map((e) => (
            <div className="an-feed-item" key={e.id}>
              <div className={`an-feed-icon an-${TONE[e.action] ?? "neutral"}`}>{e.action === "LIQUIDATED" ? "!" : e.action === "INCREASE_LEVERAGE" ? "↓" : e.action === "DECREASE_LEVERAGE" ? "↑" : "•"}</div>
              <div className="an-feed-main"><b>{LABEL[e.action] ?? e.action}</b><p>{e.account ? `${e.account.startsWith("C") ? "Account" : "Wallet"} ${short(e.account, 5, 5)}` : "Address not emitted"}{e.details ? ` · ${e.details}` : ""}{e.amountUsd > 0 ? ` · ${usd(e.amountUsd)}` : ""}</p></div>
              <div className="an-feed-meta"><When t={e.timestamp} /><br /><Badge tone={TONE[e.action] ?? "neutral"}>{LABEL[e.action] ?? e.action}</Badge></div>
            </div>
          ))}</div>
        ) : <Empty title={ev ? "No activity of this kind in the last ~24 hours" : "Loading…"} text={ev ? "Try another type, or come back later." : undefined} />}
      </Panel>
    </>
  );
}
