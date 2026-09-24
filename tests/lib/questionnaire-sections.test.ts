/**
 * One request, several actions: one questionnaire, one section each, in the user's order.
 */
import { describe, expect, it } from "vitest";
import { parseDecision } from "@/lib/copilot/investigation/decision";
import { planFromStatedActions, resolvePlans } from "@/lib/copilot/investigation/plan";
import { actionsFromAnswers, answerProblem, buildQuestionnaire, buildQuestionnaireSet, parseQuestionnaireMissingList, type QuestionnaireMissing } from "@/lib/copilot/investigation/questionnaire";
import type { Observation, StatedAction } from "@/lib/copilot/investigation/types";
import type { QuestionnaireAnswers } from "@/lib/copilot/investigation/view";

const NOW = 1_700_000_000_000;
const obs = (id: string, capability: string, data: Record<string, unknown>, args: Record<string, unknown> = {}): Observation =>
  ({ id, capability, args, observedAt: NOW, status: "ok", data });
const wallet = (rows: Array<{ symbol: string; balance: string }>) =>
  obs("w", "wallet_balances", { assets: rows.map((row) => ({ ...row, decimals: 7, status: "ok" })), fee_reserve_xlm: "0" });
const account = (rows: Array<{ symbol: string; balance: string }>) =>
  obs("a", "account_collateral", { collateral: rows });
const prices = ["XLM", "BLUSDC", "AQUSDC"].map((asset) =>
  obs(`p-${asset}`, "asset_price", { price_usd: asset === "XLM" ? "0.2" : "1" }, { asset }));
const pool = obs("r", "aquarius_pool_reserves", {
  found: true,
  pool: { available: true, reserves: { XLM: "10000", USDC: "2000" }, total_share: "1000", fee: "0.003", reserves_source: "ledger" },
}, { asset: "AQUSDC" });
const blend = obs("b", "blend_markets", { reserves: [{ symbol: "XLM", supply_apr_pct: "12" }, { symbol: "USDC", supply_apr_pct: "8" }] });
const earn = obs("e", "earn_market", { supply_apr_pct: "5" }, { asset: "BLUSDC" });

const rows = [
  wallet([{ symbol: "XLM", balance: "1000" }, { symbol: "BLUSDC", balance: "400" }]),
  account([{ symbol: "XLM", balance: "100" }, { symbol: "BLUSDC", balance: "0" }]),
  ...prices, pool, blend, earn,
];

const exampleA = "deposit xlm, lend blusdc and swap xlm to aqusdc";
const missingA: QuestionnaireMissing[] = [
  { op: "deposit_collateral", asset: "XLM", slots: ["amount"], sourceQuote: "deposit xlm" },
  { op: "lend", asset: "BLUSDC", slots: ["amount"], sourceQuote: "lend blusdc" },
  { op: "swap", asset: "XLM", slots: ["amount"], sourceQuote: "swap xlm to aqusdc" },
];

