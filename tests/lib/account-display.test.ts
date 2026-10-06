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
  it("shows balances gross of debt, excludes farm receipts, and preserves the raw evidence", () => {
    const before = structuredClone(observation);
    const display = accountDisplayObservations([observation], snapshot, 2);
    expect(display[0].data?.balances_before_debt).toEqual([
      { symbol: "XLM", balance: "100", value_usd: "20", balance_basis: "gross_balance_before_debt" },
      { symbol: "SOUSDC", balance: "50", value_usd: "50", balance_basis: "gross_balance_before_debt" },
    ]);
    expect(display[0].data?.total_balances_before_debt_usd).toBe("70");
    expect(display[0].data?.net_deposited_collateral).toBeUndefined();
    expect(observation).toEqual(before);
    const { facts } = normalizeResearchFacts(display);
    const blocks = factualReplyBlocks(facts);
    expect(blocks.some((block) => block.type === "bullets" && block.items.length === 2)).toBe(true);
    expect(facts.some((fact) => fact.value === "100" && fact.quantity)).toBe(true);
  });
  it("does not pass a borrow swapped into another token off as that token's deposit", () => {
    // 100 XLM posted, 1000 XLM borrowed and swapped to SOUSDC: the XLM debt stays on the XLM side and
    // the proceeds stay a SOUSDC balance. Nothing is netted across, and the debt is its own figure.
    const swapped = { collateralBalances: { XLM: { amount: "100", usdValue: "20" }, SOUSDC: { amount: "110", usdValue: "110" } },
      borrowedBalances: { XLM: { amount: "1000", usdValue: "200" } }, totalBorrowedValue: 200, debtDataIncomplete: false } as unknown as MarginSnapshot;
    const debt: Observation = { id: "pd0", capability: "account_debt", args: {}, observedAt: 1, status: "ok", data: { debt: [] } };
    const [collateral, borrowed] = accountDisplayObservations([observation, debt], swapped, 2);
    expect(collateral.data?.balances_before_debt).toEqual([
      { symbol: "XLM", balance: "100", value_usd: "20", balance_basis: "gross_balance_before_debt" },
      { symbol: "SOUSDC", balance: "110", value_usd: "110", balance_basis: "gross_balance_before_debt" },
    ]);
    expect(borrowed.data?.debt).toEqual([{ symbol: "XLM", balance: "1000", value_usd: "200" }]);
    expect(borrowed.data?.total_debt_usd).toBe("200");
  });
  it("does not subtract incomplete debt or infer an empty position from a missing snapshot", () => {
    for (const missing of [null, { ...snapshot, debtDataIncomplete: true }]) {
      const fallback = accountDisplayObservations([observation], missing, 2)[0];
      expect(fallback.data?.posted_storage_collateral).toEqual(observation.data?.collateral);
      expect(fallback.data?.balances_before_debt).toBeUndefined();
    }
  });
});
