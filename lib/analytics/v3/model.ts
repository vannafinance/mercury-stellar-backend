/**
 * The V3 analytics account model for Stellar: maps the protocol-wide margin-account snapshots
 * (`AccountSnapshot[]`, read from the Registry + each smart account on Soroban) into the row shape the
 * Solana-style analytics screens render, and aggregates them. Pure: no network, no DOM, no invented
 * inputs - everything comes from the snapshots and the live pool / oracle reads passed in.
 *
 * Health factor follows the Soroban RiskEngine (lib/account-model.ts): Σ collateral ÷ Σ debt,
 * unweighted, liquidatable at or below LIQ_HF (1.10).
 */
import { LIQ_HF, priceKey } from "@/lib/account-model";
import type { AccountSnapshot } from "@/lib/analytics/onchain/types";

/** The protocol's liquidation line (RiskEngine `BALANCE_TO_BORROW_THRESHOLD`). */
export const LIQUIDATION_LINE = LIQ_HF;

/**
 * Display-only bands layered on the liquidation line. They are labels for reading the picture, not
 * protocol parameters: an account is "At risk" below WARNING, "Critical" at or below CRITICAL.
 */
export const DISPLAY_BANDS = { critical: 1.2, warning: 1.5 } as const;
export const BUFFER_ZONE_UPPER = 1.3;

export type AccountStatus = "empty" | "nodebt" | "healthy" | "warning" | "critical" | "liquidatable";

/** How a collateral line is held: a token in the account, a Blend deposit (tracking token), or an Aquarius / Soroswap LP position. */
export type PositionKind = "held" | "lending" | "lp";

export interface CollateralLine {
  symbol: string;
  kind: PositionKind;
  /** The price this line follows (a Blend tracking token → its underlying; an LP position → itself). */
  underlying: string;
  amount: number;
  usd: number;
}

export interface DebtLine {
  symbol: string;
  amount: number;
  usd: number;
  /** Current borrow APR of the pool this debt was taken from (0..1), or null when not read. */
  borrowApr: number | null;
}

export interface AccountRow {
  /** Owner wallet (`G…`), or "" when it is not known. */
  owner: string;
  /** Margin (smart) account (`C…`). */
  address: string;
  status: AccountStatus;
  collateralUsd: number;
  debtUsd: number;
  equityUsd: number;
  /** null = no debt. */
  healthFactor: number | null;
  /** Collateral ÷ equity; null without debt or without positive equity. */
  leverage: number | null;
  /** Share of collateral value that can disappear before liquidation. */
  bufferPct: number | null;
  bufferUsd: number | null;
  liquidatable: boolean;
  collateral: CollateralLine[];
  debts: DebtLine[];
  composition: { held: number; lending: number; lp: number };
  /** Health readings taken by THIS browser on each refresh while the page is open (oldest first). Not chain history. */
  hfTrend: number[];
  /** Wall-clock ms when the snapshot was read. */
  readAt: number;
}

export interface Band { key: string; label: string; tone: "danger" | "critical" | "warn" | "ok"; count: number; debtUsd: number; collateralUsd: number }
export interface LeverageBin { key: string; label: string; count: number; debtUsd: number }
export interface AssetTotal { symbol: string; kind: PositionKind | "debt"; amount: number; usd: number; accounts: number }

export interface AccountsSummary {
  total: number;
  /** Accounts with debt. */
  borrowers: number;
  collateralUsd: number;
  debtUsd: number;
  equityUsd: number;
  liquidatableCount: number;
  liquidatableDebtUsd: number;
  liquidatableCollateralUsd: number;
  atRiskCount: number;
  atRiskDebtUsd: number;
  atRiskCollateralUsd: number;
  badDebtUsd: number;
  underwaterCount: number;
  /** Debt-weighted: Σcollateral / Σdebt over accounts with debt. */
  averageHealth: number | null;
  averageLeverage: number | null;
  /** Debt within the buffer zone just above liquidation. */
  bufferZoneDebtUsd: number;
  healthBands: Band[];
  leverageBins: LeverageBin[];
  composition: { held: number; lending: number; lp: number };
  concentration: { top1: number | null; top3: number | null; hhi: number | null };
  collateralBy: AssetTotal[];
  debtBy: AssetTotal[];
  statusCounts: Record<AccountStatus, number>;
}

export type AccountSortKey = "health" | "debt" | "collateral" | "equity" | "leverage" | "buffer" | "status";
export type AccountFilter = "all" | "liquidatable" | "atrisk" | "healthy" | "nodebt" | "withdebt";

