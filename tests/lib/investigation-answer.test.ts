import { describe, expect, it } from "vitest";
import { normalizeResearchFacts } from "@/lib/copilot/investigation/normalize";
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
    /**
     * Derived from the candidate's own sized amount rather than a hardcoded figure.
     * A derived max is sized one basis point inside the floor (`FLOOR_MARGIN_BPS` in
     * sizing.ts), so the exact dollar figure moves if that margin ever changes; the
     * point of this test — the reply cites the ranked size, not an invented one — does
     * not depend on what the figure currently is.
     */
    const expectedMoney = Number(top.amountUsd).toLocaleString("en-US", {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
    expect(reply).toContain(`$${expectedMoney}`);
    // 23 Sep: quoted as the venue pages show it (apy.ts), from the candidate's own figure.
    expect(top.netApyPct).toBeTruthy();
    expect(reply).toContain(`${Number(top.netApyPct).toFixed(2)}% APY`);
    expect(reply).not.toMatch(/% APR/);
    expect(reply).toMatch(/1\.30/);
    expect(reply).not.toMatch(/1000 USDC/i);
    expect(reply).not.toMatch(/Deposit 1000/i);
  });

  it("does not describe a composed borrow plan as idle funded when its supply rate is unavailable", () => {
    const candidate = generateCandidates({
      grossCollateralUsd: "317.00", debtUsd: "217.12", floor: "1.30",
      idleWalletUsd: null, comparisons: [comparison()],
    }).feasible[0];
    const composed = {
      ...candidate,
      decision: undefined,
      netAprPct: null,
      supplyAprPct: null,
      supplyApyPct: null,
      netApyPct: null,
      amountUsd: "100",
      steps: [
        { id: "borrow", op: "borrow" as const, asset: "BLUSDC", amount: "100", label: "Borrow 100 BLUSDC", tool: "borrow", args: {} },
        { id: "supply", op: "supply_blend" as const, asset: "BLUSDC", amount: "100", label: "Supply 100 BLUSDC to Blend", tool: "supply", args: {} },
      ],
    };
    const reply = strategyReply({
      status: "researched", facts: [], candidates: { feasible: [composed], rejected: [] },
      capacity: null, question: null,
    });

    expect(reply).toMatch(/includes borrowing/);
    expect(reply).toMatch(/supply rate could not be read/);
    expect(reply).not.toMatch(/idle funds only/i);
    expect(reply).not.toMatch(/% (?:APR|APY)/);
  });

  it("keeps idle-funds wording for a non-borrowing composed plan with unavailable rates", () => {
    const candidate = generateCandidates({
      grossCollateralUsd: "317.00", debtUsd: "217.12", floor: "1.30",
      idleWalletUsd: null, comparisons: [comparison()],
    }).feasible[0];
    const composed = {
      ...candidate,
      decision: undefined,
      netAprPct: null,
      supplyAprPct: null,
      supplyApyPct: null,
      netApyPct: null,
      amountUsd: "100",
      steps: [
        { id: "supply", op: "supply_blend" as const, asset: "BLUSDC", amount: "100", label: "Supply 100 BLUSDC to Blend", tool: "supply", args: {} },
      ],
    };
    const reply = strategyReply({
      status: "researched", facts: [], candidates: { feasible: [composed], rejected: [] },
      capacity: null, question: null,
    });

    expect(reply).toMatch(/using idle funds only; the supply rate could not be read/);
    expect(reply).not.toMatch(/includes borrowing/);
  });

  /**
   * 23 Sep, X12 "withdraw all funds": four Earn redeems were captioned "using idle funds only;
   * the supply rate could not be read". A plan that only takes money out has neither.
   */
  it("gives a plan that only takes money out no rate or idle-funds sentence", () => {
    const candidate = generateCandidates({
      grossCollateralUsd: "317.00", debtUsd: "217.12", floor: "1.30",
      idleWalletUsd: null, comparisons: [comparison()],
    }).feasible[0];
    const redeems = {
      ...candidate, decision: undefined, netAprPct: null, supplyAprPct: null, supplyApyPct: null, netApyPct: null,
      label: "Redeem all Earn positions", amountUsd: "179.34",
      steps: ["XLM", "BLUSDC"].map((asset) => ({
        id: asset, op: "redeem" as const, asset, amount: "10", label: `Redeem 10 ${asset} vTokens from Earn`, tool: "vanna_redeem", args: {},
      })),
    };
    const reply = strategyReply({
      status: "researched", facts: [], candidates: { feasible: [redeems], rejected: [] }, capacity: null, question: null,
    });
    expect(reply).toMatch(/^Redeem all Earn positions: redeem 10 XLM/);
    expect(reply).not.toMatch(/idle funds/);
    expect(reply).not.toMatch(/supply rate/);
    expect(reply).toMatch(/Approve to run those steps\.$/);
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

  it("says what is idle when a strategy turn has no option and nothing ruled out (13 Sep: 3.97 XLM, all minimum balance)", () => {
    const wallet = (label: string, value: string) => ({ id: label, label, value, unit: label.split(" ")[0], venue: "wallet" as const, evidenceId: "e1", sourcePath: label, readAt: 0 });
    const reply = strategyReply({
      status: "researched",
      facts: [wallet("XLM wallet balance", "3.9736786"), wallet("XLM wallet spendable", "0"), wallet("AQUSDC wallet balance", "0.0003729")],
      candidates: { feasible: [], rejected: [] } as never,
      capacity: null,
      question: null,
      intent: "strategy",
      findings: [{ summary: "The reported supply rates are BLUSDC Earn: 29.08 % APR; AQUSDC Earn: 20.18 % APR." }],
    });
    expect(reply).toMatch(/^Idle in the wallet: XLM 0 spendable of 3\.9737, AQUSDC 0\.0004\./);
    expect(reply).toMatch(/reported supply rates/);
  });

  it("prints each market's supply rate once even when two reads carried it", () => {
    const rate = (label: string, value: string, id: string) => ({ id, label, value, unit: "% APR", venue: "blend" as const, evidenceId: id, sourcePath: id, readAt: 0 });
    const reply = strategyReply({
      status: "researched",
      facts: [rate("XLM Blend supply APR", "168.6584", "e1:reserves[0].supply_apr_pct"), rate("XLM Blend supply APR", "168.6584", "e2:supply_apr_pct")],
      candidates: null,
      capacity: null,
      question: null,
      intent: "answer",
      originalRequest: "what is the blend xlm rate",
    });
    expect(reply.match(/XLM Blend/g)?.length).toBe(1);
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

  it("names every debt row the read returned, not the total alone (14 Sep: 'what are the debt tokens I am holding')", () => {
    const { facts } = normalizeResearchFacts([{
      id: "e2", capability: "account_debt", args: {}, observedAt: 1, status: "ok",
      data: { debt: [{ symbol: "XLM", balance: "14113.4967211", value_usd: "2540.43" }, { symbol: "USDC", balance: "772", value_usd: "772" }], total_debt_usd: "3312.43" },
    }]);
    const reply = strategyReply({
      status: "researched", facts, candidates: null, capacity: null, question: null, intent: "answer",
      originalRequest: "what are the debt tokens currently i am holding",
      findings: [{ summary: "Your reported margin debt is $3,312.43." }],
    });
    expect(reply).toBe("Debt: XLM 14,113.4967211 ($2,540.43), BLUSDC 772 ($772.00); total $3,312.43.");
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
