import type { AnswerFact, StructuredAnswer } from "./answer-schema";

export type EarnPoolRow = {
  symbol: string;
  supply_apy_pct?: unknown;
  borrow_apr_pct?: unknown;
  utilization_pct?: unknown;
  total_assets_human?: unknown;
  total_liquidity_human?: unknown;
  error?: unknown;
};

function pct(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "n/a";
}

function amount(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "n/a";
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function earnPoolRateLine(r: EarnPoolRow): string {
  if (r.error) return `${r.symbol} unavailable (${String(r.error)})`;
  return (
    `${r.symbol} has a supply of ${pct(r.supply_apy_pct)}, ` +
    `borrow of ${pct(r.borrow_apr_pct)} and utilization of ${pct(r.utilization_pct)}`
  );
}

export function earnPoolSizeFacts(r: EarnPoolRow): AnswerFact[] {
  if (r.error) return [];
  return [
    { label: `${r.symbol} Supplied`, value: amount(r.total_assets_human) },
    { label: `${r.symbol} Available`, value: amount(r.total_liquidity_human) },
  ];
}

export function earnPoolStructuredAnswer(opts: {
  rows: EarnPoolRow[];
  usdcOnly?: boolean;
  wantHighest?: boolean;
  compareHead?: string | null;
}): StructuredAnswer {
  const rows = opts.rows;
  const winner = [...rows]
    .filter((r) => r.supply_apy_pct != null && !r.error)
    .sort((a, b) => Number(b.supply_apy_pct) - Number(a.supply_apy_pct))[0];

  const headline = opts.compareHead
    ? opts.compareHead
    : opts.wantHighest && winner
      ? `${winner.symbol} pays the most right now at ${pct(winner.supply_apy_pct)} supply APY.`
      : rows.length === 1 && !opts.usdcOnly
        ? `${rows[0].symbol} Earn pool`
        : opts.usdcOnly
          ? `Vanna currently has ${rows.length} USDC earn pools:`
          : `Vanna currently has ${rows.length} earn pools:`;

  const sections = rows.map((r) => ({
    body: earnPoolRateLine(r),
    facts: earnPoolSizeFacts(r),
  }));

  const note =
    opts.compareHead || opts.wantHighest
      ? undefined
      : winner
        ? `Currently, ${winner.symbol} pays the most, at ${pct(winner.supply_apy_pct)}.`
        : undefined;

  return {
    headline,
    facts: [],
    sections,
    note,
    venue: "none",
  };
}
