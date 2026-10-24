import { describe, expect, it } from "vitest";
import { postRunFacts } from "@/lib/copilot/investigation/post-run-facts";
import type { MarginSnapshot } from "@/lib/account-snapshot";

/**
 * 24 Oct: after a run, the figures a user may ask for (leverage, liquidation prices, whether the account exists) come
 * from the account as it stands, in the Margin page's own terms, and are only OFFERED to the reply.
 */
type Row = { amount: string; usdValue: string };
const row = (amount: number, usd: number): Row => ({ amount: String(amount), usdValue: usd.toFixed(2) });
const SNAPSHOT = {
  collateralBalances: { XLM: row(5173.89, 919.95), AQUSDC: row(103.21, 103.22), BLUSDC: row(0.99, 0.99), BLEND_USDC: row(244.82, 245.11) },
  borrowedBalances: { AQUSDC: row(11.79, 11.8), XLM: row(47.0755, 8.37), BLUSDC: row(3.14, 3.14) },
} as unknown as MarginSnapshot;
const position = { grossCollateralUsd: "1916.27", debtUsd: "23.31", healthFactor: "82.2086", snapshot: SNAPSHOT };

describe("figures read from the account after a run", () => {
  const facts = postRunFacts(position, 1000);
  const ids = facts.map((fact) => fact.id);

  it("carries leverage as the Margin page states it", () => {
    const leverage = facts.find((fact) => fact.id === "account:leverage_now");
    expect(leverage).toMatchObject({ unit: "x", label: "account leverage now" });
    expect(Number(leverage?.value)).toBeCloseTo(1.0123, 3);
  });

  it("carries the liquidation answer under its own name", () => {
    const liquidation = facts.filter((fact) => fact.group === "Liquidation");
    expect(liquidation.length).toBeGreaterThan(0);
    expect(liquidation.every((fact) => fact.id.startsWith("account:liquidation:"))).toBe(true);
  });

  it("says the margin account is open, and states no second health factor", () => {
    expect(facts.find((fact) => fact.id === "account:margin_account")).toMatchObject({ value: "already open" });
    // The current health factor is the reply's own; a projected one inside the liquidation answer is a different figure.
    expect(facts.some((fact) => fact.unit === "HF" && fact.group !== "Liquidation")).toBe(false);
    expect(facts.some((fact) => fact.sourcePath === "health_factor")).toBe(false);
  });

  it("gives every fact a unique id", () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("offers no leverage when equity is gone, rather than a negative one", () => {
    const wiped = postRunFacts({ ...position, grossCollateralUsd: "20", debtUsd: "25" }, 1000);
    expect(wiped.some((fact) => fact.id === "account:leverage_now")).toBe(false);
  });
});
