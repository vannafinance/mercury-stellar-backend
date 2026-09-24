/**
 * A direct action with missing inputs becomes a questionnaire. Options are derived
 * from the registry and the balances that were read.
 */
import { describe, expect, it } from "vitest";
import { parseDecision } from "@/lib/copilot/investigation/decision";
import { planFromStatedActions, resolvePlans } from "@/lib/copilot/investigation/plan";
import { actionFromAnswers, answerProblem, buildQuestionnaire, readsForQuestionnaire, type QuestionnaireMissing } from "@/lib/copilot/investigation/questionnaire";
import type { Observation } from "@/lib/copilot/investigation/types";
import type { QuestionnaireAnswers } from "@/lib/copilot/investigation/view";

const NOW = 1_700_000_000_000;
const obs = (id: string, capability: string, data: Record<string, unknown>, args: Record<string, unknown> = {}): Observation =>
  ({ id, capability, args, observedAt: NOW, status: "ok", data });

const wallet = (rows: Array<{ symbol: string; balance: string }>) =>
  obs("w", "wallet_balances", { assets: rows.map((row) => ({ ...row, decimals: 7, status: "ok" })), fee_reserve_xlm: "0" });
const account = (rows: Array<{ symbol: string; balance: string }>) =>
  obs("a", "account_collateral", { collateral: rows });
const prices = ["XLM", "BLUSDC", "AQUSDC", "SOUSDC"].map((asset) =>
  obs(`p-${asset}`, "asset_price", { price_usd: asset === "XLM" ? "0.2" : "1" }, { asset }));
const earn = (asset: string, rate: string) => obs(`e-${asset}`, "earn_market", { supply_apr_pct: rate }, { asset });
const blend = obs("b", "blend_markets", { reserves: [{ symbol: "XLM", supply_apr_pct: "12" }, { symbol: "USDC", supply_apr_pct: "8" }] });
function pool(asset: string, xlm: string, paired: string, venue: "aquarius" | "soroswap" = "aquarius") {
  return obs(`r-${venue}-${asset}`, venue === "soroswap" ? "soroswap_pool_reserves" : "aquarius_pool_reserves", {
    found: true,
    pool: { available: true, reserves: { XLM: xlm, USDC: paired }, total_share: "100", fee: "0.003", reserves_source: "ledger" },
  }, { asset });
}

const supply: QuestionnaireMissing = { asset: "USDC", slots: ["asset", "venue", "amount"] };

describe("a questionnaire is only for missing inputs", () => {
  it("leaves a plain clarify, and a completed strategy, without one", () => {
    expect(parseDecision({ kind: "clarify", question: "Which asset?" })).toEqual({ kind: "clarify", question: "Which asset?" });
    const completed = parseDecision({
      kind: "research_complete",
      goal: { objective: "compare venues", constraints: [], borrowing: "unspecified", intent: "strategy" },
      findings: [{ summary: "noted", evidenceIds: [] }],
      openQuestions: [],
    });
    expect(completed?.kind).toBe("research_complete");
  });
});

