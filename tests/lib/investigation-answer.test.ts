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

  it("rounds USD to two decimals and leaves token precision in the stored fact", () => {
    const debt = {
      id: "e0:debt_usd", label: "Reported debt value",
      value: "278.9886", unit: "USD" as const,
      venue: "margin" as const, evidenceId: "e0", sourcePath: "debt_usd", readAt: 1,
    };
    const tokens = {
      id: "e1:balance", label: "XLM wallet balance",
      value: "2781.9471234", unit: "XLM" as const,
      venue: "wallet" as const, evidenceId: "e1", sourcePath: "assets[0].balance", readAt: 1,
    };
    const reply = strategyReply({
      status: "researched", facts: [debt, tokens],
      candidates: null, capacity: null, question: null, intent: "answer",
    });
    expect(reply).toMatch(/\$278\.99/);
    expect(reply).toMatch(/2,781\.9471234 XLM/);
    expect(reply).not.toMatch(/\$278\.9886/);
    expect(debt.value).toBe("278.9886");
    expect(tokens.value).toBe("2781.9471234");
  });

  it("rounds a health factor to two decimals without changing the stored fact", () => {
    const fact = {
      id: "e0:health_factor", label: "Current health factor",
      value: "3.898658825216954744", unit: "HF" as const,
      venue: "margin" as const, evidenceId: "e0", sourcePath: "health_factor", readAt: 1,
    };
    const reply = strategyReply({
      status: "researched", facts: [fact],
      candidates: null, capacity: null, question: null, intent: "answer",
    });
    expect(reply).toBe("Your reported health factor is 3.90.");
    expect(fact.value).toBe("3.898658825216954744");
  });

  it("names posted-collateral health as the risk-engine figure, not the page snapshot", () => {
    const reply = strategyReply({
      status: "researched",
      facts: [{
        id: "e0:posted_health_factor", label: "Posted-collateral health factor",
        value: "3.42", unit: "HF", venue: "margin", evidenceId: "e0",
        sourcePath: "posted_health_factor", readAt: 1,
      }],
      candidates: null, capacity: null, question: null, intent: "answer",
    });
    expect(reply).toBe("3.42 on posted collateral, the base the risk engine uses.");
  });

  it("refuses the panel figure when debt does not match the risk engine", () => {
    const reply = strategyReply({
      status: "researched",
      facts: [
        {
          id: "e0:posted_health_factor", label: "Posted-collateral health factor",
          value: "3.42", unit: "HF", venue: "margin", evidenceId: "e0",
          sourcePath: "posted_health_factor", readAt: 1,
        },
        {
          id: "e0:page_debt_mismatch", label: "Account panel disagrees",
          value: "25.50", unit: "", venue: "margin", evidenceId: "e0",
          sourcePath: "page_debt_mismatch", readAt: 1,
        },
      ],
      candidates: null, capacity: null, question: null, intent: "answer",
    });
    expect(reply).toMatch(/3\.42 on posted collateral/);
    expect(reply).toMatch(/25\.50/);
    expect(reply).not.toMatch(/Your reported health factor is 25\.50/);
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

  it("does not dump wallet holdings for a stated repay", () => {
    const reply = strategyReply({
      status: "researched",
      facts: [
        {
          id: "e1:balance", label: "XLM wallet balance", value: "19354.27", unit: "XLM",
          venue: "wallet", evidenceId: "e1", sourcePath: "assets[0].balance", readAt: 1,
        },
        {
          id: "e1:blusdc", label: "BLUSDC wallet balance", value: "193", unit: "BLUSDC",
          venue: "wallet", evidenceId: "e1", sourcePath: "assets[1].balance", readAt: 1,
        },
        {
          id: "e0:hf", label: "Current health factor", value: "3.12", unit: "HF",
          venue: "margin", evidenceId: "e0", sourcePath: "health_factor", readAt: 1,
        },
        {
          id: "e0:debt", label: "Reported debt value", value: "278.86", unit: "USD",
          venue: "margin", evidenceId: "e0", sourcePath: "debt_usd", readAt: 1,
        },
      ],
      candidates: null, capacity: null, question: null, intent: "strategy",
      originalRequest: "repay 1xlm from my account",
      statedSteps: [{ label: "repay 1 XLM" }],
    });
    expect(reply).toMatch(/repay 1 XLM/i);
    expect(reply).not.toMatch(/wallet holds/i);
    expect(reply).not.toMatch(/health factor is 3\.12/i);
    expect(reply).not.toMatch(/\$278\.86/);
    expect(reply).not.toMatch(/BLUSDC/);
  });
});
