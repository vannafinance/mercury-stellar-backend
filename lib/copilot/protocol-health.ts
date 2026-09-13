/**
 * Map an MCP / snapshot health payload onto the on-chain formula.
 *
 * Protocol_V1_Soroban testnet RiskEngine:
 *   HF = collateral_usd / debt_usd
 *   liquidatable iff HF <= 1.1
 *
 * `liquidation_threshold: "0.909"` on MCP is max LTV (1/1.1), not a collateral
 * factor. Never multiply collateral by it.
 */
import { healthFactorFromUsd } from "@/lib/margin-health";

export function n(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const x = Number(v);
    if (Number.isFinite(x)) return x;
  }
  return null;
}

export function parseHealthPayload(health: Record<string, unknown>): {
  collateral: number;
  debt: number;
  hf: number | null;
} {
  const collateral =
    n(health.collateral_usd) ??
    n(health.total_collateral_usd) ??
    n(health.gross_collateral_usd) ??
    n(health.collateral) ??
    0;
  const debt = n(health.debt_usd) ?? n(health.total_debt_usd) ?? n(health.debt) ?? 0;
  const reported = n(health.health_factor) ?? n(health.hf) ?? n(health.avg_health_factor);
  // C/D is the contract. A reported field that disagrees with C/D is the haircut bug.
  const derived = healthFactorFromUsd(collateral, debt);
  return { collateral, debt, hf: derived ?? reported };
}
