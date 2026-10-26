import { describe, expect, it } from "vitest";
import { liquidationObservation, tryLiquidationObservation } from "@/lib/copilot/investigation/liquidation";
import { normalizeResearchFacts } from "@/lib/copilot/investigation/normalize";
import { formatFactValue } from "@/lib/copilot/investigation/answer-prose";
import type { MarginSnapshot } from "@/lib/account-snapshot";

/**
 * "What is my XLM liquidation price, and how far can prices drop?" had no answer: the copilot had
 * no read for it, so the model either said a single price "is not defined" or stalled. The Margin
 * pages already compute it (lib/account-model.ts liqMultiplier, the same functions that feed the
 * swap page's liquidation price), so the copilot states the page's own figure.
 *
 * Golden account: testnet CBOQAN5N..., 24 Oct 2026. Its stablecoin-priced holdings alone cover its
 * debt many times over, so no XLM price liquidates it.
 */

type Row = { amount: string; usdValue: string };
const row = (amount: number, usd: number): Row => ({ amount: String(amount), usdValue: usd.toFixed(2) });

const snapshot = (collateral: Record<string, Row>, borrowed: Record<string, Row>): MarginSnapshot => ({
  collateralBalances: collateral, borrowedBalances: borrowed,
  totalBorrowedValue: 0, totalCollateralValue: 0, grossCollateralValue: 0, totalValue: 0, avgHealthFactor: 0,
  collateralLeftBeforeLiquidation: 0, netAvailableCollateral: 0, borrowRate: 0, debtLimit: 0, debtDataIncomplete: false,
});

const REAL = snapshot(
  {
    XLM: row(5173.89, 919.95), AQUSDC: row(103.21, 103.22), BLUSDC: row(0.99, 0.99), SOUSDC: row(0, 0),
    BLEND_XLM: row(3506.72, 623.52), BLEND_USDC: row(244.82, 245.11), AQ_XLM_USDC: row(1.7, 3.62), SS_XLM_USDC: row(22.79, 19.86),
  },
  { AQUSDC: row(11.79, 11.8), XLM: row(47.0755, 8.37), BLUSDC: row(3.14, 3.14) },
);

const data = (observation: { data?: Record<string, unknown> }) => observation.data as {
  has_debt: boolean; state: string;
  exposures: Array<{ symbol: string; price_usd: string; falling: { price_usd: string; change_pct: string } | null;
    rising: { price_usd: string; change_pct: string } | null; health_factor_if_near_zero: string | null }>;
  all_together: { falling_pct: string | null };
  pegged?: Array<{ symbol: string }>;
};

describe("liquidationObservation", () => {
  it("the real account: no XLM price liquidates it, and what its health factor would be near zero", () => {
    const out = data(liquidationObservation(REAL, 1000));
    // "none": no single price move liquidates it.
    expect(out.state).toBe("none");
    expect(out.exposures.map((exposure) => exposure.symbol)).toEqual(["XLM"]);
    const xlm = out.exposures[0];
    expect(xlm.falling).toBeNull();
    expect(Number(xlm.price_usd)).toBeCloseTo(919.95 / 5173.89, 5);
    // Everything but XLM and its debt, over the debt that is not XLM: (1916.27 - 919.95 - ...) is far above 1.10.
    const stableHoldings = 103.22 + 0.99 + 0 + 623.52 + 245.11 + 3.62 + 19.86;
    const nonXlmDebt = 11.8 + 3.14;
    expect(Number(xlm.health_factor_if_near_zero)).toBeGreaterThan(50);
    expect(Number(xlm.health_factor_if_near_zero)).toBeLessThan((stableHoldings + 920 * 0.001) / (nonXlmDebt + 8.37 * 0.001) + 1);
    expect(out.all_together.falling_pct).toBeNull();
  });

  it("an account a falling price does liquidate gets that price and the drop", () => {
    // 10,000 XLM at 0.10 ($1,000) against $800 of USDC debt: health 1.25, liquidated at 1.10 -> XLM x 0.88.
    const out = data(liquidationObservation(snapshot(
      { XLM: row(10000, 1000) }, { BLUSDC: row(800, 800) },
    ), 1000));
    const xlm = out.exposures[0];
    expect(xlm.falling).not.toBeNull();
    expect(Number(xlm.falling!.price_usd)).toBeCloseTo(0.088, 3);
    expect(Math.abs(Number(xlm.falling!.change_pct))).toBeCloseTo(12, 0);
    expect(xlm.health_factor_if_near_zero).toBeNull();
  });

  it("no debt means no price liquidates the account", () => {
    const out = data(liquidationObservation(snapshot({ XLM: row(100, 20) }, {}), 1000));
    expect(out.state).toBe("nodebt");
    expect(out.exposures).toEqual([]);
  });

  it("an account already at or under the line says so rather than quoting a price", () => {
    const out = data(liquidationObservation(snapshot({ XLM: row(8000, 800) }, { BLUSDC: row(800, 800) }), 1000));
    expect(out.state).toBe("now");
  });

  it("receipt and LP tokens are never offered as an asset with a price of its own", () => {
    const symbols = data(liquidationObservation(REAL, 1000)).exposures.map((exposure) => exposure.symbol);
    expect(symbols.some((symbol) => /^(BLEND_|AQ_|SS_)/.test(symbol))).toBe(false);
  });
});

