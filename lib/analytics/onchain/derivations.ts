import type { AccountSnapshot } from "./types";

export type RiskStatus = "healthy" | "warning" | "danger" | "critical";

const RISK_BANDS = {
  atRiskHF: 1.5,
  warningHF: 1.3,
  dangerHF: 1.1,
  criticalHF: 1.0,
} as const;

export function statusForHF(hf: number): RiskStatus {
  if (!isFinite(hf)) return "healthy";
  if (hf < RISK_BANDS.criticalHF) return "critical";
  if (hf < RISK_BANDS.dangerHF) return "danger";
  if (hf < RISK_BANDS.atRiskHF) return "warning";
  return "healthy";
}

/** Accounts with any debt. HF=Infinity accounts (zero debt) skew aggregates. */
const withDebt = (s: AccountSnapshot) => s.totalDebtUsd > 0;

// ============================================================================
// Overview scalars
// ============================================================================

export type ProtocolOverviewDerived = {
  totalCollateralUsd: number;
  totalDebtUsd: number;
  activeAccountCount: number;
  walletsAtRisk: number;
  avgHealthFactor: number;
  avgLeverage: number;
  collateralAtRisk: { value: number; positions: number; percentOfTVL: number };
  valueEligibleForLiquidation: { volume: number; count: number };
  activeBadDebt: { value: number; positions: number };
};

export function deriveProtocolOverview(snapshots: AccountSnapshot[]): ProtocolOverviewDerived {
  const active = snapshots.filter(withDebt);
  const totalCollateralUsd = snapshots.reduce((s, x) => s + x.totalCollateralUsd, 0);
  const totalDebtUsd = snapshots.reduce((s, x) => s + x.totalDebtUsd, 0);

  const atRisk = active.filter((s) => s.healthFactor < RISK_BANDS.atRiskHF);
  const eligible = active.filter((s) => s.healthFactor < 1);

  // Debt-weighted averages over active (with-debt) accounts only.
  const totalActiveDebt = active.reduce((s, x) => s + x.totalDebtUsd, 0);
  const avgHealthFactor = totalActiveDebt > 0
    ? active.reduce((s, x) => s + x.healthFactor * x.totalDebtUsd, 0) / totalActiveDebt
    : 0;
  const avgLeverage = totalActiveDebt > 0
    ? active.reduce((s, x) => s + (isFinite(x.leverage) ? x.leverage : 0) * x.totalDebtUsd, 0) / totalActiveDebt
    : 0;

  const badDebtValue = eligible.reduce(
    (s, x) => s + Math.max(0, x.totalDebtUsd - x.totalCollateralUsd),
    0,
  );

  return {
    totalCollateralUsd,
    totalDebtUsd,
    activeAccountCount: active.length,
    walletsAtRisk: atRisk.length,
    avgHealthFactor,
    avgLeverage,
    collateralAtRisk: {
      value: atRisk.reduce((s, x) => s + x.totalCollateralUsd, 0),
      positions: atRisk.length,
      percentOfTVL: totalCollateralUsd > 0
        ? (atRisk.reduce((s, x) => s + x.totalCollateralUsd, 0) / totalCollateralUsd) * 100
        : 0,
    },
    valueEligibleForLiquidation: {
      volume: eligible.reduce((s, x) => s + x.totalDebtUsd, 0),
      count: eligible.length,
    },
    activeBadDebt: {
      value: badDebtValue,
      positions: eligible.filter((x) => x.totalDebtUsd > x.totalCollateralUsd).length,
    },
  };
}

// ============================================================================
// HF distribution (6 bands — matches mock.ts `hfDistribution`)
// ============================================================================

const HF_BANDS: Array<{ range: string; min: number; max: number }> = [
  { range: "< 1.0", min: 0, max: 1.0 },
  { range: "1.0–1.1", min: 1.0, max: 1.1 },
  { range: "1.1–1.3", min: 1.1, max: 1.3 },
  { range: "1.3–1.5", min: 1.3, max: 1.5 },
  { range: "1.5–2.0", min: 1.5, max: 2.0 },
  { range: "> 2.0", min: 2.0, max: Number.POSITIVE_INFINITY },
];

export type HfBandRow = {
  range: string;
  positionCount: number;
  totalDebtUsd: number;
  percentOfTotal: number;
};

export function deriveHfDistribution(snapshots: AccountSnapshot[]): HfBandRow[] {
  const active = snapshots.filter(withDebt);
  const totalDebt = active.reduce((s, x) => s + x.totalDebtUsd, 0);

  return HF_BANDS.map((b) => {
    const inBand = active.filter((s) => s.healthFactor >= b.min && s.healthFactor < b.max);
    const debt = inBand.reduce((s, x) => s + x.totalDebtUsd, 0);
    return {
      range: b.range,
      positionCount: inBand.length,
      totalDebtUsd: debt,
      percentOfTotal: totalDebt > 0 ? (debt / totalDebt) * 100 : 0,
    };
  });
}

// ============================================================================
// Leverage distribution (9 bands — matches mock.ts `leverageDistribution`)
// ============================================================================