describe("one questionnaire, one section per action", () => {
  it("keeps a single object as a one-entry list", () => {
    const list = parseQuestionnaireMissingList({ asset: "XLM", slots: ["amount"] });
    expect(list).toEqual([{ asset: "XLM", slots: ["amount"] }]);
    const fromObject = buildQuestionnaire({ asset: "XLM", op: "lend", slots: ["amount"] }, rows, NOW);
    const fromList = buildQuestionnaireSet([{ asset: "XLM", op: "lend", slots: ["amount"] }], rows, NOW, ["lend xlm"]);
    expect(fromList?.sections).toHaveLength(1);
    expect(fromList?.steps.map((step) => step.slot)).toEqual(fromObject?.steps.map((step) => step.slot));
  });

  it("builds example A with the deposit reflected in the swap max", () => {
    const built = buildQuestionnaireSet(missingA, rows, NOW, [exampleA]);
    expect(built?.sections?.map((section) => section.title)).toEqual(["Deposit XLM", "Lend BLUSDC", "Swap XLM"]);
    const maxOf = (index: number) => {
      const step = built?.sections?.[index].steps.find((item) => item.slot === "amount");
      return Object.values(step?.max ?? {})[0];
    };
    expect(maxOf(0)).toMatchObject({ amount: "1000", asset: "XLM" });
    expect(maxOf(1)).toMatchObject({ amount: "400", asset: "BLUSDC" });
    expect(maxOf(2)?.asset).toBe("XLM");
    expect(maxOf(2)?.amount).toBe("1100");
    expect(maxOf(0)?.where).toMatch(/wallet/);
    expect(maxOf(2)?.where).toMatch(/margin account/);
  });

  it("offers the linked amount on example B and sizes it as the previous leg", () => {
    const message = "deposit xlm and blusdc and farm in blend";
    const missing: QuestionnaireMissing[] = [
      { op: "deposit_collateral", asset: "XLM", slots: ["amount"], sourceQuote: "deposit xlm" },
      { op: "deposit_collateral", asset: "BLUSDC", slots: ["amount"], sourceQuote: "deposit xlm and blusdc" },
      { op: "supply_blend", asset: "XLM", slots: ["amount"], sourceQuote: "farm in blend" },
    ];
    const built = buildQuestionnaireSet(missing, rows, NOW, [message])!;
    const blendSection = built.sections![2];
    const link = blendSection.steps.find((step) => step.slot === "amount")?.options[0];
    expect(link?.label).toBe("All of the XLM you just deposited");
    const summary = "Deposit 500 XLM and 20 BLUSDC, then supply the XLM to Blend";
    const answers: QuestionnaireAnswers = {
      questionnaireId: built.id, asset: "XLM", venue: null, amount: { kind: "previous_leg" }, summary,
      sections: [
        { sectionId: built.sections![0].id, asset: "XLM", venue: "deposit_collateral:XLM", amount: { kind: "literal", amount: "500" } },
        { sectionId: built.sections![1].id, asset: "BLUSDC", venue: "deposit_collateral:BLUSDC", amount: { kind: "literal", amount: "20" } },
        { sectionId: blendSection.id, asset: "XLM", venue: "supply_blend:XLM", amount: { kind: "previous_leg" } },
      ],
    };
    expect(answerProblem(built, answers)).toBeNull();
    const actions = actionsFromAnswers(built, answers);
    expect(actions[2].sizing).toEqual({ kind: "previous_leg" });
    const typed: StatedAction[] = [
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "500", sourceQuote: summary }, sourceQuote: summary },
      { op: "deposit_collateral", asset: "BLUSDC", sizing: { kind: "literal", amount: "20", sourceQuote: summary }, sourceQuote: summary },
      { op: "supply_blend", asset: "XLM", sizing: { kind: "previous_leg" }, sourceQuote: summary },
    ];
    const ctx = {
      scope: {
        subject: "user", network: "testnet",
        trader: "GBH5G2WPAAFZ5MS76GDJ4HKHYXSRGF2MBLYDIRQOHGVS4HPU6NNOFIHA",
        smartAccount: "CCKITLMKA2VKSWGOTFABSUFA3RMOZHRP5YNP6HLG73JSWMMUUNCTHDMC",
      },
      observations: rows, now: NOW, messages: [summary],
      capacity: { grossCollateralUsd: "1000", debtUsd: "0", floor: "1.1" },
      borrowing: "forbidden" as const, comparisons: [],
    };
    const fromCard = resolvePlans([planFromStatedActions(actions, summary)!], ctx);
    const fromTyping = resolvePlans([planFromStatedActions(typed, summary)!], ctx);
    expect(fromCard.candidates[0]?.steps?.map((step) => [step.op, step.asset, step.amount])).toEqual(
      fromTyping.candidates[0]?.steps?.map((step) => [step.op, step.asset, step.amount]),
    );
    expect(fromCard.rejected.map((item) => item.reason)).toEqual([]);
    expect(fromCard.candidates[0]?.steps?.find((step) => step.op === "supply_blend")?.amount).toBe("500");
  });

  it("gives a fully stated action no section, and nothing missing no questionnaire", () => {
    const message = "lend 20 blusdc and deposit xlm";
    const built = buildQuestionnaireSet([
      { op: "deposit_collateral", asset: "XLM", slots: ["amount"], sourceQuote: "deposit xlm" },
    ], rows, NOW, [message]);
    expect(built?.sections).toHaveLength(1);
    expect(built?.sections?.[0].title).toBe("Deposit XLM");
    expect(buildQuestionnaireSet([], rows, NOW, [message])).toBeNull();
    const dropped = buildQuestionnaireSet([
      { op: "lend", asset: "XLM", slots: ["amount"], sourceQuote: "this quote was not written" },
    ], rows, NOW, [message]);
    expect(dropped).toBeNull();
  });

  it("refuses a forged section and an over-max amount", () => {
    const built = buildQuestionnaireSet(missingA, rows, NOW, [exampleA])!;
    const answers: QuestionnaireAnswers = {
      questionnaireId: built.id, asset: "XLM", venue: null, amount: { kind: "literal", amount: "1" }, summary: exampleA,
      sections: [
        { sectionId: "forged", asset: "XLM", venue: "deposit_collateral:XLM", amount: { kind: "literal", amount: "1" } },
      ],
    };
    expect(answerProblem(built, answers)).toMatch(/section/);
    expect(answerProblem(built, {
      ...answers,
      sections: [{ sectionId: built.sections![0].id, asset: "XLM", venue: "deposit_collateral:XLM", amount: { kind: "literal", amount: "99999" } }],
    })).toMatch(/more than/);
  });

  it("sizes example A the same as typing it, and the swap still reaches its review line", () => {
    const built = buildQuestionnaireSet(missingA, rows, NOW, [exampleA])!;
    const summary = "Deposit 10 XLM, lend 20 BLUSDC, and swap 5 XLM to AQUSDC";
    const answers: QuestionnaireAnswers = {
      questionnaireId: built.id, asset: "XLM", venue: null, amount: { kind: "literal", amount: "10" }, summary,
      sections: [
        { sectionId: built.sections![0].id, asset: "XLM", venue: "deposit_collateral:XLM", amount: { kind: "literal", amount: "10" } },
        { sectionId: built.sections![1].id, asset: "BLUSDC", venue: "lend:BLUSDC", amount: { kind: "literal", amount: "20" } },
        { sectionId: built.sections![2].id, asset: "XLM", venue: "swap:XLM", amount: { kind: "literal", amount: "5" } },
      ],
    };
    expect(answerProblem(built, answers)).toBeNull();
    const actions = actionsFromAnswers(built, answers);
    const typed: StatedAction[] = [
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "10", sourceQuote: summary }, sourceQuote: summary },
      { op: "lend", asset: "BLUSDC", sizing: { kind: "literal", amount: "20", sourceQuote: summary }, sourceQuote: summary },
      { op: "swap", asset: "XLM", assetOut: "AQUSDC", sizing: { kind: "literal", amount: "5", sourceQuote: summary }, sourceQuote: exampleA },
    ];
    const ctx = {
      scope: {
        subject: "user", network: "testnet",
        trader: "GBH5G2WPAAFZ5MS76GDJ4HKHYXSRGF2MBLYDIRQOHGVS4HPU6NNOFIHA",
        smartAccount: "CCKITLMKA2VKSWGOTFABSUFA3RMOZHRP5YNP6HLG73JSWMMUUNCTHDMC",
      },
      observations: rows, now: NOW, messages: [summary],
      capacity: { grossCollateralUsd: "1000", debtUsd: "0", floor: "1.1" },
      borrowing: "forbidden" as const, comparisons: [],
    };
    const fromCard = resolvePlans([planFromStatedActions(actions, summary)!], ctx);
    const fromTyping = resolvePlans([planFromStatedActions(typed, summary)!], ctx);
    const shape = (steps: { op: string; asset: string; amount: string }[] | undefined) => steps?.map((step) => [step.op, step.asset, step.amount]);
    expect(fromCard.rejected.map((item) => item.reason)).toEqual([]);
    expect(fromTyping.rejected.map((item) => item.reason)).toEqual([]);
    expect(shape(fromCard.candidates[0]?.steps)).toEqual(shape(fromTyping.candidates[0]?.steps));
    expect(fromCard.candidates[0]?.steps?.find((step) => step.op === "swap")?.label).toMatch(/at least/);
  });

  it("still parses a single-object missing on a clarify decision", () => {
    const decision = parseDecision({
      kind: "clarify", question: "How much?",
      missing: { op: "lend", asset: "XLM", slots: ["amount"] },
    });
    expect(decision?.kind).toBe("clarify");
    if (decision?.kind === "clarify") expect(decision.missing).toEqual([{ op: "lend", asset: "XLM", slots: ["amount"] }]);
  });
});
