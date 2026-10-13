/**
 * What-if engine (ported from the Solana analytics). Pure and read-only: it reprices the current
 * snapshot of accounts under the user's assumptions. It never transacts, never touches chain state and
 * never invents inputs. Outputs are simulated estimates.
 *
 * Model "immediate-repricing-v1": a shock moves every line priced off that asset at once (collateral
 * AND debt; a Blend deposit moves with its underlying). Aquarius / Soroswap LP positions are held at
 * their current value. Collateral rounds down and debt rounds up (in nano-USD) so rounding never
 * flatters the result. No interest, no liquidations executing, no recovery: those are NOT modelled.
 */
import { priceKey } from "@/lib/account-model";
import { LIQUIDATION_LINE, type CollateralLine, type DebtLine } from "./model";

export const WHATIF_MODEL = "immediate-repricing-v1";
// BigInt() rather than `n` literals: the app targets ES2017.
const NANO = BigInt(1_000_000_000);
const MILLION = BigInt(1_000_000);
const ZERO = BigInt(0);
const ROUND_UP = BigInt(999_999);
const nanos = (usd: number) => BigInt(Math.round(usd * 1e9));

export interface BaselineAccount {
  owner: string;
  address: string;
  collateral: CollateralLine[];
  debts: DebtLine[];
}

export interface Side {
  collateral: number;
  debt: number;
  equity: number;
  health: number | null;
  noDebt: boolean;
  /** Liquidation eligibility (health at or below the line) - NOT the same as loss. */
  eligible: boolean;
  /** Debt not covered by collateral. */
  shortfall: number;
}

export interface AccountResult { owner: string; address: string; baseline: Side; result: Side; affected: number }

export interface Totals {
  accounts: number;
  collateral: number;
  debt: number;
  eligibleCount: number;
  eligibleDebt: number;
  shortfall: number;
  underwaterCount: number;
  averageHealth: number | null;
}

export interface SimulationResult {
  model: string;
  shocks: Record<string, number>;
  covered: AccountResult[];
  baseline: Totals;
  result: Totals;
}

const LINE_WAD = BigInt(Math.round(LIQUIDATION_LINE * 1e6)); // 1.10 → 1_100_000 (per 1e6)

function side(C: bigint, D: bigint): Side {
  const noDebt = D === ZERO;
  const eligible = !noDebt && C * MILLION <= LINE_WAD * D;
  return {
    collateral: Number(C) / 1e9, debt: Number(D) / 1e9, equity: Number(C - D) / 1e9,
    health: noDebt ? null : Number((C * NANO) / D) / 1e9, noDebt, eligible,
    shortfall: Number(D > C ? D - C : ZERO) / 1e9,
  };
}

/** Validates user-entered percentages (−100 … +500). */
export function validateShocks(shocks: Record<string, number>): string | null {
  for (const [, p] of Object.entries(shocks)) {
    if (!Number.isFinite(p) || p < -100 || p > 500) return "Enter price changes between −100% and +500%.";
  }
  return null;
}

export function simulateAccount(account: BaselineAccount, shocks: Record<string, number>): AccountResult {
  const factors = new Map(Object.entries(shocks).filter(([, p]) => p !== 0).map(([s, p]) => [s, BigInt(Math.round((1 + p / 100) * 1e6))]));
  let C = ZERO, D = ZERO, affected = 0;
  for (const l of account.collateral) {
    const v = nanos(l.usd), f = l.kind === "lp" ? undefined : factors.get(l.underlying);
    C += f !== undefined ? (v * f) / MILLION : v;
    if (f !== undefined) affected++;
  }
  for (const l of account.debts) {
    const v = nanos(l.usd), f = factors.get(priceKey(l.symbol));
    D += f !== undefined ? (v * f + ROUND_UP) / MILLION : v;
    if (f !== undefined) affected++;
  }
  const baselineC = account.collateral.reduce((a, l) => a + nanos(l.usd), ZERO);
  const baselineD = account.debts.reduce((a, l) => a + nanos(l.usd), ZERO);
  return { owner: account.owner, address: account.address, baseline: side(baselineC, baselineD), result: side(C, D), affected };
}

function totals(sides: Side[]): Totals {
  const debtors = sides.filter((s) => !s.noDebt);
  const debtSum = debtors.reduce((a, s) => a + s.debt, 0);
  return {
    accounts: sides.length,
    collateral: sides.reduce((a, s) => a + s.collateral, 0),
    debt: sides.reduce((a, s) => a + s.debt, 0),
    eligibleCount: sides.filter((s) => s.eligible).length,
    eligibleDebt: sides.filter((s) => s.eligible).reduce((a, s) => a + s.debt, 0),
    shortfall: sides.reduce((a, s) => a + s.shortfall, 0),
    underwaterCount: sides.filter((s) => s.shortfall > 0).length,
    averageHealth: debtSum > 0 ? debtors.reduce((a, s) => a + s.collateral, 0) / debtSum : null,
  };
}

/** Runs one shock set over every covered account. */
export function simulate(accounts: BaselineAccount[], shocks: Record<string, number>): SimulationResult {
  const error = validateShocks(shocks);
  if (error) throw new Error(error);
  const covered = accounts.map((a) => simulateAccount(a, shocks));
  return {
    model: WHATIF_MODEL,
    shocks: Object.fromEntries(Object.entries(shocks).filter(([, p]) => p !== 0)),
    covered,
    baseline: totals(covered.map((c) => c.baseline)),
    result: totals(covered.map((c) => c.result)),
  };
}

/** Liquidity withdrawal: what share of a requested withdrawal the pool's cash can honour right now. */
export function simulateWithdrawal(pool: { totalSupplied: number; availableLiquidity: number }, percent: number) {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error("Withdrawal assumption must be between 0% and 100%.");
  if (!(pool.totalSupplied >= 0) || !(pool.availableLiquidity >= 0)) throw new Error("Valid pool balances are required.");
  const requested = (pool.totalSupplied * percent) / 100;
  const executed = Math.min(requested, pool.availableLiquidity);
  return { requested, executed, unfilled: Math.max(0, requested - executed), remaining: pool.availableLiquidity - executed };
}
