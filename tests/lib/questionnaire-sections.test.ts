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
    expect(answerProblem(built, answers)).toMatch(/section|once/);
    const ids = built.sections!.map((section) => section.id);
    expect(answerProblem(built, {
      ...answers,
      sections: [
        { sectionId: ids[0], asset: "XLM", venue: "deposit_collateral:XLM", amount: { kind: "literal", amount: "99999" } },
        { sectionId: ids[1], asset: "BLUSDC", venue: "lend:BLUSDC", amount: { kind: "literal", amount: "1" } },
        { sectionId: ids[2], asset: "XLM", venue: "swap:XLM", amount: { kind: "literal", amount: "1" } },
      ],
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

  it("deposits the stated 100 once, and only the shortfall when 60 is already posted", () => {
    const quote = "deposit 100 xlm and supply 100 xlm to blend";
    const scope = {
      subject: "user", network: "testnet",
      trader: "GBH5G2WPAAFZ5MS76GDJ4HKHYXSRGF2MBLYDIRQOHGVS4HPU6NNOFIHA",
      smartAccount: "CCKITLMKA2VKSWGOTFABSUFA3RMOZHRP5YNP6HLG73JSWMMUUNCTHDMC",
    };
    const sized = (legs: StatedAction[], said: string, posted: string) => resolvePlans([planFromStatedActions(legs, said)!], {
      scope, now: NOW, messages: [said], borrowing: "forbidden" as const, comparisons: [],
      capacity: { grossCollateralUsd: "1000", debtUsd: "0", floor: "1.1" },
      observations: [
        wallet([{ symbol: "XLM", balance: "500" }]),
        account([{ symbol: "XLM", balance: posted }]),
        ...prices, blend,
      ],
    });
    const both: StatedAction[] = [
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: quote }, sourceQuote: quote },
      { op: "supply_blend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: quote }, sourceQuote: quote },
    ];
    expect(sized(both, quote, "0").candidates[0]?.steps?.filter((step) => step.op === "deposit_collateral").map((step) => step.amount)).toEqual(["100"]);
    const supplyOnly = "supply 100 xlm to blend";
    const supply: StatedAction[] = [
      { op: "supply_blend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: supplyOnly }, sourceQuote: supplyOnly },
    ];
    expect(sized(supply, supplyOnly, "60").candidates[0]?.steps?.filter((step) => step.op === "deposit_collateral").map((step) => step.amount)).toEqual(["40"]);

    const twice = "supply 60 xlm twice";
    const doubleSupply: StatedAction[] = [
      { op: "supply_blend", asset: "XLM", sizing: { kind: "literal", amount: "60", sourceQuote: twice }, sourceQuote: twice },
      { op: "supply_blend", asset: "XLM", sizing: { kind: "literal", amount: "60", sourceQuote: twice }, sourceQuote: twice },
    ];
    const doubleResult = resolvePlans([planFromStatedActions(doubleSupply, twice)!], {
      scope, now: NOW, messages: [twice], borrowing: "forbidden" as const, comparisons: [],
      capacity: { grossCollateralUsd: "1000", debtUsd: "0", floor: "1.1" },
      observations: [wallet([{ symbol: "XLM", balance: "100" }]), account([{ symbol: "XLM", balance: "0" }]), ...prices, blend],
    });
    expect(doubleResult.candidates).toHaveLength(0);
    expect(doubleResult.rejected[0]?.reason).toMatch(/wallet has 40 XLM.*does not cover the other 60/i);

    const precise = "supply 1 xlm to blend";
    const precisionResult = resolvePlans([planFromStatedActions([{
      op: "supply_blend", asset: "XLM", sizing: { kind: "literal", amount: "1", sourceQuote: precise }, sourceQuote: precise,
    }], precise)!], {
      scope, now: NOW, messages: [precise], borrowing: "forbidden" as const, comparisons: [],
      capacity: { grossCollateralUsd: "1000", debtUsd: "0", floor: "1.1" },
      observations: [
        obs("w2", "wallet_balances", { assets: [{ symbol: "XLM", balance: "10", decimals: 2, status: "ok" }], fee_reserve_xlm: "0" }),
        account([{ symbol: "XLM", balance: "0.995" }]), ...prices, blend,
      ],
    });
    expect(precisionResult.candidates).toHaveLength(0);
    expect(precisionResult.rejected[0]?.reason).toMatch(/only 0\.99 XLM is in the margin account/i);
  });

  it("keeps Blend when the money comes from the margin account, and ignores a forged swap summary", () => {
    const open = buildQuestionnaire({ asset: "XLM", op: "supply_blend", slots: ["venue", "amount"] }, rows, NOW, ["supply xlm"]);
    expect(open?.steps.find((step) => step.slot === "venue")?.options.map((option) => option.label)).toEqual([
      "Earn", "Margin account", "Farm · Blend", "Aquarius XLM/AQUSDC pool", "Soroswap XLM/SOUSDC pool",
    ]);
    const fromAccount = buildQuestionnaire({ asset: "XLM", op: "supply_blend", slots: ["venue", "amount"] }, rows, NOW, ["supply xlm from my margin account"]);
    expect(fromAccount?.steps.find((step) => step.slot === "venue")?.options.map((option) => option.label)).toEqual([
      "Farm · Blend", "Aquarius XLM/AQUSDC pool", "Soroswap XLM/SOUSDC pool",
    ]);
    const blendOnly = buildQuestionnaire({ asset: "XLM", op: "supply_blend", slots: ["venue", "amount"] }, rows, NOW, ["supply xlm to blend"]);
    expect(blendOnly?.steps.find((step) => step.slot === "venue")?.options.map((option) => option.label)).toEqual(["Farm · Blend"]);

    const message = "swap xlm to aqusdc";
    const built = buildQuestionnaireSet([
      { op: "swap", asset: "XLM", slots: ["amount"], sourceQuote: message },
    ], rows, NOW, [message])!;
    const answers: QuestionnaireAnswers = {
      questionnaireId: built.id, asset: "XLM", venue: "swap:XLM",
      amount: { kind: "literal", amount: "5" }, summary: "swap 5 xlm to SOUSDC",
      sections: [{ sectionId: built.sections![0].id, asset: "XLM", venue: "swap:XLM", amount: { kind: "literal", amount: "5" } }],
    };
    expect(actionsFromAnswers(built, answers)[0].assetOut).toBe("AQUSDC");
  });

  it("runs a typed lend and an answered deposit in the user's order", () => {
    const message = "lend 20 blusdc and deposit xlm";
    const built = buildQuestionnaireSet([
      { op: "deposit_collateral", asset: "XLM", slots: ["amount"], sourceQuote: "deposit xlm" },
    ], rows, NOW, [message], [
      { op: "lend", asset: "BLUSDC", sizing: { kind: "literal", amount: "20", sourceQuote: "lend 20 blusdc" }, sourceQuote: "lend 20 blusdc" },
    ])!;
    expect(built.sections).toHaveLength(1);
    expect(built.sections?.[0].title).toBe("Deposit XLM");
    const answers: QuestionnaireAnswers = {
      questionnaireId: built.id, asset: "XLM", venue: null, amount: { kind: "literal", amount: "15" }, summary: "lend 20 blusdc and deposit 15 xlm",
      sections: [{ sectionId: built.sections![0].id, asset: "XLM", venue: "deposit_collateral:XLM", amount: { kind: "literal", amount: "15" } }],
    };
    const actions = actionsFromAnswers(built, answers);
    expect(actions.map((action) => [action.op, action.asset, action.sizing.kind === "literal" ? action.sizing.amount : action.sizing.kind])).toEqual([
      ["lend", "BLUSDC", "20"],
      ["deposit_collateral", "XLM", "15"],
    ]);
  });

  it("reads a BLUSDC account row spelled USDC when projecting the Blend max", () => {
    const message = "deposit blusdc and supply it to blend";
    const built = buildQuestionnaireSet([
      { op: "deposit_collateral", asset: "BLUSDC", slots: ["amount"], sourceQuote: "deposit blusdc" },
      { op: "supply_blend", asset: "BLUSDC", slots: ["amount"], sourceQuote: "supply it to blend" },
    ], [
      wallet([{ symbol: "BLUSDC", balance: "400" }]),
      account([{ symbol: "USDC", balance: "50" }]),
      ...prices, blend, earn,
    ], NOW, [message])!;
    const blendMax = Object.values(built.sections![1].steps.find((step) => step.slot === "amount")?.max ?? {})[0];
    expect(blendMax?.amount).toBe("450");
  });

  it("still parses a single-object missing on a clarify decision and parses stated actions", () => {
    const decision = parseDecision({
      kind: "clarify", question: "How much?",
      missing: { op: "lend", asset: "XLM", slots: ["amount"] },
      actions: [
        { op: "lend", asset: "BLUSDC", sizing: { kind: "literal", amount: "20", sourceQuote: "lend 20 blusdc" }, sourceQuote: "lend 20 blusdc" },
      ],
      trigger: { kind: "future_condition", sourceQuote: "when XLM reaches 0.30" },
    });
    expect(decision?.kind).toBe("clarify");
    if (decision?.kind === "clarify") {
      expect(decision.missing).toEqual([{ op: "lend", asset: "XLM", slots: ["amount"] }]);
      expect(decision.actions).toHaveLength(1);
      expect(decision.actions?.[0].asset).toBe("BLUSDC");
      expect(decision.trigger).toEqual({ kind: "future_condition", sourceQuote: "when XLM reaches 0.30" });
    }
  });

  it("sets sourceSectionId and bound=upper on linked options and fixes empty max on lend xlm and deposit xlm", () => {
    const message = "lend xlm and deposit xlm";
    const built = buildQuestionnaireSet([
      { op: "lend", asset: "XLM", slots: ["amount"], sourceQuote: "lend xlm" },
      { op: "deposit_collateral", asset: "XLM", slots: ["amount"], sourceQuote: "deposit xlm" },
    ], rows, NOW, [message])!;
    expect(built.sections).toHaveLength(2);
    const depositStep = built.sections![1].steps.find((step) => step.slot === "amount");
    expect(depositStep?.max).toBeDefined();
    expect(Object.keys(depositStep?.max ?? {})).not.toHaveLength(0);
    const depMax = Object.values(depositStep?.max ?? {})[0];
    expect(depMax.amount).toBe("1000");
    expect(depMax.bound).toBe("upper");

    // Check linked option carries sourceSectionId
    const depThenBlend = "deposit xlm and supply xlm to blend";
    const linkedBuilt = buildQuestionnaireSet([
      { op: "deposit_collateral", asset: "XLM", slots: ["amount"], sourceQuote: "deposit xlm" },
      { op: "supply_blend", asset: "XLM", slots: ["amount"], sourceQuote: "supply xlm to blend" },
    ], rows, NOW, [depThenBlend])!;
    const blendAmt = linkedBuilt.sections![1].steps.find((step) => step.slot === "amount");
    const linkOpt = blendAmt?.options.find((opt) => opt.id.startsWith("previous:"));
    expect(linkOpt?.sourceSectionId).toBe(linkedBuilt.sections![0].id);
  });

  it("supply xlm to margin names account pocket and offers Blend plus the two LP pools (no Earn)", () => {
    const qn = buildQuestionnaire({ asset: "XLM", op: "supply_blend", slots: ["venue", "amount"] }, rows, NOW, ["supply xlm to margin"]);
    const venues = qn?.steps.find((step) => step.slot === "venue")?.options.map((option) => option.label);
    expect(venues).toEqual([
      "Farm · Blend", "Aquarius XLM/AQUSDC pool", "Soroswap XLM/SOUSDC pool",
    ]);
  });

  it("answerProblem re-validates against running pocket and rejects deposit 10 then Blend 1100", () => {
    const message = "deposit xlm and supply xlm to blend";
    const built = buildQuestionnaireSet([
      { op: "deposit_collateral", asset: "XLM", slots: ["amount"], sourceQuote: "deposit xlm" },
      { op: "supply_blend", asset: "XLM", slots: ["amount"], sourceQuote: "supply xlm to blend" },
    ], rows, NOW, [message])!;

    // 1. Missing or duplicate sections
    const badAnswers: QuestionnaireAnswers = {
      questionnaireId: built.id, asset: "XLM", venue: null, amount: { kind: "literal", amount: "10" }, summary: "deposit 10",
      sections: [
        { sectionId: built.sections![0].id, asset: "XLM", venue: "deposit_collateral:XLM", amount: { kind: "literal", amount: "10" } },
      ],
    };
    expect(answerProblem(built, badAnswers)).toBe("Answer each section once.");

    // 2. Deposit 10 then Blend 1101 -> fails: the account has 100 + 10 = 110 and the wallet top-up
    // (owner, 24 Sep) covers only the 990 the deposit left in it, 1100 in all.
    const overAnswers: QuestionnaireAnswers = {
      questionnaireId: built.id, asset: "XLM", venue: null, amount: { kind: "literal", amount: "10" }, summary: "deposit 10 and supply 1101 to blend",
      sections: [
        { sectionId: built.sections![0].id, asset: "XLM", venue: "deposit_collateral:XLM", amount: { kind: "literal", amount: "10" } },
        { sectionId: built.sections![1].id, asset: "XLM", venue: "supply_blend:XLM", amount: { kind: "literal", amount: "1101" } },
      ],
    };
    expect(answerProblem(built, overAnswers)).toBe("That is more than the 1100 XLM available.");
    const toppedUp = { ...overAnswers, sections: [overAnswers.sections![0], { ...overAnswers.sections![1], amount: { kind: "literal" as const, amount: "1100" } }] };
    expect(answerProblem(built, toppedUp)).toBeNull();

    // 3. Deposit 10 then Blend 50 -> succeeds (50 <= 110)
    const goodAnswers: QuestionnaireAnswers = {
      questionnaireId: built.id, asset: "XLM", venue: null, amount: { kind: "literal", amount: "10" }, summary: "deposit 10 and supply 50 to blend",
      sections: [
        { sectionId: built.sections![0].id, asset: "XLM", venue: "deposit_collateral:XLM", amount: { kind: "literal", amount: "10" } },
        { sectionId: built.sections![1].id, asset: "XLM", venue: "supply_blend:XLM", amount: { kind: "literal", amount: "50" } },
      ],
    };
    expect(answerProblem(built, goodAnswers)).toBeNull();

    // 4. Deposit 10 then Blend previous_leg -> succeeds (takes 10 <= 110)
    const prevAnswers: QuestionnaireAnswers = {
      questionnaireId: built.id, asset: "XLM", venue: null, amount: { kind: "previous_leg" }, summary: "deposit 10 and supply all to blend",
      sections: [
        { sectionId: built.sections![0].id, asset: "XLM", venue: "deposit_collateral:XLM", amount: { kind: "literal", amount: "10" } },
        { sectionId: built.sections![1].id, asset: "XLM", venue: "supply_blend:XLM", amount: { kind: "previous_leg" } },
      ],
    };
    expect(answerProblem(built, prevAnswers)).toBeNull();
  });

  it("handles shortfall funding with unsized earlier legs across all 4 kinds", () => {
    const ctx = {
      scope: {
        subject: "user", network: "testnet",
        trader: "GBH5G2WPAAFZ5MS76GDJ4HKHYXSRGF2MBLYDIRQOHGVS4HPU6NNOFIHA",
        smartAccount: "CCKITLMKA2VKSWGOTFABSUFA3RMOZHRP5YNP6HLG73JSWMMUUNCTHDMC",
      },
      observations: rows, now: NOW, messages: ["test"],
      capacity: { grossCollateralUsd: "1000", debtUsd: "0", floor: "1.1" },
      borrowing: "unspecified" as const, comparisons: [],
    };

    // 1. Earlier leg is all_idle deposit into account, followed by supply_blend
    const idleCtx = { ...ctx, messages: ["deposit all idle and supply 100 to blend"] };
    const allIdlePlan = {
      title: "idle then blend", rationale: "r", evidenceIds: [],
      legs: [
        { op: "deposit_collateral" as const, asset: "XLM", sizing: { kind: "all_idle" as const, sourceQuote: "deposit" } },
        { op: "supply_blend" as const, asset: "XLM", sizing: { kind: "literal" as const, amount: "100", sourceQuote: "100" } },
      ],
    };
    const res1 = resolvePlans([allIdlePlan], idleCtx);
    // supply_blend kept its stated amount 100 without enlarging or adding a second deposit
    expect(res1.candidates[0]?.steps?.filter((s) => s.op === "deposit_collateral")).toHaveLength(1);
    expect(res1.candidates[0]?.steps?.find((s) => s.op === "supply_blend")?.amount).toBe("100");

    // 2. Earlier leg is fraction
    const fractionCtx = { ...ctx, messages: ["deposit 50% and supply 100 to blend"] };
    const fractionPlan = {
      title: "fraction then blend", rationale: "r", evidenceIds: [],
      legs: [
        { op: "deposit_collateral" as const, asset: "XLM", sizing: { kind: "fraction" as const, percent: "50", of: "idle" as const, sourceQuote: "50%" } },
        { op: "supply_blend" as const, asset: "XLM", sizing: { kind: "literal" as const, amount: "100", sourceQuote: "100" } },
      ],
    };
    const res2 = resolvePlans([fractionPlan], fractionCtx);
    expect(res2.candidates[0]?.steps?.filter((s) => s.op === "deposit_collateral")).toHaveLength(1);

    // 3. Earlier leg is previous_leg
    const prevCtx = {
      ...ctx,
      capacity: { ...ctx.capacity, floor: "1.2" },
      borrowing: "allowed" as const,
      comparisons: [{
        asset: "XLM" as const,
        earnSupplyApr: null,
        blendSupplyApr: "12",
        marginBorrowApr: "4",
        spreadApr: "8",
        verdict: "positive_before_costs" as const,
        evidenceIds: [],
      }],
      messages: ["borrow 50 and supply to blend"],
    };
    const prevPlan = {
      title: "borrow then blend", rationale: "r", evidenceIds: [],
      legs: [
        { op: "borrow" as const, asset: "XLM", sizing: { kind: "literal" as const, amount: "50", sourceQuote: "50" } },
        { op: "supply_blend" as const, asset: "XLM", sizing: { kind: "previous_leg" as const } },
      ],
    };
    const res3 = resolvePlans([prevPlan], prevCtx);
    expect(res3.candidates[0]?.steps?.find((s) => s.op === "supply_blend")?.amount).toBe("50");

    // 4. Earlier leg is swap into the asset (unsized amount) -> rejects cleanly
    const swapCtx = { ...ctx, messages: ["swap 50 blusdc to xlm and supply 100 to blend"] };
    const swapPlan = {
      title: "swap then blend", rationale: "r", evidenceIds: [],
      legs: [
        { op: "swap" as const, asset: "BLUSDC", assetOut: "XLM", sizing: { kind: "literal" as const, amount: "50", sourceQuote: "50" } },
        { op: "supply_blend" as const, asset: "XLM", sizing: { kind: "literal" as const, amount: "100", sourceQuote: "100" } },
      ],
    };
    const res4 = resolvePlans([swapPlan], swapCtx);
    expect(res4.rejected[0]?.reason).toMatch(/swap fills at the pool's price/);
  });

  it("keys running pocket to the chosen venue option when multiple venue options are offered", () => {
    // "supply blusdc" offers both Earn and Blend as venues
    const built = buildQuestionnaireSet([
      { asset: "BLUSDC", slots: ["venue", "amount"], sourceQuote: "supply blusdc" },
    ], rows, NOW, ["supply blusdc"])!;

    const venueStep = built.steps.find((s) => s.slot === "venue");
    expect(venueStep?.options.length).toBeGreaterThan(1);
    const firstOption = venueStep!.options[0]; // e.g. lend:BLUSDC
    const secondOption = venueStep!.options[1]; // e.g. supply_blend:BLUSDC

    // Picking secondOption (Blend) keys to account (which has 0 BLUSDC)
    const blendAnswers: QuestionnaireAnswers = {
      questionnaireId: built.id,
      asset: "BLUSDC",
      venue: secondOption.id,
      amount: { kind: "literal", amount: "50" },
      summary: "supply 50 blusdc to blend",
      sections: [
        {
          sectionId: built.sections![0].id,
          asset: "BLUSDC",
          venue: secondOption.id,
          amount: { kind: "literal", amount: "50" },
        },
      ],
    };
    // The account holds none, so the plan deposits it from the wallet first (owner, 24 Sep):
    // 25 Sep live, this refusal ended "supply my usdc" with no transaction.
    expect(answerProblem(built, blendAnswers)).toBeNull();
    const beyond = { ...blendAnswers, sections: [{ ...blendAnswers.sections![0], amount: { kind: "literal" as const, amount: "401" } }] };
    expect(answerProblem(built, beyond)).toBe("That is more than the 400 BLUSDC available.");

    // Picking firstOption (Earn) keys to wallet (which has 400 BLUSDC) and succeeds
    const earnAnswers: QuestionnaireAnswers = {
      questionnaireId: built.id,
      asset: "BLUSDC",
      venue: firstOption.id,
      amount: { kind: "literal", amount: "50" },
      summary: "lend 50 blusdc to earn",
      sections: [
        {
          sectionId: built.sections![0].id,
          asset: "BLUSDC",
          venue: firstOption.id,
          amount: { kind: "literal", amount: "50" },
        },
      ],
    };
    expect(answerProblem(built, earnAnswers)).toBeNull();
    const actions = actionsFromAnswers(built, earnAnswers);
    expect(actions[0].op).toBe(firstOption.op);
  });

  it("resolves fraction answers against pocket balance and feeds subsequent steps", () => {
    const built = buildQuestionnaireSet([
      { op: "deposit_collateral", asset: "XLM", slots: ["amount"], sourceQuote: "deposit xlm" },
      { op: "supply_blend", asset: "XLM", slots: ["amount"], sourceQuote: "supply to blend" },
    ], rows, NOW, ["deposit xlm and supply to blend"])!;
    expect(built.sections).toHaveLength(2);

    const validAnswers: QuestionnaireAnswers = {
      questionnaireId: built.id,
      asset: "XLM",
      venue: null,
      amount: { kind: "fraction", percent: "100" },
      summary: "Deposit 100%, then Blend 1000",
      sections: [
        {
          sectionId: built.sections![0].id,
          asset: "XLM",
          venue: null,
          amount: { kind: "fraction", percent: "100" },
        },
        {
          sectionId: built.sections![1].id,
          asset: "XLM",
          venue: null,
          amount: { kind: "literal", amount: "1000" },
        },
      ],
    };
    expect(answerProblem(built, validAnswers)).toBeNull();

    const overspendAnswers: QuestionnaireAnswers = {
      ...validAnswers,
      sections: [
        {
          sectionId: built.sections![0].id,
          asset: "XLM",
          venue: null,
          amount: { kind: "fraction", percent: "100" },
        },
        {
          sectionId: built.sections![1].id,
          asset: "XLM",
          venue: null,
          amount: { kind: "literal", amount: "1101" },
        },
      ],
    };
    expect(answerProblem(built, overspendAnswers)).toBe("That is more than the 1100 XLM available.");
  });
});