describe("questionnaire options come from what is held", () => {
  it("offers only the USDC variants the balances name", () => {
    const built = buildQuestionnaire(supply, [
      wallet([{ symbol: "BLUSDC", balance: "680" }, { symbol: "AQUSDC", balance: "10" }, { symbol: "XLM", balance: "50" }]),
      account([{ symbol: "BLUSDC", balance: "4" }, { symbol: "AQUSDC", balance: "3" }]),
      ...prices, earn("BLUSDC", "5"), earn("AQUSDC", "4"), blend,
    ], NOW);
    expect(built?.steps.find((step) => step.slot === "asset")?.options.map((option) => option.id).sort()).toEqual(["AQUSDC", "BLUSDC"]);
  });

  it("offers Earn and Blend for BLUSDC, and Earn plus the Aquarius pool for AQUSDC", () => {
    const built = buildQuestionnaire(supply, [
      wallet([{ symbol: "BLUSDC", balance: "680" }, { symbol: "AQUSDC", balance: "10" }]),
      account([{ symbol: "BLUSDC", balance: "4" }, { symbol: "AQUSDC", balance: "3" }, { symbol: "XLM", balance: "20" }]),
      ...prices, earn("BLUSDC", "5"), earn("AQUSDC", "4"), blend,
      pool("AQUSDC", "1000", "200"),
    ], NOW);
    const venues = (asset: string) => built?.steps.find((step) => step.slot === "venue")?.options.filter((option) => option.forAsset === asset).map((option) => option.label);
    expect(venues("BLUSDC")).toEqual(["Earn", "Farm · Blend"]);
    expect(venues("AQUSDC")).toEqual(["Earn", "Aquarius XLM/AQUSDC pool"]);
    const aquarius = built?.steps.find((step) => step.slot === "venue")?.options.find((option) => option.forAsset === "AQUSDC" && option.op === "add_liquidity");
    expect(aquarius?.detail).toContain("pairs with XLM");
    expect(aquarius?.detail).toContain("20 XLM");
  });

  it("derives four venues for XLM, and drops a pool the registry does not list", async () => {
    const rows = [
      wallet([{ symbol: "XLM", balance: "50" }]),
      account([{ symbol: "XLM", balance: "40" }]),
      ...prices, earn("XLM", "3"), blend,
      pool("AQUSDC", "1000", "200"),
      pool("SOUSDC", "800", "100", "soroswap"),
    ];
    const full = buildQuestionnaire({ asset: "XLM", slots: ["venue", "amount"] }, rows, NOW);
    expect(full?.steps.find((step) => step.slot === "venue")?.options.map((option) => option.label)).toEqual([
      "Earn", "Farm · Blend", "Aquarius XLM/AQUSDC pool", "Soroswap XLM/SOUSDC pool",
    ]);
    const { lpPairs } = await import("@/lib/copilot/registry/assets");
    const withoutSoroswap = lpPairs().filter((pair) => pair.venue !== "soroswap");
    expect(withoutSoroswap.every((pair) => pair.venue !== "soroswap")).toBe(true);
    expect(full?.steps.find((step) => step.slot === "venue")?.options.some((option) => option.id === "add_liquidity:soroswap")).toBe(true);
  });

  it("caps an LP amount by the other token when reserves were read", () => {
    const built = buildQuestionnaire({ asset: "AQUSDC", op: "add_liquidity", slots: ["amount"] }, [
      account([{ symbol: "AQUSDC", balance: "100" }, { symbol: "XLM", balance: "10" }]),
      pool("AQUSDC", "1000", "200"),
    ], NOW);
    const cap = built?.steps.find((step) => step.slot === "amount")?.max?.["add_liquidity:aquarius"];
    // 1000 XLM / 200 AQUSDC = 5 XLM per AQUSDC. 10 XLM covers 2 AQUSDC, which is below the 100 held.
    expect(cap?.amount).toBe("2");
  });

  it("asks only for reads that are not already fresh", () => {
    const fresh = wallet([{ symbol: "BLUSDC", balance: "1" }]);
    const reads = readsForQuestionnaire(supply, [fresh], NOW);
    expect(reads.some((read) => read.capability === "wallet_balances")).toBe(false);
    expect(reads.filter((read) => read.capability === "earn_market").map((read) => read.args.asset).sort()).toEqual(["AQUSDC", "BLUSDC", "SOUSDC"]);
    expect(new Set(reads.map((read) => `${read.capability}:${read.args.asset ?? ""}`)).size).toBe(reads.length);
  });
});

describe("an answer is checked against the questionnaire that was issued", () => {
  const built = () => buildQuestionnaire({ asset: "BLUSDC", op: "lend", slots: ["amount"] }, [
    wallet([{ symbol: "BLUSDC", balance: "680" }]),
    earn("BLUSDC", "5"),
  ], NOW)!;

  it("refuses a forged venue and an amount over the max", () => {
    const issued = built();
    const over: QuestionnaireAnswers = {
      questionnaireId: issued.id, asset: "BLUSDC", venue: "lend",
      amount: { kind: "literal", amount: "9999" }, summary: "Lend 9999 BLUSDC",
    };
    expect(answerProblem(issued, over)).toMatch(/more than/);
    expect(answerProblem(issued, { ...over, venue: "not-issued", amount: { kind: "literal", amount: "1" } })).toMatch(/not one of the options/);
  });

  it("sizes the same steps as a typed supply of 50% of BLUSDC to Earn", () => {
    const issued = buildQuestionnaire({ asset: "BLUSDC", slots: ["asset", "venue", "amount"] }, [
      wallet([{ symbol: "BLUSDC", balance: "680" }]),
      ...prices, earn("BLUSDC", "5"),
    ], NOW)!;
    const answers: QuestionnaireAnswers = {
      questionnaireId: issued.id, asset: "BLUSDC", venue: "lend",
      amount: { kind: "fraction", percent: "50" },
      summary: "Supply 50% of my BLUSDC to Earn",
    };
    expect(answerProblem(issued, answers)).toBeNull();
    const fromAnswers = actionFromAnswers(issued, answers);
    const typed = {
      op: "lend" as const, asset: "BLUSDC", sourceQuote: answers.summary,
      sizing: { kind: "fraction" as const, percent: "50", of: "idle" as const, sourceQuote: answers.summary },
    };
    const ctx = {
      scope: { subject: "user", network: "testnet", trader: "G".padEnd(56, "A"), smartAccount: "C".padEnd(56, "A") },
      observations: [wallet([{ symbol: "BLUSDC", balance: "680" }]), ...prices, earn("BLUSDC", "5")],
      now: NOW, messages: [answers.summary],
      capacity: null, borrowing: "allowed" as const, comparisons: [],
    };
    const answered = resolvePlans([planFromStatedActions([fromAnswers], answers.summary)!], ctx);
    const direct = resolvePlans([planFromStatedActions([typed], answers.summary)!], ctx);
    expect(answered.candidates[0]?.steps?.map((step) => [step.op, step.asset, step.amount])).toEqual(
      direct.candidates[0]?.steps?.map((step) => [step.op, step.asset, step.amount]),
    );
    expect(answered.candidates[0]?.steps?.[0]?.amount).toBe("340");
  });
});
