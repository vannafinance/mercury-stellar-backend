import { describe, expect, it } from "vitest";
import { askForUnstatedAmounts } from "@/lib/copilot/investigation/unstated-amount";
import { buildQuestionnaire, buildQuestionnaireSet, answerProblem } from "@/lib/copilot/investigation/questionnaire";

const reserve = { asset: "XLM", amount: "50", sourceQuote: "keep 50 xlm" };
const floor = { value: "1.5", sourceQuote: "above 1.5" };

describe("the user's limits survive an all-idle amount turned into a question", () => {
  it("carries the reserve and floor into the clarify and the sealed questionnaire", () => {
    const out = askForUnstatedAmounts({
      kind: "research_complete",
      goal: { objective: "x", constraints: [], borrowing: "unspecified", intent: "strategy", walletReserves: [reserve], healthFactorFloor: floor,
        actions: [{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" }, sourceQuote: "deposit xlm" }] },
      findings: [], openQuestions: [],
    } as never) as unknown as { kind: string; carried: unknown };
    expect(out.kind).toBe("clarify");
    expect(out.carried).toEqual({ walletReserves: [reserve], healthFactorFloor: floor });
    const q = buildQuestionnaireSet([{ op: "deposit_collateral", asset: "XLM", slots: ["amount"], sourceQuote: "deposit xlm" }],
      [{ id: "w", capability: "wallet_balances", args: {}, observedAt: 1, status: "ok", data: { assets: [{ symbol: "XLM", balance: "100", decimals: 7, status: "ok" }], fee_reserve_xlm: "0" } }],
      1, ["deposit xlm, keep 50 xlm, above 1.5"], [], true, undefined, out.carried as never);
    expect(q?.carried).toEqual({ walletReserves: [reserve], healthFactorFloor: floor });
  });
});

describe("unread balances still give the asset step options", () => {
  it("offers every candidate and accepts one back", () => {
    const q = buildQuestionnaire({ asset: "USDC", slots: ["asset", "venue", "amount"] }, [], 1)!;
    const assets = q.steps.find((s) => s.slot === "asset")!.options.map((o) => o.id);
    expect(assets.length).toBeGreaterThan(1);
    const problem = answerProblem(q, { questionnaireId: q.id, asset: assets[0], venue: null, amount: { kind: "literal", amount: "1" }, summary: "s" });
    expect(problem).not.toBe("That asset was not one of the options.");
  });
});
