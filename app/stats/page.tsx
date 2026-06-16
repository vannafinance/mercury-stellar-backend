"use client";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

import { useHubble, HubbleNotConfiguredError } from "@/hooks/use-hubble";
import type {
  TvlPoint,
  VolumePoint,
  TopBorrower,
  LiquidationRow,
} from "@/lib/hubble/types";

const short = (addr: string) =>
  addr && addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);

/** Shared panel shell: title + loading / not-configured / error / empty / content. */
function Panel<T>({
  title,
  query,
  empty,
  children,
}: {
  title: string;
  query: { data?: T[]; isLoading: boolean; error: unknown };
  empty: string;
  children: (rows: T[]) => React.ReactNode;
}) {
  const { data, isLoading, error } = query;
  const notConfigured = error instanceof HubbleNotConfiguredError;

  return (
    <div className="rounded-xl border border-vgray-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-vgray-700">{title}</h2>
      {isLoading ? (
        <p className="text-sm text-vgray-400">Loading…</p>
      ) : notConfigured ? (
        <p className="text-sm text-amber-600">
          Hubble not connected yet — add <code>GOOGLE_CREDS_JSON</code> to enable.
        </p>
      ) : error ? (
        <p className="text-sm text-red-500">
          {error instanceof Error ? error.message : "Failed to load"}
        </p>
      ) : !data || data.length === 0 ? (
        <p className="text-sm text-vgray-400">{empty}</p>
      ) : (
        children(data)
      )}
    </div>
  );
}

export default function StatsPage() {
  const tvl = useHubble<TvlPoint>("tvl", "/api/analytics/tvl");
  const volume = useHubble<VolumePoint>("volume", "/api/analytics/volume");
  const borrowers = useHubble<TopBorrower>("top-borrowers", "/api/analytics/top-borrowers");
  const liquidations = useHubble<LiquidationRow>("liquidations", "/api/analytics/liquidations");

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-6 p-6">
      <header className="space-y-2">
        <h1 className="text-xl font-bold text-vgray-800">Protocol Stats</h1>
        <p className="text-sm text-vgray-500">
          Protocol-wide analytics from Hubble (Stellar BigQuery). Cached ~5 min.
        </p>
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Source: Stellar Hubble indexes <strong>pubnet (mainnet)</strong> only. On testnet these
          panels stay empty — they populate once the protocol is live on mainnet.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title="Deposit / Withdraw flow (90d)" query={tvl} empty="No flow in range.">
          {(rows) => (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={rows}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} minTickGap={24} />
                <YAxis tick={{ fontSize: 11 }} width={56} />
                <Tooltip />
                <Line type="monotone" dataKey="deposits" stroke="#16a34a" dot={false} />
                <Line type="monotone" dataKey="withdrawals" stroke="#dc2626" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Panel>

        <Panel title="Daily borrow volume (90d)" query={volume} empty="No borrows in range.">
          {(rows) => (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={rows}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} minTickGap={24} />
                <YAxis tick={{ fontSize: 11 }} width={56} />
                <Tooltip />
                <Bar dataKey="volume" fill="#2563eb" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Panel>

        <Panel title="Top borrowers (all-time)" query={borrowers} empty="No borrowers yet.">
          {(rows) => (
            <ul className="divide-y divide-vgray-100 text-sm">
              {rows.slice(0, 20).map((b, i) => (
                <li key={b.account} className="flex items-center justify-between py-2">
                  <span className="text-vgray-500">
                    {i + 1}. <span className="font-mono text-vgray-700">{short(b.account)}</span>
                  </span>
                  <span className="font-semibold text-vgray-800">{fmt(b.total_borrowed)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Recent liquidations" query={liquidations} empty="No liquidations recorded.">
          {(rows) => (
            <ul className="divide-y divide-vgray-100 text-sm">
              {rows.map((l) => (
                <li key={l.transaction_hash} className="flex items-center justify-between py-2">
                  <span className="font-mono text-vgray-700">{short(l.account)}</span>
                  <span className="text-vgray-400">
                    {new Date(l.closed_at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
