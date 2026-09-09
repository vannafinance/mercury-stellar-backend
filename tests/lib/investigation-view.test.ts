import { describe, expect, it } from "vitest";
import { generateCandidates } from "@/lib/copilot/investigation/candidates";
import { shouldUseLegacyExecutor, type ResearchView } from "@/lib/copilot/investigation/view";
import type { RateComparison } from "@/lib/copilot/investigation/rate-comparison";

function view(over: Partial<ResearchView> = {}): ResearchView {
  return {
    status: "researched",
    message: "checked",
    originalRequest: "swap 10 XLM to AQUSDC then add liquidity",
    refinements: [],
    understanding: { objective: "Swap 10 XLM", constraints: [], borrowing: "forbidden" },
    question: null,
    facts: [],
    capacity: null,
    candidates: null,
    rateComparisons: [],
    checks: [],
    warnings: [],
    scope: { wallet: "GDW3B2BVO3MUBPIYWZQA6ZGIOHD73CNZITY5YKVD5KOOHMZ72REVVJ52", smartAccount: null, network: "testnet" },
    continuation: "sealed",
    executionAllowed: false,
    ...over,
  };
}

const comparison = (over: Partial<RateComparison> = {}): RateComparison => ({
  asset: "BLUSDC",
  earnSupplyApr: "25.41",
  blendSupplyApr: "10",
  marginBorrowApr: "4",
  spreadApr: "6",
  verdict: "positive_before_costs",
  evidenceIds: ["e1"],
  ...over,
});

describe("shouldUseLegacyExecutor", () => {
  it("stays on the journal path when a floor or feasible candidates exist", () => {
    expect(shouldUseLegacyExecutor(view({
      capacity: {
        floor: "1.30", grossCollateralUsd: "317.00", debtUsd: "217.12",
        healthFactor: "1.46", maxBorrowUsd: "115.81",
      },
    }))).toBe(false);

    const candidates = generateCandidates({
      grossCollateralUsd: "317.00", debtUsd: "217.12", floor: "1.30",
      idleWalletUsd: null, comparisons: [comparison()],
    });
    expect(candidates.feasible.length).toBeGreaterThan(0);
    expect(shouldUseLegacyExecutor(view({ candidates }))).toBe(false);
  });

  it("uses the keyword executor only for a concrete researched action with neither", () => {
    expect(shouldUseLegacyExecutor(view())).toBe(false);
  });

  it("does not hand an unfinished investigation to the keyword executor", () => {
    expect(shouldUseLegacyExecutor(view({ status: "needs_input", question: "Which venue?" }))).toBe(false);
    expect(shouldUseLegacyExecutor(view({ question: "Which venue?" }))).toBe(false);
    expect(shouldUseLegacyExecutor(view({ status: "blocked" }))).toBe(false);
  });
});