// ---- classification -------------------------------------------------------------------------------

export function kindOf(symbol: string): PositionKind {
  const u = symbol.toUpperCase();
  if (u.startsWith("BLEND_")) return "lending";
  if (u.startsWith("AQ_") || u.startsWith("SS_")) return "lp";
  return "held";
}

/** The price a collateral line follows: Blend tracking tokens follow their underlying, LP positions are their own thing. */
export function underlyingOf(symbol: string): string {
  const kind = kindOf(symbol);
  if (kind === "lending") return priceKey(symbol.slice("BLEND_".length));
  if (kind === "lp") return symbol;
  return priceKey(symbol);
}

/** Plain name for a collateral line's symbol (tracking and LP symbols are on-chain codes). */
export function lineName(symbol: string): string {
  const u = symbol.toUpperCase();
  if (u.startsWith("BLEND_")) return `Blend deposit · ${u.slice(6)}`;
  if (u.startsWith("AQ_")) return `Aquarius LP · ${u.slice(3).replace(/_/g, "/")}`;
  if (u.startsWith("SS_")) return `Soroswap LP · ${u.slice(3).replace(/_/g, "/")}`;
  return "";
}

/** Status from the account's exact totals. */
export function classify(input: { collateralUsd: number; debtUsd: number; healthFactor: number | null; liquidatable: boolean }): AccountStatus {
  if (input.collateralUsd === 0 && input.debtUsd === 0) return "empty";
  if (input.debtUsd === 0) return "nodebt";
  if (input.liquidatable) return "liquidatable";
  const hf = input.healthFactor ?? Infinity;
  return hf <= DISPLAY_BANDS.critical ? "critical" : hf < DISPLAY_BANDS.warning ? "warning" : "healthy";
}

/** Derived figures for an account. */
export function derivedFigures(collateralUsd: number, debtUsd: number) {
  const equityUsd = collateralUsd - debtUsd;
  const healthFactor = debtUsd > 0 ? collateralUsd / debtUsd : null;
  return {
    equityUsd,
    healthFactor,
    leverage: debtUsd > 0 && equityUsd > 0 ? collateralUsd / equityUsd : null,
    liquidatable: healthFactor !== null && healthFactor <= LIQUIDATION_LINE,
    // Collateral value that can disappear (debt held constant) before the liquidation line.
    bufferPct: debtUsd > 0 && collateralUsd > 0 ? Math.max(0, 1 - (LIQUIDATION_LINE * debtUsd) / collateralUsd) : null,
    bufferUsd: debtUsd > 0 ? collateralUsd - LIQUIDATION_LINE * debtUsd : null,
  };
}

const finiteOr0 = (v: number) => (Number.isFinite(v) ? v : 0);

/**
 * One analytics row per margin account. `aprFor(debtSymbol)` gives the live borrow APR of the pool a
 * debt line belongs to; `trend` holds the health readings this browser has seen for each account.
 */
export function buildRows(snapshots: AccountSnapshot[], aprFor: (symbol: string) => number | null, trend: Map<string, number[]>, readAt: number): AccountRow[] {
  return snapshots.map((s) => {
    const collateral: CollateralLine[] = s.collateral
      .filter((c) => c.amount > 0 || c.usd > 0)
      .map((c) => ({ symbol: c.symbol, kind: kindOf(c.symbol), underlying: underlyingOf(c.symbol), amount: finiteOr0(c.amount), usd: finiteOr0(c.usd) }));
    const debts: DebtLine[] = s.debt
      .filter((d) => d.amount > 0 || d.usd > 0)
      .map((d) => ({ symbol: d.symbol, amount: finiteOr0(d.amount), usd: finiteOr0(d.usd), borrowApr: aprFor(d.symbol) }));
    const collateralUsd = finiteOr0(s.totalCollateralUsd);
    const debtUsd = finiteOr0(s.totalDebtUsd);
    const f = derivedFigures(collateralUsd, debtUsd);
    const composition = { held: 0, lending: 0, lp: 0 };
    for (const l of collateral) composition[l.kind] += l.usd;
    return {
      owner: s.ownerProxy ?? "",
      address: s.account,
      status: classify({ collateralUsd, debtUsd, healthFactor: f.healthFactor, liquidatable: f.liquidatable }),
      collateralUsd,
      debtUsd,
      equityUsd: f.equityUsd,
      healthFactor: f.healthFactor,
      leverage: f.leverage,
      bufferPct: f.bufferPct,
      bufferUsd: f.bufferUsd,
      liquidatable: f.liquidatable,
      collateral,
      debts,
      composition,
      hfTrend: trend.get(s.account) ?? [],
      readAt,
    };
  });
}

