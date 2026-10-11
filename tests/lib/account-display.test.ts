import { describe, expect, it } from "vitest";
import { accountDisplayObservations } from "@/lib/copilot/investigation/account-display";
import { normalizeResearchFacts } from "@/lib/copilot/investigation/normalize";
import { factualReplyBlocks } from "@/lib/copilot/investigation/answer";
import type { MarginSnapshot } from "@/lib/copilot/investigation/capacity";
import type { Observation } from "@/lib/copilot/investigation/types";

const observation: Observation = { id: "pc0", capability: "account_collateral", args: {}, observedAt: 1, status: "ok", data: {
  collateral: [{ symbol: "XLM", balance: "100", value_usd: "20" }], total_value_usd: "20",
} };
const snapshot = { collateralBalances: {
  XLM: { amount: "100", usdValue: "20" }, SOUSDC: { amount: "50", usdValue: "50" },
  BLEND_XLM: { amount: "10", usdValue: "2" },
}, borrowedBalances: { XLM: { amount: "30", usdValue: "6" }, SOUSDC: { amount: "5", usdValue: "5" } }, debtDataIncomplete: false } as unknown as MarginSnapshot;

describe("account display basis", () => {
  it("carries MCP measurement basis into facts for every investigation", () => {
    const { facts } = normalizeResearchFacts([{ ...observation, data: { collateral: [{ symbol: "XLM", balance: "100", value_usd: "20", balance_basis: "posted_storage_collateral" }] } }]);
    expect(facts.find((fact) => fact.quantity)?.label).toContain("posted storage collateral");
  });
  it("shows the Margin page's Collateral Deposited, excludes farm receipts, and preserves the raw evidence", () => {
    const before = structuredClone(observation);
    const display = accountDisplayObservations([observation], snapshot, 2);
    expect(display[0].data?.collateral_deposited).toEqual([
      { symbol: "XLM", balance: "70", value_usd: "14", balance_basis: "collateral_deposited" },
      { symbol: "SOUSDC", balance: "45", value_usd: "45", balance_basis: "collateral_deposited" },
    ]);
    expect(display[0].data?.total_collateral_deposited_usd).toBe("59");
    expect(observation).toEqual(before);
    const { facts } = normalizeResearchFacts(display);
    const blocks = factualReplyBlocks(facts);
    expect(blocks.some((block) => block.type === "bullets" && block.items.length === 2)).toBe(true);
    expect(facts.some((fact) => fact.value === "70" && fact.quantity)).toBe(true);
  });
  it("agrees with the Margin page row for row on the live account it was checked against", () => {
    // 6 Oct: balances 11,902.39 XLM / 1,392.20 SOUSDC / 119.28 AQUSDC / 390.05 BLUSDC against debts
    // 7,679.85 / 22.00 / 25.20 / 365.00; the page listed 4,222.52 / 1,370.20 / 94.08 / 25.05.
    const live = { collateralBalances: {
      XLM: { amount: "11902.39", usdValue: "2575.53" }, SOUSDC: { amount: "1392.20", usdValue: "1392.32" },
      AQUSDC: { amount: "119.28", usdValue: "119.29" }, BLUSDC: { amount: "390.05", usdValue: "390.09" },
    }, borrowedBalances: {
      XLM: { amount: "7679.85", usdValue: "1661.82" }, SOUSDC: { amount: "22.00", usdValue: "22.00" },
      AQUSDC: { amount: "25.20", usdValue: "25.21" }, BLUSDC: { amount: "365.00", usdValue: "365.03" },
    }, totalBorrowedValue: 2074.07, debtDataIncomplete: false } as unknown as MarginSnapshot;
    const rows = accountDisplayObservations([observation], live, 2)[0].data?.collateral_deposited as Array<{ symbol: string; balance: string }>;
    const byToken = Object.fromEntries(rows.map((row) => [row.symbol, Number(row.balance)]));
    expect(byToken.XLM).toBeCloseTo(4222.54, 2);
    expect(byToken.SOUSDC).toBeCloseTo(1370.2, 2);
    expect(byToken.AQUSDC).toBeCloseTo(94.08, 2);
    expect(byToken.BLUSDC).toBeCloseTo(25.05, 2);
  });
  it("lists borrowed assets as their own figure beside it", () => {
    const debt: Observation = { id: "pd0", capability: "account_debt", args: {}, observedAt: 1, status: "ok", data: { debt: [] } };
    const [, borrowed] = accountDisplayObservations([observation, debt], { ...snapshot, totalBorrowedValue: 11 } as unknown as MarginSnapshot, 2);
    expect(borrowed.data?.debt).toEqual([
      { symbol: "XLM", balance: "30", value_usd: "6" }, { symbol: "SOUSDC", balance: "5", value_usd: "5" },
    ]);
    expect(borrowed.data?.total_debt_usd).toBe("11");
  });
  it("does not subtract incomplete debt or infer an empty position from a missing snapshot", () => {
    for (const missing of [null, { ...snapshot, debtDataIncomplete: true }]) {
      const fallback = accountDisplayObservations([observation], missing, 2)[0];
      expect(fallback.data?.posted_storage_collateral).toEqual(observation.data?.collateral);
      expect(fallback.data?.collateral_deposited).toBeUndefined();
    }
  });
});
