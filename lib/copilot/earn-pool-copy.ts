import type { AnswerFact, StructuredAnswer } from "./answer-schema";

/**
 * The figures the Earn pool read (`vanna_get_pool_stats`) actually returns.
 *
 * Declared once and used both for the row type below and to recognise a question that
 * this read can answer — see {@link namesEarnPoolMetric}. Adding a figure to the read
 * adds it here, and both follow.
 */
export const EARN_POOL_METRIC_FIELDS = [
  "supply_apy_pct",
  "borrow_apr_pct",
  "utilization_pct",
  "total_assets_human",
  "total_liquidity_human",
] as const;

export type EarnPoolRow = {
  symbol: string;
  error?: unknown;
} & Partial<Record<(typeof EARN_POOL_METRIC_FIELDS)[number], unknown>>;

/**
 * Does this question name a figure the Earn pool read returns?
 *
 * "What is the XLM supply APY" was answered with a chip — "XLM is on more than one
 * surface. Earn is the lending pool; Farm is Blend / LP. Which one?" — and adding the
 * word "earn" to the same sentence produced the APY immediately. The chip exists for a
 * question about the SURFACE ("how is my XLM pool doing?"), where there is genuinely
 * nothing to pick between; a question that names a figure has already said what it wants,
 * and Earn is the lending pool that publishes it.
 *
 * The vocabulary is the read's own field list, not a phrase list: each field's leading
 * token is the thing being asked for (supply, borrow, utilization, total). A figure added
 * to the read is recognised the same day it ships, and no wording is enumerated anywhere.
 */
export function namesEarnPoolMetric(text: string): boolean {
  const words = new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);
  return EARN_POOL_METRIC_FIELDS.some((field) => words.has(field.split("_")[0]!));
}

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