const LEVERAGE_BANDS: Array<{ range: string; min: number; max: number }> = [
  { range: "1–2x", min: 1, max: 2 },
  { range: "2–3x", min: 2, max: 3 },
  { range: "3–4x", min: 3, max: 4 },
  { range: "4–5x", min: 4, max: 5 },
  { range: "5–6x", min: 5, max: 6 },
  { range: "6–7x", min: 6, max: 7 },
  { range: "7–8x", min: 7, max: 8 },
  { range: "8–9x", min: 8, max: 9 },
  { range: "9–10x", min: 9, max: 10 },
];

export type LeverageBandRow = {
  range: string;
  count: number;
  debtUsd: number;
};

export function deriveLeverageDistribution(snapshots: AccountSnapshot[]): LeverageBandRow[] {
  const active = snapshots.filter((s) => withDebt(s) && isFinite(s.leverage));
  return LEVERAGE_BANDS.map((b) => {
    const inBand = active.filter((s) => s.leverage >= b.min && s.leverage < b.max);
    return {
      range: b.range,
      count: inBand.length,
      debtUsd: inBand.reduce((s, x) => s + x.totalDebtUsd, 0),
    };
  });
}

// ============================================================================
// Positions table (generalized — `highRiskPositions` is just a filtered slice)
// ============================================================================

export type PositionRow = {
  account: string;
  address: string; // short-form for display
  ownerProxy: string;
  chain: string;
  healthFactor: number;
  totalDebt: number;
  marginValue: number;
  leverage: number;
  status: RiskStatus;
  breakdown: { aTokens: number; lpTokens: number; trackTokens: number; cash: number };
  protocols: string[];
};

const shortAddr = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

function bucketCollateral(s: AccountSnapshot): PositionRow["breakdown"] {
  const b = { aTokens: 0, lpTokens: 0, trackTokens: 0, cash: 0 };
  for (const c of s.collateral) {
    switch (c.type) {
      case "aToken": b.aTokens += c.usd; break;
      case "lp": b.lpTokens += c.usd; break;
      case "track": b.trackTokens += c.usd; break;
      default: b.cash += c.usd;
    }
  }
  return b;
}

export function derivePositionRows(snapshots: AccountSnapshot[]): PositionRow[] {
  return snapshots.filter(withDebt).map((s) => ({
    account: s.account,
    address: shortAddr(s.account),
    ownerProxy: s.ownerProxy,
    chain: "base",
    healthFactor: s.healthFactor,
    totalDebt: s.totalDebtUsd,
    marginValue: s.totalCollateralUsd,
    leverage: isFinite(s.leverage) ? s.leverage : 0,
    status: statusForHF(s.healthFactor),
    breakdown: bucketCollateral(s),
    protocols: [],
  }));
}

export function deriveHighRiskPositions(
  snapshots: AccountSnapshot[],
  hfMax = RISK_BANDS.atRiskHF,
): PositionRow[] {
  return derivePositionRows(snapshots)
    .filter((r) => r.healthFactor < hfMax)
    .sort((a, b) => a.healthFactor - b.healthFactor);
}

// ============================================================================
// Margin composition pie (matches mock.ts `marginComposition`)
// ============================================================================

export type MarginComposition = {
  aTokens: { valueUsd: number; percent: number };
  lpTokens: { valueUsd: number; percent: number };
  trackTokens: { valueUsd: number; percent: number };
  cash: { valueUsd: number; percent: number };
};

export function deriveMarginComposition(snapshots: AccountSnapshot[]): MarginComposition {
  const totals = { aTokens: 0, lpTokens: 0, trackTokens: 0, cash: 0 };
  for (const s of snapshots) {
    const b = bucketCollateral(s);
    totals.aTokens += b.aTokens;
    totals.lpTokens += b.lpTokens;
    totals.trackTokens += b.trackTokens;
    totals.cash += b.cash;
  }
  const total = totals.aTokens + totals.lpTokens + totals.trackTokens + totals.cash;
  const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0);
  return {
    aTokens: { valueUsd: totals.aTokens, percent: pct(totals.aTokens) },
    lpTokens: { valueUsd: totals.lpTokens, percent: pct(totals.lpTokens) },
    trackTokens: { valueUsd: totals.trackTokens, percent: pct(totals.trackTokens) },
    cash: { valueUsd: totals.cash, percent: pct(totals.cash) },
  };
}

// ============================================================================
// Whale concentration (matches mock.ts `whaleConcentration`)
// ============================================================================

export type WhalePosition = {
  address: string;
  account: string;
  chain: string;
  debtUsd: number;
  sharePercent: number;
  healthFactor: number;
  leverage: number;
};

export type WhaleConcentration = {
  top5Share: number;
  top10Share: number;
  top20Share: number;
  topPositions: WhalePosition[];
};