// ---- aggregation ----------------------------------------------------------------------------------

export const STATUS_RANK: Record<AccountStatus, number> = { liquidatable: 1, critical: 2, warning: 3, healthy: 4, nodebt: 5, empty: 6 };

const HEALTH_BANDS: Array<Omit<Band, "count" | "debtUsd" | "collateralUsd"> & { test: (h: number) => boolean }> = [
  { key: "lt1", label: "< 1.0", tone: "danger", test: (h) => h < 1.0 },
  { key: "1-1.1", label: "1.0–1.1", tone: "danger", test: (h) => h >= 1.0 && h <= LIQUIDATION_LINE },
  { key: "1.1-1.3", label: "1.1–1.3", tone: "critical", test: (h) => h > LIQUIDATION_LINE && h <= 1.3 },
  { key: "1.3-1.5", label: "1.3–1.5", tone: "warn", test: (h) => h > 1.3 && h < DISPLAY_BANDS.warning },
  { key: "1.5-2", label: "1.5–2.0", tone: "ok", test: (h) => h >= DISPLAY_BANDS.warning && h < 2 },
  { key: "2-5", label: "2.0–5.0", tone: "ok", test: (h) => h >= 2 && h < 5 },
  { key: "gt5", label: "> 5.0", tone: "ok", test: (h) => h >= 5 },
];

const LEVERAGE_BINS: Array<{ key: string; label: string; lo: number; hi: number }> = [
  { key: "1-1.25", label: "1–1.25×", lo: 1, hi: 1.25 },
  { key: "1.25-1.5", label: "1.25–1.5×", lo: 1.25, hi: 1.5 },
  { key: "1.5-2", label: "1.5–2×", lo: 1.5, hi: 2 },
  { key: "2-3", label: "2–3×", lo: 2, hi: 3 },
  { key: "3-5", label: "3–5×", lo: 3, hi: 5 },
  { key: "5-8", label: "5–8×", lo: 5, hi: 8 },
  { key: "8+", label: "8×+", lo: 8, hi: Infinity },
];

/** True when a row's health factor falls in the named health band (for table filtering from the chart). */
export function inBand(row: AccountRow, key: string): boolean {
  const band = HEALTH_BANDS.find((b) => b.key === key);
  return !!band && row.healthFactor !== null && band.test(row.healthFactor);
}

const sum = <T,>(list: T[], f: (x: T) => number) => list.reduce((s, x) => s + f(x), 0);

