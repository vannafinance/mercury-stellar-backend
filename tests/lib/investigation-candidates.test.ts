import { describe, expect, it } from "vitest";
import { generateCandidates, mergeCandidateSets, spendableWalletUsdFrom, plansBorrow, rankFeasible, rankingBorrowing, requestedBorrowFrom, statedBorrowFrom } from "@/lib/copilot/investigation/candidates";
import { candidateId } from "@/lib/copilot/investigation/candidate-id";
import type { RateComparison } from "@/lib/copilot/investigation/rate-comparison";

/**
 * Deterministic candidate generation.
 *
 * The model proposes nothing here: given rate evidence and the authoritative position,
 * the shapes are enumerable and every amount comes from the sizer. What these tests pin
 * are the two judgements the plan requires and that prose alone would not enforce -
 * the generator volunteers nothing that moves the user's wallet (that is a plan the model
 * composes for what they asked), and a negative carry is REJECTED with its reason unless the
 * user required that borrow.
 */

// The live authorised account as dev computes it.
const BASE = { grossCollateralUsd: "4219.36", debtUsd: "1736.19", floor: "1.30" };

function comparison(over: Partial<RateComparison> = {}): RateComparison {
  return {
    asset: "BLUSDC",
    earnSupplyApr: "25.41",
    blendSupplyApr: "10",
    marginBorrowApr: "4",
    spreadApr: "6",
    verdict: "positive_before_costs",
    evidenceIds: ["e1", "e2"],
    ...over,
  };
}