export function deriveWhaleConcentration(
  snapshots: AccountSnapshot[],
  topN = 10,
): WhaleConcentration {
  const active = snapshots.filter(withDebt).sort((a, b) => b.totalDebtUsd - a.totalDebtUsd);
  const totalDebt = active.reduce((s, x) => s + x.totalDebtUsd, 0);
  const topShare = (n: number) => {
    if (totalDebt === 0) return 0;
    return (active.slice(0, n).reduce((s, x) => s + x.totalDebtUsd, 0) / totalDebt) * 100;
  };
  return {
    top5Share: topShare(5),
    top10Share: topShare(10),
    top20Share: topShare(20),
    topPositions: active.slice(0, topN).map((s) => ({
      address: shortAddr(s.account),
      account: s.account,
      chain: "base",
      debtUsd: s.totalDebtUsd,
      sharePercent: totalDebt > 0 ? (s.totalDebtUsd / totalDebt) * 100 : 0,
      healthFactor: s.healthFactor,
      leverage: isFinite(s.leverage) ? s.leverage : 0,
    })),
  };
}

// ============================================================================
// Active alerts (threshold rules — no history, no channels)
// ============================================================================

export type AlertPriority = "P0" | "P1" | "P2" | "P3";

export type ActiveAlert = {
  id: string;
  priority: AlertPriority;
  metric: string;
  value: number;
  threshold: number;
  message: string;
  account: string;
};

export function deriveActiveAlerts(snapshots: AccountSnapshot[]): {
  summary: Record<AlertPriority, number>;
  active: ActiveAlert[];
} {
  const active: ActiveAlert[] = [];
  for (const s of snapshots) {
    if (!withDebt(s)) continue;
    if (s.healthFactor < 1) {
      active.push({
        id: `hf-p0-${s.account}`,
        priority: "P0",
        metric: "health_factor",
        value: s.healthFactor,
        threshold: 1,
        message: `Position ${shortAddr(s.account)} is liquidatable (HF ${s.healthFactor.toFixed(2)})`,
        account: s.account,
      });
    } else if (s.healthFactor < 1.1) {
      active.push({
        id: `hf-p1-${s.account}`,
        priority: "P1",
        metric: "health_factor",
        value: s.healthFactor,
        threshold: 1.1,
        message: `Position ${shortAddr(s.account)} critically close to liquidation (HF ${s.healthFactor.toFixed(2)})`,
        account: s.account,
      });
    } else if (s.healthFactor < 1.3) {
      active.push({
        id: `hf-p2-${s.account}`,
        priority: "P2",
        metric: "health_factor",
        value: s.healthFactor,
        threshold: 1.3,
        message: `Position ${shortAddr(s.account)} below safe HF (${s.healthFactor.toFixed(2)})`,
        account: s.account,
      });
    }
  }

  const summary: Record<AlertPriority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const a of active) summary[a.priority]++;
  return { summary, active };
}

// ============================================================================
// Risk Explorer — apply a price shock and recompute aggregates
// ============================================================================

export type PriceShock = Record<string, number>; // { symbol: newPrice }

export type ShockResult = {
  baseline: ProtocolOverviewDerived;
  shocked: ProtocolOverviewDerived;
  delta: {
    badDebt: number;
    eligibleVolume: number;
    walletsAtRisk: number;
    avgHealthFactor: number;
  };
};

/**
 * Pure math: recompute each account's collateral USD using new prices, debt USD
 * stays the same (debt is denominated in the borrowed asset, but since mock/core
 * prices we track stables near $1 and ETH at spot, we apply the shock only to
 * collateral side for simplicity). A more complete version would shock debt too.
 */
export function applyShock(
  snapshots: AccountSnapshot[],
  priceOverrides: PriceShock,
): AccountSnapshot[] {
  return snapshots.map((s) => {
    let newCollateralUsd = 0;
    const newCollateral = s.collateral.map((c) => {
      const sym = c.symbol === "WETH" ? "ETH" : c.symbol;
      if (priceOverrides[sym] !== undefined) {
        const newUsd = c.amount * priceOverrides[sym];
        newCollateralUsd += newUsd;
        return { ...c, usd: newUsd };
      }
      newCollateralUsd += c.usd;
      return c;
    });

    const healthFactor = s.totalDebtUsd > 0 ? newCollateralUsd / s.totalDebtUsd : Number.POSITIVE_INFINITY;
    const equity = newCollateralUsd - s.totalDebtUsd;
    const leverage = equity > 0 ? newCollateralUsd / equity : Number.POSITIVE_INFINITY;

    return {
      ...s,
      collateral: newCollateral,
      totalCollateralUsd: newCollateralUsd,
      healthFactor,
      leverage,
      isHealthy: healthFactor >= 1,
    };
  });
}

export function deriveShockResult(
  snapshots: AccountSnapshot[],
  priceOverrides: PriceShock,
): ShockResult {
  const baseline = deriveProtocolOverview(snapshots);
  const shocked = deriveProtocolOverview(applyShock(snapshots, priceOverrides));
  return {
    baseline,
    shocked,
    delta: {
      badDebt: shocked.activeBadDebt.value - baseline.activeBadDebt.value,
      eligibleVolume: shocked.valueEligibleForLiquidation.volume - baseline.valueEligibleForLiquidation.volume,
      walletsAtRisk: shocked.walletsAtRisk - baseline.walletsAtRisk,
      avgHealthFactor: shocked.avgHealthFactor - baseline.avgHealthFactor,
    },
  };
}