export function summarize(rows: AccountRow[]): AccountsSummary {
  const borrowers = rows.filter((r) => r.debtUsd > 0);
  const debtTotal = sum(borrowers, (r) => r.debtUsd);
  const liquidatable = borrowers.filter((r) => r.liquidatable);
  const atRisk = borrowers.filter((r) => (r.healthFactor ?? Infinity) < DISPLAY_BANDS.warning);
  const withLeverage = borrowers.filter((r) => r.leverage !== null);
  const levDebt = sum(withLeverage, (r) => r.debtUsd);

  const healthBands: Band[] = HEALTH_BANDS.map((b) => {
    const list = borrowers.filter((r) => r.healthFactor !== null && b.test(r.healthFactor));
    return { key: b.key, label: b.label, tone: b.tone, count: list.length, debtUsd: sum(list, (r) => r.debtUsd), collateralUsd: sum(list, (r) => r.collateralUsd) };
  });
  const leverageBins: LeverageBin[] = LEVERAGE_BINS.map((b) => {
    const list = withLeverage.filter((r) => (r.leverage as number) >= b.lo && (r.leverage as number) < b.hi);
    return { key: b.key, label: b.label, count: list.length, debtUsd: sum(list, (r) => r.debtUsd) };
  });

  const shares = [...borrowers].sort((a, b) => b.debtUsd - a.debtUsd).map((r) => (debtTotal > 0 ? r.debtUsd / debtTotal : 0));

  const collateralBy = new Map<string, AssetTotal>();
  const debtBy = new Map<string, AssetTotal>();
  for (const r of rows) {
    for (const l of r.collateral) {
      const e = collateralBy.get(l.symbol) ?? { symbol: l.symbol, kind: l.kind, amount: 0, usd: 0, accounts: 0 };
      e.amount += l.amount; e.usd += l.usd; e.accounts += 1;
      collateralBy.set(l.symbol, e);
    }
    for (const l of r.debts) {
      const e = debtBy.get(l.symbol) ?? { symbol: l.symbol, kind: "debt" as const, amount: 0, usd: 0, accounts: 0 };
      e.amount += l.amount; e.usd += l.usd; e.accounts += 1;
      debtBy.set(l.symbol, e);
    }
  }
  const statusCounts = { empty: 0, nodebt: 0, healthy: 0, warning: 0, critical: 0, liquidatable: 0 } as Record<AccountStatus, number>;
  for (const r of rows) statusCounts[r.status] += 1;

  const collateralUsd = sum(rows, (r) => r.collateralUsd);
  const debtUsd = sum(rows, (r) => r.debtUsd);
  return {
    total: rows.length,
    borrowers: borrowers.length,
    collateralUsd,
    debtUsd,
    equityUsd: collateralUsd - debtUsd,
    liquidatableCount: liquidatable.length,
    liquidatableDebtUsd: sum(liquidatable, (r) => r.debtUsd),
    liquidatableCollateralUsd: sum(liquidatable, (r) => r.collateralUsd),
    atRiskCount: atRisk.length,
    atRiskDebtUsd: sum(atRisk, (r) => r.debtUsd),
    atRiskCollateralUsd: sum(atRisk, (r) => r.collateralUsd),
    badDebtUsd: sum(rows, (r) => Math.max(r.debtUsd - r.collateralUsd, 0)),
    underwaterCount: rows.filter((r) => r.debtUsd > r.collateralUsd).length,
    averageHealth: debtTotal > 0 ? sum(borrowers, (r) => r.collateralUsd) / debtTotal : null,
    averageLeverage: levDebt > 0 ? sum(withLeverage, (r) => (r.leverage as number) * r.debtUsd) / levDebt : null,
    bufferZoneDebtUsd: sum(borrowers.filter((r) => (r.healthFactor as number) > LIQUIDATION_LINE && (r.healthFactor as number) <= BUFFER_ZONE_UPPER), (r) => r.debtUsd),
    healthBands,
    leverageBins,
    composition: { held: sum(rows, (r) => r.composition.held), lending: sum(rows, (r) => r.composition.lending), lp: sum(rows, (r) => r.composition.lp) },
    concentration: {
      top1: shares[0] ?? null,
      top3: shares.length ? shares.slice(0, 3).reduce((s, x) => s + x, 0) : null,
      hhi: shares.length ? shares.reduce((s, x) => s + x * x, 0) * 10000 : null,
    },
    collateralBy: [...collateralBy.values()].sort((a, b) => b.usd - a.usd || b.accounts - a.accounts),
    debtBy: [...debtBy.values()].sort((a, b) => b.usd - a.usd || b.accounts - a.accounts),
    statusCounts,
  };
}

// ---- filtering / sorting --------------------------------------------------------------------------

export function matchesFilter(row: AccountRow, filter: AccountFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "nodebt": return row.status === "nodebt" || row.status === "empty";
    case "atrisk": return row.status === "critical" || row.status === "warning";
    case "liquidatable": return row.status === "liquidatable";
    case "withdebt": return row.debtUsd > 0;
    case "healthy": return row.status === "healthy";
  }
}

/**
 * The number an account is sorted on, or null when it has nothing to show in that column (a no-debt
 * account has no debt figure and no meaningful leverage). Those sort after the accounts that do.
 */
const SORT_VALUE: Record<AccountSortKey, (r: AccountRow) => number | null> = {
  health: (r) => r.healthFactor,
  debt: (r) => (r.debtUsd > 0 ? r.debtUsd : null),
  collateral: (r) => (r.collateralUsd > 0 ? r.collateralUsd : null),
  equity: (r) => (r.collateralUsd > 0 || r.debtUsd > 0 ? r.equityUsd : null),
  leverage: (r) => (r.debtUsd > 0 ? r.leverage : null),
  buffer: (r) => r.bufferPct,
  status: (r) => STATUS_RANK[r.status],
};

/** Direction a column starts in when first clicked: the riskiest or the biggest first. */
export const DEFAULT_SORT_DIR: Record<AccountSortKey, 1 | -1> = { health: 1, debt: -1, collateral: -1, equity: -1, leverage: -1, buffer: 1, status: 1 };