describe("candidate generation", () => {
  it("carries verified borrow refusal figures through the research candidate merge", () => {
    const borrowLimit = { asset: "XLM", requestedAmount: "20000", maximumAmount: "9000", evidenceId: "e20", readAt: 1 };
    const merged = mergeCandidateSets(null, { candidates: [], rejected: [
      { title: "Borrow", leg: "borrow XLM", reason: "Protocol ceiling exceeded", borrowLimit },
    ] });
    expect(merged.feasible).toEqual([]);
    expect(merged.rejected[0]).toMatchObject({ asset: "XLM", borrowLimit });
  });
  it("offers nothing from the wallet, however much is held: moving the user's tokens is never volunteered", () => {
    const { feasible } = generateCandidates({ ...BASE, spendableWalletUsd: "500",
      spendableWalletByAssetUsd: { XLM: "20", BLUSDC: "480" }, spendableWalletByAssetTokens: { XLM: "100", BLUSDC: "480" },
      borrowingAllowed: false, comparisons: [comparison({ asset: "XLM" }), comparison()] });
    expect(feasible).toEqual([]);
  });
  it("sizes a borrow-and-supply candidate to the floor and reports its net carry", () => {
    const { feasible, rejected } = generateCandidates({
      ...BASE, spendableWalletUsd: null, comparisons: [comparison()],
    });

    expect(rejected).toEqual([]);
    expect(feasible).toHaveLength(1);
    expect(feasible[0]).toMatchObject({
      id: candidateId("borrow_supply", "BLUSDC"),
      kind: "borrow_supply",
      borrows: true,
      netAprPct: "6",
      /**
       * A derived max is sized one basis point INSIDE the floor
       * (`FLOOR_MARGIN_BPS` in sizing.ts), so this lands just above 1.3 rather
       * than exactly on it - the fix for a plan built to the floor being
       * refused by that same floor the moment anything moved before the write.
       * Captured from the actual sizer output, not hand-computed.
       */
      amountUsd: "6537.458085829473894645",
      // Lands ON the margined target (1.3 + 1bps), the same way a max always lands
      // exactly on whatever floor it was sized against.
      finalHealthFactor: "1.30013",
      evidenceIds: ["e1", "e2"],
      amountBasis: "derived_max_at_floor",
    });
    // The projection comes from the borrow leg; supplying is health-factor neutral.
    expect(feasible[0].legs).toHaveLength(1);
    expect(feasible[0].legs[0].op).toBe("borrow");
  });

  it("rejects a negative carry instead of ranking it", () => {
    const { feasible, rejected } = generateCandidates({
      ...BASE, spendableWalletUsd: null,
      comparisons: [comparison({ blendSupplyApr: "3", marginBorrowApr: "7", spreadApr: "-4", verdict: "cost_exceeds_supply" })],
    });

    expect(feasible).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/loses money/);
    expect(rejected[0].reason).toMatch(/7%/);
    expect(rejected[0].reason).toMatch(/3%/);
  });

  it("rejects an exactly-break-even carry, which is not a strategy", () => {
    const { feasible, rejected } = generateCandidates({
      ...BASE, spendableWalletUsd: null,
      comparisons: [comparison({ blendSupplyApr: "5", marginBorrowApr: "5", spreadApr: "0", verdict: "no_spread" })],
    });
    expect(feasible).toEqual([]);
    expect(rejected[0].reason).toMatch(/loses money|did not support/);
  });

  it("with a wallet balance and borrowing allowed, offers only the borrow shape, never a wallet one", () => {
    const { feasible } = generateCandidates({
      ...BASE, spendableWalletUsd: "680", spendableWalletByAssetUsd: { BLUSDC: "680" }, comparisons: [comparison()],
    });
    expect(feasible).toHaveLength(1);
    expect(feasible[0]).toMatchObject({ id: candidateId("borrow_supply", "BLUSDC"), borrows: true });
  });


  it("still sizes a required borrow when carry is negative", () => {
    const { feasible, rejected } = generateCandidates({
      ...BASE, spendableWalletUsd: "680", spendableWalletByAssetUsd: { BLUSDC: "680" }, borrowing: "required",
      comparisons: [comparison({ blendSupplyApr: "2", marginBorrowApr: "9", verdict: "cost_exceeds_supply" })],
    });
    expect(feasible.some((candidate) => candidate.borrows)).toBe(true);
    expect(rejected).toEqual([]);
  });

  it("rejects a required borrow with no headroom as a deposit suggestion, not an idle substitute", () => {
    const { feasible, rejected } = generateCandidates({
      grossCollateralUsd: "1300", debtUsd: "1000", floor: "1.30",
      spendableWalletUsd: "680", spendableWalletByAssetUsd: { BLUSDC: "680" }, borrowing: "required",
      comparisons: [comparison()],
    });
    expect(feasible).toEqual([]);
    expect(rejected[0]).toMatchObject({ acceptable: true });
    expect(rejected[0].reason).toMatch(/Deposit or transfer/);
  });

  it("treats a typed borrow leg as required even when the goal said allowed", () => {
    expect(rankingBorrowing("allowed", [{ op: "borrow" }])).toBe("required");
    // Owner, 24 Sep: a borrow the MODEL proposed is a suggestion, not an instruction, so the
    // no-debt options stay listed; its sizing still reads the capacity (plansBorrow).
    expect(rankingBorrowing("unspecified", null)).toBe("unspecified");
    expect(plansBorrow([{ legs: [{ op: "borrow" }] }])).toBe(true);
    expect(plansBorrow([{ legs: [{ op: "lend" }] }])).toBe(false);
    expect(rankingBorrowing("forbidden", [{ op: "borrow" }])).toBe("forbidden");
    expect(rankingBorrowing("allowed", [{ op: "lend" }])).toBe("allowed");
  });



  it("never borrows in order to lend to Earn", () => {
    const { feasible } = generateCandidates({
      ...BASE, spendableWalletUsd: null, comparisons: [comparison()],
    });
    expect(feasible.some((candidate) => candidate.venue === "earn")).toBe(false);
    expect(feasible.every((candidate) => candidate.kind === "borrow_supply")).toBe(true);
  });


  it("reports no headroom as a reason rather than an empty result", () => {
    const { feasible, rejected } = generateCandidates({
      // Already exactly at the 1.30 floor, so there is nothing to borrow.
      grossCollateralUsd: "1300", debtUsd: "1000", floor: "1.30",
      spendableWalletUsd: null, comparisons: [comparison()],
    });
    expect(feasible).toEqual([]);
    expect(rejected[0].reason).toMatch(/No borrowing headroom/);
  });

  it("refuses a floor at or under the liquidation threshold", () => {
    const { feasible, rejected } = generateCandidates({
      ...BASE, floor: "1.1", spendableWalletUsd: null, comparisons: [comparison()],
    });
    expect(feasible).toEqual([]);
    expect(rejected[0].reason).toMatch(/floor below liquidation threshold/);
  });

  it("ranks the better carry first across assets", () => {
    const { feasible } = generateCandidates({
      ...BASE, spendableWalletUsd: null,
      comparisons: [
        comparison({ asset: "BLUSDC", blendSupplyApr: "6", marginBorrowApr: "4", evidenceIds: ["e1"] }),
        comparison({ asset: "XLM", blendSupplyApr: "20", marginBorrowApr: "4", evidenceIds: ["e2"] }),
      ],
    });

    expect(feasible.map((candidate) => candidate.asset)).toEqual(["XLM", "BLUSDC"]);
    expect(feasible[0].netAprPct).toBe("16");
  });

  it("keeps a rejected asset out of the ranking while still sizing the viable one", () => {
    const { feasible, rejected } = generateCandidates({
      ...BASE, spendableWalletUsd: null,
      comparisons: [
        comparison({ asset: "BLUSDC", blendSupplyApr: "2", marginBorrowApr: "9", verdict: "cost_exceeds_supply" }),
        comparison({ asset: "XLM", blendSupplyApr: "12", marginBorrowApr: "4" }),
      ],
    });

    expect(feasible.map((candidate) => candidate.asset)).toEqual(["XLM"]);
    expect(rejected.map((entry) => entry.asset)).toEqual(["BLUSDC"]);
  });

  it("does not treat unspecified borrowing as a prohibition when a floor exists", () => {
    const unspecified = generateCandidates({
      ...BASE, spendableWalletUsd: null, comparisons: [comparison()],
    });
    const forbidden = generateCandidates({
      ...BASE, spendableWalletUsd: "100", spendableWalletByAssetUsd: { BLUSDC: "100" },
      borrowingAllowed: false, comparisons: [comparison()],
    });
    expect(unspecified.feasible.some((candidate) => candidate.borrows)).toBe(true);
    expect(forbidden.feasible.every((candidate) => !candidate.borrows)).toBe(true);
  });

  it("never proposes an LP shape, whose collateral value is not validated", () => {
    const { feasible } = generateCandidates({
      ...BASE, spendableWalletUsd: "500", comparisons: [comparison()],
    });
    expect(feasible.every((candidate) => candidate.venue === "blend" || candidate.venue === "earn")).toBe(true);
    expect(feasible.every((candidate) => !/lp|aquarius|soroswap/i.test(candidate.id + candidate.label))).toBe(true);
  });
});

