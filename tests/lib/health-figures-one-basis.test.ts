import { describe, expect, it } from "vitest";
import { normalizeResearchFacts } from "@/lib/copilot/investigation/normalize";
import { healthObservations } from "@/lib/copilot/investigation/fast-path";
import type { Observation } from "@/lib/copilot/investigation/types";

/**
 * The reply must state ONE health factor, the Margin page's, and no figure that lets the model make
 * another. 24 Oct 2026, live: the answer said "health factor 70.25 (most recently observed 82.28)".
 * The facts it was given held the page's 82.28 and ALSO the risk engine's posted collateral
 * ($1,637.70) labelled only "collateral" beside the debt - the model divided them itself.
 *
 * Two bases exist for one account (CBOQAN5N..., testnet): the risk engine counts collateral POSTED to
 * the contract, the page counts everything the account HOLDS. The page's is what the user is told.
 */

const READ_AT = 1000;

/** The shape of `vanna_get_account_health` as the deployed MCP returns it (captured 24 Oct 2026). */
const DEPLOYED_SOURCE = {
  basis: "contract_risk_engine_posted_collateral", debt_free: false, liquidatable_at_or_below: "1.1",
  formula: { numerator: "collateral_usd", denominator: "debt_usd", weighting: "none" },
  margin_page_figures: "vanna_margin_status action=website_figures",
};
const contractRead = (extra: Record<string, unknown> = {}): Observation => ({
  id: "e1", capability: "account_health", args: {}, observedAt: READ_AT, status: "ok",
  data: {
    smart_account: "CBOQ", collateral_usd: "1637.70", debt_usd: "23.31", ltv_ratio: "0.0142", is_healthy: true,
    distance_to_liquidation: "0.8947643", borrow_threshold: "0.909", liquidation_threshold: "0.909",
    health_factor: "70.250000", source: DEPLOYED_SOURCE, ...extra,
  },
});
/** The older shape, before the MCP carried a health factor of its own. */
const legacyContractRead = (): Observation => {
  const read = contractRead();
  const { health_factor: _h, source: _s, ...rest } = read.data as Record<string, unknown>;
  return { ...read, data: rest };
};

const pageRead = (): Observation => healthObservations({
  grossCollateralUsd: "1916.27", debtUsd: "23.31", healthFactor: "82.2086",
}).map((observation) => ({ ...observation, id: "e2", observedAt: READ_AT + 1000 }))[0];

const sourcePaths = (facts: Array<{ sourcePath: string; evidenceId: string }>, id?: string) =>
  facts.filter((fact) => id === undefined || fact.evidenceId === id).map((fact) => fact.sourcePath);

describe("one health basis in the reply", () => {
  it("a risk-engine read beside the page's position offers neither its collateral nor its health factor", () => {
    const { facts } = normalizeResearchFacts([contractRead(), pageRead()]);
    // The page's own figures are present, and the only health factor.
    expect(facts.filter((fact) => fact.unit === "HF")).toHaveLength(1);
    expect(facts.filter((fact) => fact.unit === "HF")[0]).toMatchObject({ evidenceId: "e2", value: "82.2086" });
    // The posted-basis collateral, the LTV derived from it and the risk engine's ratio are not offered at all.
    expect(sourcePaths(facts, "e1")).not.toContain("collateral_usd");
    expect(sourcePaths(facts, "e1")).not.toContain("ltv_ratio");
    expect(sourcePaths(facts, "e1")).not.toContain("health_factor");
    expect(sourcePaths(facts, "e1")).not.toContain("posted_health_factor");
    // Nor are the loan-to-value measures built on that posted collateral (the gap to liquidation and the
    // thresholds): the page shows none of them, and "distance 0.8947 ratio" read to a user as a liquidation
    // figure (24 Oct, live). Only the risk engine's plain verdict stays.
    for (const gone of ["distance_to_liquidation", "borrow_threshold", "liquidation_threshold"]) {
      expect(sourcePaths(facts, "e1")).not.toContain(gone);
    }
    expect(sourcePaths(facts, "e1")).toContain("is_healthy");
    // Nothing from the provenance block leaks in as a fact.
    expect(facts.some((fact) => fact.sourcePath.startsWith("source"))).toBe(false);
  });

  it("a risk-engine read alone offers its ratio only as the posted-collateral figure, never as the health factor", () => {
    const { facts } = normalizeResearchFacts([contractRead()]);
    expect(facts.find((fact) => fact.sourcePath === "collateral_usd")?.label).toBe("Collateral posted to the risk engine");
    expect(facts.some((fact) => fact.sourcePath === "health_factor")).toBe(false);
    // It stays recognisable as the contract's, so the reply says it could not read the page's figure
    // (owner, 29 Sep) instead of quoting this one.
    expect(facts.find((fact) => fact.sourcePath === "posted_health_factor")).toMatchObject({ unit: "HF", value: "70.250000" });
  });

  it("the older risk-engine shape, with no health factor of its own, makes none", () => {
    const { facts } = normalizeResearchFacts([legacyContractRead()]);
    expect(facts.find((fact) => fact.sourcePath === "collateral_usd")?.label).toBe("Collateral posted to the risk engine");
    expect(facts.some((fact) => fact.unit === "HF")).toBe(false);
  });
});

describe("the page's position carries its leverage", () => {
  it("leverage is holdings over equity, as the Margin page states it", () => {
    const data = pageRead().data as Record<string, string>;
    // 1916.27 / (1916.27 - 23.31) = 1.0123
    expect(Number(data.net_leverage)).toBeCloseTo(1.0123, 4);
    const { facts } = normalizeResearchFacts([pageRead()]);
    expect(facts.find((fact) => fact.sourcePath === "net_leverage")).toMatchObject({ label: "Net leverage taken", unit: "x" });
  });

  it("no debt is 1x", () => {
    const [observation] = healthObservations({ grossCollateralUsd: "500", debtUsd: "0", healthFactor: null });
    expect((observation.data as Record<string, string>).net_leverage).toBe("1");
  });

  it("equity wiped out has no leverage figure rather than a negative or infinite one", () => {
    const [observation] = healthObservations({ grossCollateralUsd: "20", debtUsd: "25", healthFactor: "0.8" });
    expect((observation.data as Record<string, unknown>).net_leverage).toBeUndefined();
  });
});
