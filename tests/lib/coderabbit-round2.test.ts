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

import { shareSameOpLiteralActions } from "@/lib/copilot/investigation/plan";
import { heldInPocket } from "@/lib/copilot/investigation/questionnaire";

describe("an answer's number never rewrites an earlier stated amount (25 Sep, live)", () => {
  it("lend 2 blusdc stays 2 after the deposit is answered with 3", () => {
    const messages = ["lend 2 blusdc and deposit xlm", "Deposit 3 XLM to Margin account"];
    const out = shareSameOpLiteralActions([
      { op: "lend", asset: "BLUSDC", sizing: { kind: "literal", amount: "2", sourceQuote: "lend 2 blusdc" }, sourceQuote: "lend 2 blusdc" },
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "3", sourceQuote: messages[1] }, sourceQuote: messages[1] },
    ] as never, messages);
    const lend = out.find((a) => a.op === "lend");
    expect(lend?.sizing).toMatchObject({ kind: "literal", amount: "2" });
    expect(out.filter((a) => a.op === "lend")).toHaveLength(1);
  });

  it("a number in the same message is still shared: lend 100 xlm and blusdc", () => {
    const messages = ["lend 100 xlm and blusdc"];
    const out = shareSameOpLiteralActions([
      { op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "100 xlm" }, sourceQuote: "100 xlm" },
    ] as never, messages);
    expect(out.map((a) => a.asset).sort()).toEqual(["BLUSDC", "XLM"]);
  });
});

describe("the wallet cap is what can be sent", () => {
  it("prefers spendable over the raw balance", () => {
    const rows = [{ id: "w", capability: "wallet_balances", args: {}, observedAt: 1, status: "ok",
      data: { assets: [{ symbol: "XLM", balance: "1608.3454972", spendable: "1604.3454972", decimals: 7, status: "ok" }] } }];
    expect(heldInPocket(rows as never, "wallet", "XLM")).toBe("1604.3454972");
  });
});

describe("spendable edge cases", () => {
  it("a zero spendable is zero, not the raw balance", () => {
    const rows = [{ id: "w", capability: "wallet_balances", args: {}, observedAt: 1, status: "ok",
      data: { assets: [{ symbol: "XLM", balance: "1.5", spendable: "0", decimals: 7, status: "ok" }] } }];
    expect(heldInPocket(rows as never, "wallet", "XLM")).toBeNull();
  });
  it("uses the balance when spendable is absent", () => {
    const rows = [{ id: "w", capability: "wallet_balances", args: {}, observedAt: 1, status: "ok",
      data: { assets: [{ symbol: "BLUSDC", balance: "12", decimals: 7, status: "ok" }] } }];
    expect(heldInPocket(rows as never, "wallet", "BLUSDC")).toBe("12");
  });
});

import { missingPositionReads } from "@/lib/copilot/investigation/position-coverage";
import { catalogEntry } from "@/lib/copilot/investigation/catalog";

describe("an answer about positions reads every position pocket (25 Sep, live)", () => {
  it("adds Earn and LP reads for every asset their catalog accepts once any position was read", () => {
    const wanted = missingPositionReads([{ id: "c", capability: "account_collateral", args: {}, observedAt: 1, status: "ok", data: {} }] as never);
    const earn = catalogEntry("earn_position")!.modelArgs.asset as { values: readonly string[] };
    const lp = catalogEntry("farm_lp_position")!.modelArgs.asset as { values: readonly string[] };
    expect(wanted.filter((r) => r.capability === "earn_position").map((r) => r.args.asset)).toEqual([...earn.values]);
    expect(wanted.filter((r) => r.capability === "farm_lp_position").map((r) => r.args.asset)).toEqual([...lp.values]);
    expect(wanted.some((r) => r.capability === "account_collateral")).toBe(false);
  });
  it("adds nothing when no position was read", () => {
    expect(missingPositionReads([{ id: "p", capability: "asset_price", args: { asset: "XLM" }, observedAt: 1, status: "ok", data: {} }] as never)).toEqual([]);
  });
});