describe("idle wallet valuation", () => {
  const observation = (over: Record<string, unknown>) => ({
    id: "e1", capability: "wallet_balances", args: {}, observedAt: 1_000,
    status: "ok" as const, ...over,
  });
  const price = (asset: string, price_usd: string, id = "e2") => observation({
    id, capability: "asset_price", args: { asset }, data: { price_usd },
  });
  const wallet = (assets: unknown[]) => observation({ data: { assets } });

  it("values only the symbols whose price was actually read", () => {
    // XLM is priced; SOUSDC is not, so it contributes nothing rather than a guessed $1.
    const total = spendableWalletUsdFrom([
      wallet([{ symbol: "XLM", balance: "100" }, { symbol: "SOUSDC", balance: "24948" }]),
      price("XLM", "0.2"),
    ], 1_000);
    expect(total).toBe("20");
  });

  it("returns null when nothing could be priced, rather than zero", () => {
    // Zero would read as "you have nothing idle", which is a different claim from
    // "the price needed to value it was never read".
    expect(spendableWalletUsdFrom([wallet([{ symbol: "XLM", balance: "100" }])], 1_000)).toBeNull();
    expect(spendableWalletUsdFrom([price("XLM", "0.2")], 1_000)).toBeNull();
  });

  it("counts a holding once, not twice via its _SAC alias", () => {
    const total = spendableWalletUsdFrom([
      wallet([{ symbol: "XLM", balance: "100" }, { symbol: "XLM_SAC", balance: "100" }]),
      price("XLM", "0.2"),
    ], 1_000);
    expect(total).toBe("20");
  });

  it("ignores stale reads and a zero or unparseable price", () => {
    const stale = [wallet([{ symbol: "XLM", balance: "100" }]), price("XLM", "0.2")]
      .map((entry) => ({ ...entry, observedAt: 0 }));
    expect(spendableWalletUsdFrom(stale, 5_000_000)).toBeNull();
    expect(spendableWalletUsdFrom([
      wallet([{ symbol: "XLM", balance: "100" }]), price("XLM", "0"),
    ], 1_000)).toBeNull();
  });

  it("skips a failed wallet read instead of valuing a partial list", () => {
    expect(spendableWalletUsdFrom([
      { ...wallet([{ symbol: "XLM", balance: "100" }]), status: "error" as const },
      price("XLM", "0.2"),
    ], 1_000)).toBeNull();
  });
});

