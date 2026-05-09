/**
 * Enhanced position data for the Advanced Positions page.
 * Extends base WalletPosition with: collateral type, age, HF velocity,
 * distance-to-liquidation, and borrow rate sensitivity.
 */

import type { WalletPosition } from "@/components/analytics/risk-explorer/constants";
import { TOKEN_PRICES, SIM_ASSETS, generateWallets } from "@/components/analytics/risk-explorer/constants";

/* ── Collateral type categories ── */
export type CollateralType = "aToken" | "lpToken" | "trackToken" | "cash";

export const COLLATERAL_TYPE_META: Record<
  CollateralType,
  { label: string; risk: string; color: string; bgClass: string }
> = {
  aToken: {
    label: "aToken",
    risk: "Low",
    color: "#703AE6",
    bgClass: "bg-violet-100 text-violet-600",
  },
  lpToken: {
    label: "LP Token",
    risk: "High",
    color: "#FF007A",
    bgClass: "bg-rose-100 text-rose-500",
  },
  trackToken: {
    label: "Track Token",
    risk: "Medium",
    color: "#F59E0B",
    bgClass: "bg-amber-100 text-amber-600",
  },
  cash: {
    label: "Cash",
    risk: "Minimal",
    color: "#32EEE2",
    bgClass: "bg-electric-100 text-electric-600",
  },
};

/* ── Position age category ── */
export type AgeCategory = "new" | "recent" | "established";

/* ── Extended position type ── */
export interface AdvancedPosition extends WalletPosition {
  /** Collateral type (aToken, LP, track, cash) */
  collateralType: CollateralType;
  /** When the position was opened (timestamp ms) */
  openedAt: number;
  /** Age category */
  ageCategory: AgeCategory;
  /** HF change per hour (negative = deteriorating) */
  hfVelocity: number;
  /** Price drop % needed on primary asset to reach HF 1.1 */
  distToLiqPct: number;
  /** Chain label. Single-chain build — kept as a literal union for back-compat
   *  with `ChainBadge` callers that still type the prop as `"base" | "stellar"`. */
  chain: "base" | "stellar";
}

/* ── Deterministic seeded RNG ── */
function seededRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s & 0x7fffffff) / 0x7fffffff;
  };
}

/* ── Collateral type assignment (weighted by margin composition) ── */
const COLLATERAL_WEIGHTS: { type: CollateralType; weight: number }[] = [
  { type: "aToken", weight: 0.34 },
  { type: "lpToken", weight: 0.374 },
  { type: "trackToken", weight: 0.189 },
  { type: "cash", weight: 0.097 },
];

function pickCollateralType(r: number): CollateralType {
  let cum = 0;
  for (const w of COLLATERAL_WEIGHTS) {
    cum += w.weight;
    if (r < cum) return w.type;
  }
  return "cash";
}

/* ── Calculate distance to liquidation ── */
function calcDistToLiq(collateral: number, debt: number): number {
  // HF = (coll * CF) / debt = 1.1  =>  coll_new = 1.1 * debt / CF
  const CF = 0.9;
  const targetHF = 1.1;
  const collNeeded = (targetHF * debt) / CF;
  if (collateral <= 0) return 0;
  const dropFactor = collNeeded / collateral;
  // dropFactor < 1 means price must DROP, > 1 means already below threshold
  const pctChange = (1 - dropFactor) * 100;
  return pctChange; // positive = needs this % drop to hit 1.1, negative = already below
}

/* ── Age category from timestamp ── */
function getAgeCategory(openedAt: number): AgeCategory {
  const hoursAgo = (Date.now() - openedAt) / (1000 * 60 * 60);
  if (hoursAgo < 24) return "new";
  if (hoursAgo < 168) return "recent"; // 7 days
  return "established";
}

/* ── Generate enhanced positions ── */
export function generateAdvancedPositions(chainId: number): AdvancedPosition[] {
  const base = generateWallets(chainId);
  const rng = seededRng(chainId * 31 + 97);

  return base.map((w, i) => {
    const r = rng();
    const collateralType = pickCollateralType(r);

    // Position age: riskier positions tend to be newer
    const ageHoursBase =
      w.hf < 1.1
        ? 2 + rng() * 72 // 2-74 hours for dangerous positions
        : w.hf < 1.5
          ? 24 + rng() * 336 // 1-15 days for warning
          : 48 + rng() * 720; // 2-32 days for safe
    const openedAt = Date.now() - ageHoursBase * 60 * 60 * 1000;

    // HF velocity: negative for deteriorating, positive for improving
    // Riskier positions tend to deteriorate faster
    let hfVelocity: number;
    if (w.hf < 1.0) {
      hfVelocity = -0.02 - rng() * 0.08; // -0.02 to -0.10/hr
    } else if (w.hf < 1.1) {
      hfVelocity = -0.01 - rng() * 0.04; // -0.01 to -0.05/hr
    } else if (w.hf < 1.3) {
      hfVelocity = -0.005 + rng() * 0.015; // -0.005 to +0.01/hr
    } else {
      hfVelocity = -0.002 + rng() * 0.01; // -0.002 to +0.008/hr
    }

    // LP token positions deteriorate slightly faster due to IL
    if (collateralType === "lpToken") {
      hfVelocity -= 0.003;
    }

    const distToLiqPct = calcDistToLiq(w.collateral, w.debt);

    return {
      ...w,
      collateralType,
      openedAt,
      ageCategory: getAgeCategory(openedAt),
      hfVelocity: Math.round(hfVelocity * 10000) / 10000,
      distToLiqPct: Math.round(distToLiqPct * 100) / 100,
      // Always Stellar — the dashboard is single-chain. The `chainId`
      // argument is preserved as a deterministic seed only.
      chain: "stellar" as const,
    };
  });
}