describe("health factor at a stated fall", () => {
  // $1,000 of XLM + $1,000 of USDC against $800 of USDC debt: health 2000 / 800 = 2.5.
  const ACCOUNT = snapshot({ XLM: row(10000, 1000), BLUSDC: row(1000, 1000) }, { BLUSDC: row(800, 800) });

  it("states the health factor after each fall, not only near zero", () => {
    const xlm = (data(liquidationObservation(ACCOUNT, 1000)).exposures[0] as unknown as {
      health_factor_if_falls: Array<{ fall_pct: string; health_factor: string }>;
    }).health_factor_if_falls;
    const at = (pct: string) => Number(xlm.find((step) => step.fall_pct === pct)?.health_factor);
    expect(at("10")).toBeCloseTo(2.375, 4); // (900 + 1000) / 800
    expect(at("30")).toBeCloseTo(2.125, 4); // (700 + 1000) / 800
    expect(at("50")).toBeCloseTo(1.875, 4); // (500 + 1000) / 800
  });

  it("the reply can cite the asked fall as its own fact", () => {
    const { facts } = normalizeResearchFacts([liquidationObservation(ACCOUNT, 1000)]);
    const thirty = facts.find((fact) => fact.label === "Health factor if XLM fell 30%");
    expect(thirty).toMatchObject({ unit: "HF", venue: "margin" });
    expect(Number(thirty?.value)).toBeCloseTo(2.125, 4);
  });
});

describe("dollar-pegged tokens", () => {
  it("every pegged token the account holds or owes is listed, so a question about one has an answer", () => {
    const out = data(liquidationObservation(REAL, 1000));
    // AQUSDC and BLUSDC are held and owed; SOUSDC has no balance; receipt tokens are not assets.
    expect(out.pegged?.map((entry) => entry.symbol)).toEqual(["AQUSDC", "BLUSDC"]);
  });

  it("says the page holds a pegged token at $1 rather than staying silent about it", () => {
    const { facts } = normalizeResearchFacts([liquidationObservation(REAL, 1000)]);
    const blusdc = facts.find((fact) => fact.label === "BLUSDC liquidation price");
    expect(blusdc?.unit).toBe("");
    expect(blusdc?.value.startsWith("none")).toBe(true);
    expect(blusdc?.value).toContain("dollar-pegged");
    expect(facts.find((fact) => fact.label === "XLM liquidation price")?.value).toBe("none");
  });

  it("an account with no debt, or already liquidatable, lists none", () => {
    expect(data(liquidationObservation(snapshot({ BLUSDC: row(100, 100) }, {}), 1000)).pegged).toBeUndefined();
    expect(data(liquidationObservation(snapshot({ XLM: row(8000, 800) }, { BLUSDC: row(800, 800) }), 1000)).pegged).toBeUndefined();
  });
});

describe("the facts the reply is built from", () => {
  it("a price that never liquidates says none and gives the health factor near zero", () => {
    const { facts } = normalizeResearchFacts([liquidationObservation(REAL, 1000)]);
    expect(facts.find((fact) => fact.label === "XLM liquidation price")).toMatchObject({ value: "none", unit: "" });
    const near = facts.find((fact) => fact.label === "Health factor if XLM fell to near zero");
    expect(near?.unit).toBe("HF");
    expect(Number(near?.value)).toBeGreaterThan(50);
  });

  it("a price that does liquidate is a price in dollars and a drop in percent", () => {
    const { facts } = normalizeResearchFacts([liquidationObservation(snapshot(
      { XLM: row(10000, 1000) }, { BLUSDC: row(800, 800) },
    ), 1000)]);
    const price = facts.find((fact) => fact.label === "XLM liquidation price");
    expect(price?.unit).toBe("USD");
    expect(formatFactValue(price!)).toBe("$0.088");
    const drop = facts.find((fact) => fact.label === "XLM drop to liquidation");
    expect(drop?.unit).toBe("%");
    expect(formatFactValue(drop!)).toBe("12.00%");
  });

  it("states the no-debt case in words and offers no price", () => {
    const { facts } = normalizeResearchFacts([liquidationObservation(snapshot({ XLM: row(100, 20) }, {}), 1000)]);
    expect(facts.map((fact) => fact.label)).toEqual(["Liquidation status"]);
    expect(facts[0].value).toBe("no debt, so no price liquidates the account");
  });

  it("nothing from the observation leaks as an unlabelled shape fact", () => {
    const { facts } = normalizeResearchFacts([liquidationObservation(REAL, 1000)]);
    expect(facts.every((fact) => /liquidation|Health factor if|every volatile/i.test(fact.label))).toBe(true);
  });
});

describe("tryLiquidationObservation", () => {
  it("returns the observation for a full snapshot", () => {
    expect(tryLiquidationObservation(REAL, 1000)?.capability).toBe("account_liquidation");
  });

  it("returns null for a snapshot without per-token balances rather than throwing", () => {
    const thin = { totalBorrowedValue: 278.91, grossCollateralValue: 1087.2 } as unknown as MarginSnapshot;
    expect(tryLiquidationObservation(thin, 1000)).toBeNull();
    expect(tryLiquidationObservation(null, 1000)).toBeNull();
    expect(tryLiquidationObservation(undefined, 1000)).toBeNull();
  });

  it("returns null when a balance cannot be read as a number rather than throwing", () => {
    const broken = snapshot({ XLM: null as unknown as Row }, { BLUSDC: row(1, 1) });
    expect(tryLiquidationObservation(broken, 1000)).toBeNull();
  });
});