/**
 * "Borrow this exact amount" is a third case alongside "you may borrow" and "do not
 * borrow", and the one most easily got wrong: sizing to the floor turns a request for
 * $500 into a proposal for $6,541.
 */
describe("an amount the user named outright", () => {
  it("sizes the candidate to the stated amount, not to the floor", () => {
    const { feasible } = generateCandidates({
      ...BASE, spendableWalletUsd: null, requestedBorrowUsd: "500", comparisons: [comparison()],
    });
    expect(feasible).toHaveLength(1);
    expect(feasible[0].amountUsd).toBe("500");
    expect(feasible[0].label).toMatch(/Borrow 500 USD of BLUSDC/);
    // Health factor lands wherever $500 puts it - not on the floor.
    expect(Number(feasible[0].finalHealthFactor)).toBeGreaterThan(1.3);
  });

  it("refuses an amount that breaches the floor and names the amount that fits", () => {
    const { feasible, rejected } = generateCandidates({
      ...BASE, spendableWalletUsd: null, requestedBorrowUsd: "50000", comparisons: [comparison()],
    });
    expect(feasible).toEqual([]);
    expect(rejected[0].reason).toMatch(/would take the health factor below your 1.30 floor/);
    // The figure that WOULD fit is offered as information, never substituted silently.
    // Same margined max as the sizing test above - both paths go through `sizeLegs`.
    expect(rejected[0].reason).toMatch(/At most 6537\.458085829473894645 USD fits/);
  });

  it("does not report a floor breach when the amount was simply unusable", () => {
    const { rejected } = generateCandidates({
      ...BASE, spendableWalletUsd: null, requestedBorrowUsd: "not-a-number", comparisons: [comparison()],
    });
    // The floor may be named as context, but a breach must not be asserted, and no
    // "at most N fits" figure may be quoted off the back of an amount nothing could read.
    expect(rejected[0].reason).not.toMatch(/would take the health factor below/);
    expect(rejected[0].reason).not.toMatch(/At most/);
    expect(rejected[0].reason).toMatch(/invalid leg amount/);
  });



});

describe("valuing an amount the user named", () => {
  const observation = (over: Record<string, unknown>) => ({
    id: "e1", capability: "asset_price", args: {}, observedAt: 1_000, status: "ok" as const, ...over,
  });
  const price = (asset: string, price_usd: string) => observation({ args: { asset }, data: { price_usd } });
  // The model reports each stated write as a leg whose literal sizing quotes the user's own words.
  const borrow = (asset: string, amount: string, sourceQuote: string) =>
    ({ op: "borrow", asset, sizing: { kind: "literal", amount, sourceQuote } });

  it("converts the stated token amount with a price read this turn", () => {
    expect(requestedBorrowFrom(statedBorrowFrom([borrow("XLM", "500", "borrow 500 XLM")]), [price("XLM", "0.2")], 1_000))
      .toEqual({ asset: "XLM", tokens: 500, usd: "100" });
  });

  it("reports the request as unvalued rather than assuming a stable is worth a dollar", () => {
    // No BLUSDC price was read. A $1 assumption would flow into the floor check.
    expect(requestedBorrowFrom(statedBorrowFrom([borrow("BLUSDC", "500", "borrow 500 BLUSDC")]), [price("XLM", "0.2")], 1_000))
      .toEqual({ asset: "BLUSDC", tokens: 500, usd: null });
  });

  it("takes the latest stated amount, and returns nothing when none was stated", () => {
    const legs = [borrow("XLM", "500", "borrow 500 XLM"), borrow("XLM", "200", "actually borrow 200 XLM")];
    expect(requestedBorrowFrom(statedBorrowFrom(legs), [price("XLM", "0.2")], 1_000)?.tokens).toBe(200);
    expect(requestedBorrowFrom(statedBorrowFrom([]), [price("XLM", "0.2")], 1_000)).toBeNull();
  });

  it("does not value a request from a stale price", () => {
    const stale = [{ ...price("XLM", "0.2"), observedAt: 0 }];
    expect(requestedBorrowFrom(statedBorrowFrom([borrow("XLM", "500", "borrow 500 XLM")]), stale, 5_000_000)?.usd).toBeNull();
  });

  it("reads only the model's literal borrow legs, so the wording alone can never produce an amount", () => {
    expect(statedBorrowFrom([{ op: "borrow", asset: "USDC", sizing: { kind: "to_floor" } }])).toBeNull();
    expect(statedBorrowFrom([{ op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "5", sourceQuote: "lend 5 XLM" } }])).toBeNull();
  });
});