export function sortRows(rows: AccountRow[], key: AccountSortKey, dir: 1 | -1): AccountRow[] {
  const f = SORT_VALUE[key] ?? SORT_VALUE.health;
  const group = (r: AccountRow) => (f(r) !== null ? 0 : 1);
  return [...rows].sort((a, b) => {
    const g = group(a) - group(b);
    if (g) return g;
    const d = group(a) === 0 ? ((f(a) as number) - (f(b) as number)) * dir : 0;
    return d || a.address.localeCompare(b.address);
  });
}

export function searchRows(rows: AccountRow[], query: string): AccountRow[] {
  const q = query.trim().toLowerCase();
  return q ? rows.filter((r) => `${r.owner} ${r.address}`.toLowerCase().includes(q)) : rows;
}

/** Plain-language account status labels (the UI owns wording; this is the single mapping). */
export const STATUS_LABEL: Record<AccountStatus, string> = {
  empty: "No debt",
  nodebt: "No debt",
  healthy: "Safe",
  warning: "At risk",
  critical: "At risk",
  liquidatable: "Liquidatable",
};

/** Where an account's collateral is deployed (from its lines). */
export function protocolsOf(row: AccountRow): string[] {
  const out: string[] = [];
  if (row.composition.lending > 0) out.push("Blend");
  if (row.collateral.some((l) => l.symbol.toUpperCase().startsWith("AQ_"))) out.push("Aquarius");
  if (row.collateral.some((l) => l.symbol.toUpperCase().startsWith("SS_"))) out.push("Soroswap");
  if (row.composition.held > 0) out.push("Held in account");
  return out;
}

export interface LiquidationPrice {
  symbol: string;
  /** "down": the account is liquidated if this asset FALLS to `price`; "up": if it RISES (it is net debt). */
  direction: "down" | "up";
  price: number;
  /** Fractional change from the current price (−0.25 = −25%). */
  change: number;
}

/**
 * Per-asset liquidation price, CALCULATED from the account's own lines: the price at which health
 * reaches the liquidation line if only that asset moves and everything else (including LP positions)
 * stays put. A calculation, not a forecast.
 */
export function liquidationPrices(row: AccountRow, prices: Record<string, number | null | undefined>): LiquidationPrice[] {
  if (row.debtUsd <= 0 || row.liquidatable) return [];
  const L = LIQUIDATION_LINE;
  const movable = row.collateral.filter((l) => l.kind !== "lp");
  const symbols = [...new Set([...movable.map((l) => l.underlying), ...row.debts.map((d) => priceKey(d.symbol))])];
  const out: LiquidationPrice[] = [];
  for (const s of symbols) {
    const price = prices[s];
    if (!price || price <= 0) continue;
    const Cs = movable.filter((l) => l.underlying === s).reduce((a, l) => a + l.usd, 0);
    const Ds = row.debts.filter((d) => priceKey(d.symbol) === s).reduce((a, d) => a + d.usd, 0);
    const denom = Cs - L * Ds;
    if (Math.abs(denom) < 1e-12) continue;
    const f = (L * (row.debtUsd - Ds) - (row.collateralUsd - Cs)) / denom;
    if (!(f > 0)) continue;
    if (denom > 0 && f < 1) out.push({ symbol: s, direction: "down", price: price * f, change: f - 1 });
    if (denom < 0 && f > 1) out.push({ symbol: s, direction: "up", price: price * f, change: f - 1 });
  }
  return out.sort((a, b) => Math.abs(a.change) - Math.abs(b.change));
}

/** Where one account stands among all the accounts read. */
export interface Standing {
  debtRank: number | null;
  borrowers: number;
  debtShare: number | null;
  healthRank: number | null;
  accounts: number;
}

export function standingOf(rows: AccountRow[], row: AccountRow): Standing {
  const borrowers = rows.filter((r) => r.debtUsd > 0);
  const mine = row.debtUsd > 0;
  const totalDebt = borrowers.reduce((a, r) => a + r.debtUsd, 0);
  return {
    debtRank: mine ? 1 + borrowers.filter((r) => r.debtUsd > row.debtUsd).length : null,
    borrowers: borrowers.length,
    debtShare: mine && totalDebt > 0 ? row.debtUsd / totalDebt : null,
    healthRank: mine && row.healthFactor !== null ? 1 + borrowers.filter((r) => (r.healthFactor ?? Infinity) < (row.healthFactor ?? Infinity)).length : null,
    accounts: rows.length,
  };
}
