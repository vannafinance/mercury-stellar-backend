import { describe, expect, it } from "vitest";
import { strategyReply } from "@/lib/copilot/investigation/answer";
import { generateCandidates } from "@/lib/copilot/investigation/candidates";
import type { RateComparison } from "@/lib/copilot/investigation/rate-comparison";

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

describe("strategyReply", () => {
  it("cites the ranked candidate size and APR, never an invented 1000 USDC deposit", () => {
    const candidates = generateCandidates({
      grossCollateralUsd: "317.00", debtUsd: "217.12", floor: "1.30",
      idleWalletUsd: null, comparisons: [comparison()],
    });
    const top = candidates.feasible[0];
    expect(top).toBeTruthy();
    const reply = strategyReply({
      status: "researched",
      facts: [],
      candidates,
      capacity: {
        floor: "1.30", grossCollateralUsd: "317.00", debtUsd: "217.12",
        healthFactor: "1.46", maxBorrowUsd: top.amountUsd,
      },
      question: null,
    });
    expect(reply).toContain(top.label);
    expect(reply).toMatch(/\$115\.81/);
    expect(reply).toMatch(/6\.00% APR/);
    expect(reply).toMatch(/1\.30/);
    expect(reply).not.toMatch(/1000 USDC/i);
    expect(reply).not.toMatch(/Deposit 1000/i);
  });

  it("publishes conceptual findings when intent is answer and there are no sized facts", () => {
    const reply = strategyReply({
      status: "researched",
      facts: [],
      candidates: null,
      capacity: null,
      question: null,
      intent: "answer",
      findings: [{ summary: "A health factor is collateral divided by debt. 1.1 is liquidation." }],
    });
    expect(reply).toMatch(/collateral divided by debt/);
    expect(reply).not.toMatch(/completed checks/);
  });

  it("cites a can_withdraw read in the factual answer", () => {
    const reply = strategyReply({
      status: "researched",
      facts: [{
        id: "e2:allowed", label: "withdraw 100 XLM", value: "allowed", unit: "",
        venue: "margin", evidenceId: "e2", sourcePath: "allowed", readAt: 1,
      }],
      candidates: null, capacity: null, question: null, intent: "answer",
    });
    expect(reply).toMatch(/withdraw 100 XLM is allowed on the current health check/);
  });

  it("names Earn when that idle path ranks first", () => {
    const candidates = generateCandidates({
      grossCollateralUsd: "317.00", debtUsd: "217.12", floor: "1.30",
      idleWalletUsd: "680", idleWalletByAssetUsd: { BLUSDC: "680" },
      borrowingAllowed: false, comparisons: [comparison()],
    });
    expect(candidates.feasible[0].venue).toBe("earn");
    const reply = strategyReply({
      status: "researched", facts: [], candidates, capacity: null, question: null,
    });
    expect(reply).toMatch(/Earn and Blend supply rates/);
    expect(reply).toMatch(/Lend idle BLUSDC to Earn/);
    expect(reply).toMatch(/\$680\.00/);
    expect(reply).not.toMatch(/1000 USDC/i);
  });
});