/* ── Correlated position grouping ── */
export interface CorrelatedGroup {
  /** Grouping key (e.g., "XLM + lpToken") */
  key: string;
  /** Human-readable description */
  label: string;
  /** Asset driving the correlation */
  asset: string;
  /** Collateral type if relevant */
  collateralType: CollateralType;
  /** Positions in this group */
  positions: AdvancedPosition[];
  /** Total debt in group */
  totalDebt: number;
  /** Total collateral */
  totalCollateral: number;
  /** Number of positions that would be liquidated at -20% */
  liquidatedAt20Pct: number;
  /** Bad debt at -20% drop */
  badDebtAt20Pct: number;
}

export function buildCorrelatedGroups(
  positions: AdvancedPosition[]
): CorrelatedGroup[] {
  const CF = 0.9;
  const groups = new Map<string, AdvancedPosition[]>();

  for (const p of positions) {
    const key = `${p.primaryAsset}::${p.collateralType}`;
    const arr = groups.get(key) || [];
    arr.push(p);
    groups.set(key, arr);
  }

  const result: CorrelatedGroup[] = [];
  const groupKeys = Array.from(groups.keys());

  for (const key of groupKeys) {
    const posArr = groups.get(key)!;
    if (posArr.length < 2) continue; // only show groups with 2+

    const [asset, collType] = key.split("::") as [string, CollateralType];
    const totalDebt = posArr.reduce((s, p) => s + p.debt, 0);
    const totalCollateral = posArr.reduce((s, p) => s + p.collateral, 0);

    // Simulate -20% drop
    let liquidatedCount = 0;
    let badDebt = 0;
    for (const p of posArr) {
      const newColl = p.collateral * 0.8;
      const newHF = (newColl * CF) / p.debt;
      if (newHF < 1.0) {
        liquidatedCount++;
        const shortfall = p.debt - newColl * CF;
        if (shortfall > 0) badDebt += shortfall;
      }
    }

    result.push({
      key,
      label: `${asset} (${COLLATERAL_TYPE_META[collType].label})`,
      asset,
      collateralType: collType,
      positions: posArr,
      totalDebt,
      totalCollateral,
      liquidatedAt20Pct: liquidatedCount,
      badDebtAt20Pct: badDebt,
    });
  }

  return result.sort((a, b) => b.totalDebt - a.totalDebt);
}

/* ── Borrow rate impact analysis ── */
export interface BorrowRateImpact {
  rateIncreasePct: number; // e.g. 2 = +2%
  unprofitableCount: number;
  unprofitableDebt: number;
  liquidationRiskCount: number; // would push HF below 1.3
}

export function analyzeBorrowRateImpact(
  positions: AdvancedPosition[]
): BorrowRateImpact[] {
  const increases = [1, 2, 3, 5, 8, 10, 15];
  const CF = 0.9;

  return increases.map((inc) => {
    let unprofitableCount = 0;
    let unprofitableDebt = 0;
    let liquidationRiskCount = 0;

    for (const p of positions) {
      // Higher borrow rate increases debt cost. Simulate as if debt grows by inc% annualized
      // over 30 days: debt_new = debt * (1 + inc/100 * 30/365)
      const debtGrowth = p.debt * (inc / 100) * (30 / 365);
      const newDebt = p.debt + debtGrowth;
      const newHF = (p.collateral * CF) / newDebt;

      // Position becomes unprofitable if new cost exceeds yield
      // Simplified: if HF drops below current HF significantly
      if (newHF < p.hf * 0.95) {
        unprofitableCount++;
        unprofitableDebt += p.debt;
      }

      if (newHF < 1.3 && p.hf >= 1.3) {
        liquidationRiskCount++;
      }
    }

    return {
      rateIncreasePct: inc,
      unprofitableCount,
      unprofitableDebt,
      liquidationRiskCount,
    };
  });
}
