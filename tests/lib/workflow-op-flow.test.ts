/**
 * The op-flow table - one truth for what each op does, shared by the sizer, the reads a
 * plan needs, the risk validator and the prompt. These tests pin the properties the
 * consumers rely on, so a row edit that breaks one of them fails here, by name.
 */

import { describe, expect, it } from "vitest";
import { feeds, OP_FLOW, POCKET_HOLDER, SIZED_OPS, WALLET_OPS, WORKFLOW_OPS } from "@/lib/copilot/workflow/types";
import { TOOLS } from "@/lib/copilot/workflow/allowlist";
import { readsForPlans } from "@/lib/copilot/investigation/strategy-reads";
import { resolvePlans } from "@/lib/copilot/investigation/plan";
import { compareObservedRates } from "@/lib/copilot/investigation/rate-comparison";
import type { Observation, ProposedPlan } from "@/lib/copilot/investigation/types";

describe("OP_FLOW", () => {
  it("has a row for every op, and every row either moves value between pockets or converts the asset in place", () => {
    expect(Object.keys(OP_FLOW).sort()).toEqual([...WORKFLOW_OPS].sort());
    for (const op of WORKFLOW_OPS) {
      // A swap is the one op that ends where it started: it changes the asset, not the pocket.
      if (op === "swap") expect(OP_FLOW[op].from).toBe(OP_FLOW[op].to);
      else expect(OP_FLOW[op].from, op).not.toBe(OP_FLOW[op].to);
    }
  });

  it("derives the wallet ops: the ones whose pockets are all the G-wallet's", () => {
    expect(WALLET_OPS).toEqual(["lend", "redeem"]);
    for (const op of WALLET_OPS) {
      expect(POCKET_HOLDER[OP_FLOW[op].from]).toBe("trader");
      expect(POCKET_HOLDER[OP_FLOW[op].to]).toBe("trader");
    }
  });

  it("derives the sized ops: exactly the ones that move health, which is what the closed-form sizer projects", () => {
    expect([...SIZED_OPS].sort()).toEqual(["borrow", "deposit_collateral", "repay", "withdraw_collateral"]);
    // Health direction follows the pockets: adding to the account raises, taking from it or borrowing lowers.
    expect(OP_FLOW.deposit_collateral.health).toBe("raises");
    expect(OP_FLOW.repay.health).toBe("raises");
    expect(OP_FLOW.borrow.health).toBe("lowers");
    expect(OP_FLOW.withdraw_collateral.health).toBe("lowers");
  });

  it("values a Blend supply as health-neutral, as the RiskEngine does (b-token receipt at underlying × oracle)", () => {
    expect(OP_FLOW.supply_blend.health).toBe("neutral");
    expect(OP_FLOW.supply_blend.from).toBe("account");
  });

  it("hands tokens over only between token pockets, in the direction the tokens went", () => {
    expect(feeds("deposit_collateral", "supply_blend")).toBe(true);
    expect(feeds("borrow", "supply_blend")).toBe(true);
    expect(feeds("borrow", "repay")).toBe(true);
    expect(feeds("redeem", "deposit_collateral")).toBe(true);
    expect(feeds("redeem", "lend")).toBe(true);
    expect(feeds("withdraw_collateral", "lend")).toBe(true);
    // Positions are not amounts the next tool is called with.
    expect(feeds("lend", "redeem")).toBe(false);
    expect(feeds("supply_blend", "withdraw_collateral")).toBe(false);
    expect(feeds("repay", "borrow")).toBe(false);
    // Nothing feeds a borrow: it draws on capacity, not on a balance.
    expect(WORKFLOW_OPS.some((op) => feeds(op, "borrow"))).toBe(false);
  });

  it("names a position read for exactly the ops 'all of it' can size, and a rate for exactly the ops that carry one", () => {
    expect(WORKFLOW_OPS.filter((op) => OP_FLOW[op].positionRead !== null).sort()).toEqual(["blend_withdraw", "redeem", "remove_liquidity", "repay", "swap", "withdraw_collateral"]);
    expect(WORKFLOW_OPS.filter((op) => OP_FLOW[op].rate !== null).sort()).toEqual(["borrow", "lend", "supply_blend"]);
    expect(OP_FLOW.borrow.rate).toBe("earn_borrow");
  });

  it("agrees with the allowlist about which venue's tool each op calls", () => {
    for (const op of WORKFLOW_OPS) {
      const tool = TOOLS[op];
      const venue = OP_FLOW[op].venue;
      if (venue === "earn") expect(tool, op).toMatch(/^vanna_(lend|redeem)$/);
      if (venue === "blend") expect(tool, op).toMatch(/blend/);
      if (venue === "margin") expect(tool, op).toMatch(/^vanna_(deposit_collateral|withdraw_collateral|borrow|repay|swap|remove_liquidity|add_liquidity)$/);
    }
  });
});

describe("what the protocol can actually swap", () => {
  it("is exactly the four directions its pools hold, and nothing else", async () => {
    /**
     * Confirmed against the Trade page, 15 Sep: AqUSDC↔XLM on Aquarius, SoUSDC↔XLM on
     * Soroswap. BLUSDC is Blend's USDC and has no pool at all, so `lpVenue` is null for it
     * AND for XLM - XLM carries none because it is the other side of every pair, not a
     * named one. Reading the venue off either asset therefore routed XLM→BLUSDC to
     * Soroswap, a pool that cannot fill it; the venue comes from the pair now.
     */
    const { ASSET_IDS, poolVenueFor, swappableWith } = await import("@/lib/copilot/registry/assets");
    const pairs = ASSET_IDS.flatMap((a) => ASSET_IDS.map((b) => [a, b] as const))
      .flatMap(([a, b]) => { const venue = poolVenueFor(a, b); return venue ? [`${a}->${b} ${venue}`] : []; });
    expect(pairs.sort()).toEqual([
      "AQUSDC->XLM aquarius", "SOUSDC->XLM soroswap", "XLM->AQUSDC aquarius", "XLM->SOUSDC soroswap",
    ]);
    expect(poolVenueFor("XLM", "BLUSDC")).toBeNull();
    expect(poolVenueFor("AQUSDC", "SOUSDC")).toBeNull();
    expect(swappableWith("XLM").sort()).toEqual(["AQUSDC", "SOUSDC"]);
    expect(swappableWith("BLUSDC")).toEqual([]);
  });
});

describe("what the table decides downstream", () => {
  it("seals every read a leg sizes from, so Prepare can re-size what the card offered", async () => {
    /**
     * 14 Sep, live: "withdraw all XLM from Blend" sized correctly on the card - 26,565.288
     * XLM - and Prepare answered "no XLM Blend supply was read this investigation". The
     * evidence kept a hand-written list of capabilities that `blend_position` was not on,
     * so the read the plan was sized from never reached the proposal. The list is derived
     * from the op-flow table now; this fails if a new op's read is ever dropped again.
     */
    const { compactResearchEvidence } = await import("@/lib/copilot/investigation/evidence");
    const reads = [...new Set(WORKFLOW_OPS.map((op) => OP_FLOW[op].positionRead).filter(Boolean))] as string[];
    const observations = reads.map((capability, index) => ({
      id: `e${index}`, capability, args: {}, observedAt: NOW, status: "ok" as const,
      data: { positions: [{ symbol: "XLM", balance: "1" }] },
    }));
    const sealed = compactResearchEvidence(observations, null, NOW);
    expect(sealed.observations.map((o) => o.capability).sort()).toEqual([...reads].sort());
  });

  const NOW = 1_700_000_000_000;
  const plan = (legs: ProposedPlan["legs"]): ProposedPlan => ({ title: "t", rationale: "r", evidenceIds: [], legs });

  it("a repay reads the token balance the account really holds, which is what pays it", async () => {
    const stated = readsForPlans([plan([{ op: "repay", asset: "XLM", sizing: { kind: "literal", amount: "90", sourceQuote: "repay 90 XLM" } }])], [], NOW);
    expect(stated).toContainEqual({ capability: "account_token_balance", args: { asset: "XLM" } });
    const whole = readsForPlans([plan([{ op: "repay", asset: "AQUSDC", sizing: { kind: "all_position" } }])], [], NOW);
    expect(whole).toContainEqual({ capability: "account_token_balance", args: { asset: "AQUSDC" } });
    // A deposit is paid from the wallet, so it does not ask for the account's balance.
    const deposit = readsForPlans([plan([{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "5", sourceQuote: "deposit 5 XLM" } }])], [], NOW);
    expect(deposit.map((r) => r.capability)).not.toContain("account_token_balance");
  });

  it("binds the account's balance read to the account and the token's own contract, and refuses anything else", async () => {
    const { resolveRead } = await import("@/lib/copilot/investigation/catalog");
    const { sep41Token } = await import("@/lib/copilot/token-contracts");
    const scope = { subject: "user", network: "testnet", trader: "GTRADER", smartAccount: "CACCOUNT" };
    for (const asset of ["XLM", "BLUSDC", "AQUSDC", "SOUSDC"]) {
      expect(resolveRead("account_token_balance", { asset }, scope)).toEqual({ tool: "vanna_get_token_balance", args: { holder: "CACCOUNT", token_contract: sep41Token(asset) } });
    }
    expect(() => resolveRead("account_token_balance", { asset: "DOGE" }, scope)).toThrow();
    expect(() => resolveRead("account_token_balance", { asset: "XLM" }, { ...scope, smartAccount: null })).toThrow();
  });

  it("seals the account's balance with the evidence, so Prepare re-sizes from the same figure", async () => {
    const { compactResearchEvidence } = await import("@/lib/copilot/investigation/evidence");
    const held = obs("tb", "account_token_balance", { holder: "CACCOUNT", contract: "CTOKEN", symbol: "XLM", decimals: 7, human: "140", raw: "1400000000", extra: "dropped" }, { asset: "XLM" });
    const sealed = compactResearchEvidence([held], null, NOW);
    expect(sealed.observations).toHaveLength(1);
    expect(sealed.observations[0]).toMatchObject({ capability: "account_token_balance", args: { asset: "XLM" }, data: { holder: "CACCOUNT", symbol: "XLM", decimals: 7, human: "140" } });
    expect((sealed.observations[0].data as Record<string, unknown>).extra).toBeUndefined();
  });

  it("a leg the account funds reads the account's balance, whatever its sizing word", () => {
    const reads = readsForPlans([plan([{ op: "supply_blend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "100 XLM" } }])], [], NOW);
    expect(reads.map((r) => r.capability)).toContain("account_collateral");
    const withdraw = readsForPlans([plan([{ op: "withdraw_collateral", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "100 XLM" } }])], [], NOW);
    expect(withdraw.map((r) => r.capability)).toContain("account_collateral");
  });

  const obs = (id: string, capability: string, data: Record<string, unknown>, args: Record<string, unknown> = {}): Observation =>
    ({ id, capability, args, observedAt: NOW, status: "ok", data });
  const SCOPE = { subject: "user", network: "testnet", trader: "GTRADER", smartAccount: "CACCOUNT" };
  const rows = (wallet: string, posted: string, owed: string): Observation[] => [
    obs("w", "wallet_balances", { assets: [{ symbol: "XLM", balance: wallet, decimals: 7, status: "ok" }, { symbol: "XLM_SAC", balance: wallet, decimals: 7, status: "ok" }], fee_reserve_xlm: "0.5" }),
    obs("p", "asset_price", { price_usd: "0.18" }, { asset: "XLM" }),
    obs("m", "earn_market", { supply_apr_pct: "5", borrow_apr_pct: "8", utilization_pct: "62.5" }, { asset: "XLM" }),
    obs("ac", "account_collateral", { collateral: posted === "0" ? [] : [{ symbol: "XLM", balance: posted }] }),
    obs("ad", "account_debt", { debt: owed === "0" ? [] : [{ symbol: "XLM", balance: owed }] }),
  ];
  const ctx = (observations: Observation[], messages: string[]) => ({
    scope: SCOPE, observations, now: NOW, messages, borrowing: "allowed" as const,
    capacity: { grossCollateralUsd: "144", debtUsd: "54", floor: null }, comparisons: compareObservedRates(observations, NOW),
  });

  it("re-sizes an all-position Blend exit after investigation evidence is compacted", async () => {
    const { compactResearchEvidence } = await import("@/lib/copilot/investigation/evidence");
    const observations: Observation[] = [
      obs("w", "wallet_balances", { assets: [{ symbol: "XLM", balance: "1", decimals: 7, status: "ok" }], fee_reserve_xlm: "0.5" }),
      obs("p", "asset_price", { price_usd: "0.18" }, { asset: "XLM" }),
      obs("bp", "blend_position", { positions: [{ symbol: "XLM", underlying_value: "872.17" }] }),
    ];
    const sealed = compactResearchEvidence(observations, null, NOW);
    const result = resolvePlans([
      plan([{ op: "blend_withdraw", asset: "XLM", sizing: { kind: "all_position" } }]),
    ], ctx(sealed.observations, ["remove my XLM position from Blend"]));

    expect(result.rejected).toEqual([]);
    expect(result.candidates[0]?.steps?.[0]).toMatchObject({
      op: "blend_withdraw",
      asset: "XLM",
      amount: "872.17",
    });
  });

  it("names each blocked lend once: one refusal per asset, not per repeated leg", () => {
    const lit = (asset: string) => ({ op: "lend" as const, asset, sizing: { kind: "literal" as const, amount: "10", sourceQuote: `lend 10 ${asset}` } });
    const empty = ctx(rows("0", "0", "0"), ["lend 10 XLM and 10 XLM"]);
    expect(resolvePlans([plan([lit("XLM"), lit("XLM")])], empty).rejected).toHaveLength(1);
    const twoAssets = resolvePlans([plan([lit("XLM"), lit("AQUSDC")])], ctx(rows("0", "0", "0"), ["lend 10 XLM and 10 AQUSDC"]));
    expect(new Set(twoAssets.rejected.map((entry) => entry.leg)).size).toBe(twoAssets.rejected.length);
    expect(twoAssets.rejected.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps a confirmed empty Blend position apart from a failed read on an all-position exit", () => {
    const base: Observation[] = [
      obs("w", "wallet_balances", { assets: [{ symbol: "XLM", balance: "1", decimals: 7, status: "ok" }], fee_reserve_xlm: "0.5" }),
      obs("p", "asset_price", { price_usd: "0.18" }, { asset: "XLM" }),
    ];
    const exit = [plan([{ op: "blend_withdraw", asset: "XLM", sizing: { kind: "all_position" } }])];
    const zero = resolvePlans(exit, ctx([...base, obs("bp", "blend_position", { positions: [{ symbol: "XLM", underlying_value: "0" }] })], ["remove my XLM position from Blend"]));
    const failed = resolvePlans(exit, ctx([...base, { id: "bp", capability: "blend_position", args: {}, observedAt: NOW, status: "error", error: "timeout" } as Observation], ["remove my XLM position from Blend"]));
    expect(zero.candidates).toEqual([]);
    expect(failed.candidates).toEqual([]);
    // Moved here from blend-full-position-direct (keyword path, unreachable under investigate-first).
    expect(zero.rejected[0]?.reason).toBe("you have no XLM supplied to Blend");
    expect(failed.rejected[0]?.reason).toBe("no XLM Blend supply was read this investigation");
  });

  it("a stated lend is funded from the wallet: the shape matrix found 'lend 100 XLM' offered from an empty wallet", () => {
    const empty = resolvePlans([plan([{ op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "lend 100 XLM" } }])], ctx(rows("0", "0", "0"), ["lend 100 XLM"]));
    expect(empty.candidates).toEqual([]);
    expect(empty.rejected[0]?.reason).toBe("XLM is not in the connected wallet");
    const short = resolvePlans([plan([{ op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "lend 100 XLM" } }])], ctx(rows("60", "0", "0"), ["lend 100 XLM"]));
    expect(short.rejected[0]?.reason).toBe("only 59.5 XLM is spendable in the wallet");
  });

  it("keeps the wallet minimum balance and fee reserve out of Earn lend capacity", () => {
    const constrained = rows("60", "0", "0").map((observation) => observation.capability === "wallet_balances"
      ? { ...observation, data: { ...observation.data, assets: [{ symbol: "XLM", balance: "60", min_balance: "3.5", decimals: 7, status: "ok" }, { symbol: "XLM_SAC", balance: "60", min_balance: "3.5", decimals: 7, status: "ok" }] } }
      : observation);
    const result = resolvePlans([plan([{ op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "57", sourceQuote: "lend 57 XLM" } }])], ctx(constrained, ["lend 57 XLM"]));
    expect(result.candidates).toEqual([]);
    expect(result.rejected[0]?.reason).toBe("only 56 XLM is spendable in the wallet");
  });

  it("keeps both requested Earn lends together when one needs margin funding", () => {
    const multiAsset = [
      obs("w", "wallet_balances", {
        assets: [
          { symbol: "XLM", balance: "60", decimals: 7, status: "ok" },
          { symbol: "XLM_SAC", balance: "60", decimals: 7, status: "ok" },
          { symbol: "AQUSDC", balance: "0", decimals: 7, status: "ok" },
        ], fee_reserve_xlm: "0.5",
      }),
      obs("px", "asset_price", { price_usd: "0.18" }, { asset: "XLM" }),
      obs("pa", "asset_price", { price_usd: "1" }, { asset: "AQUSDC" }),
      obs("mx", "earn_market", { supply_apr_pct: "5", borrow_apr_pct: "8", utilization_pct: "62.5" }, { asset: "XLM" }),
      obs("ma", "earn_market", { supply_apr_pct: "4", borrow_apr_pct: "8", utilization_pct: "62.5" }, { asset: "AQUSDC" }),
      obs("ac", "account_collateral", { collateral: [{ symbol: "AQUSDC", balance: "20" }] }),
      obs("ad", "account_debt", { debt: [] }),
    ];
    const result = resolvePlans([plan([
      { op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "10", sourceQuote: "lend 10 XLM" } },
      { op: "lend", asset: "AQUSDC", sizing: { kind: "literal", amount: "10", sourceQuote: "lend 10 AQUSDC" } },
    ])], ctx(multiAsset, ["lend 10 XLM", "lend 10 AQUSDC"]));
    const shapes = result.candidates.map((candidate) => candidate.steps?.map((step) => [step.op, step.asset]));
    expect(shapes).toEqual([
      [["lend", "XLM"], ["withdraw_collateral", "AQUSDC"], ["lend", "AQUSDC"]],
    ]);
  });

  it("offers the complete bridged plan without a sibling that omits a requested lend", () => {
    const multiAsset = [
      obs("w", "wallet_balances", {
        assets: [
          { symbol: "XLM", balance: "60", decimals: 7, status: "ok" },
          { symbol: "XLM_SAC", balance: "60", decimals: 7, status: "ok" },
          { symbol: "AQUSDC", balance: "0", decimals: 7, status: "ok" },
        ], fee_reserve_xlm: "0.5",
      }),
      obs("px", "asset_price", { price_usd: "0.18" }, { asset: "XLM" }),
      obs("pa", "asset_price", { price_usd: "1" }, { asset: "AQUSDC" }),
      obs("mx", "earn_market", { supply_apr_pct: "5", borrow_apr_pct: "8", utilization_pct: "62.5" }, { asset: "XLM" }),
      obs("ma", "earn_market", { supply_apr_pct: "4", borrow_apr_pct: "8", utilization_pct: "62.5" }, { asset: "AQUSDC" }),
      obs("ac", "account_collateral", { collateral: [{ symbol: "AQUSDC", balance: "20" }] }),
      obs("ad", "account_debt", { debt: [] }),
    ];
    const { candidates } = resolvePlans([plan([
      { op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "10", sourceQuote: "lend 10 XLM" } },
      { op: "lend", asset: "AQUSDC", sizing: { kind: "literal", amount: "10", sourceQuote: "lend 10 AQUSDC" } },
    ])], ctx(multiAsset, ["lend 10 XLM", "lend 10 AQUSDC"]));
    const shapes = candidates.map((candidate) => candidate.steps?.map((step) => [step.op, step.asset]));
    expect(shapes).toEqual([
      [["lend", "XLM"], ["withdraw_collateral", "AQUSDC"], ["lend", "AQUSDC"]],
    ]);
  });

  it("returns one refusal when a required account-to-wallet bridge cannot preserve health", () => {
    const result = resolvePlans([plan([
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "100 XLM" } },
      { op: "lend", asset: "XLM", sizing: { kind: "previous_leg" } },
    ])], { ...ctx(rows("500", "0", "300"), ["100 XLM deposit then lend"]), capacity: { grossCollateralUsd: "0", debtUsd: "54", floor: "1.3" } });
    expect(result.candidates).toEqual([]);
    expect(result.rejected).toHaveLength(1);
  });

  it("a stated Blend supply is funded from the account's own balance, without a deposit before it", () => {
    const { candidates, rejected } = resolvePlans([plan([{ op: "supply_blend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "supply 100 XLM" } }])], ctx(rows("0", "800", "0"), ["supply 100 XLM to Blend"]));
    expect(rejected).toEqual([]);
    expect(candidates[0]?.steps?.map((s) => [s.op, s.amount])).toEqual([["supply_blend", "100"]]);
    const over = resolvePlans([plan([{ op: "supply_blend", asset: "XLM", sizing: { kind: "literal", amount: "900", sourceQuote: "supply 900 XLM" } }])], ctx(rows("0", "800", "0"), ["supply 900 XLM to Blend"]));
    // No read of the account's real balance here, so the sizer's own check against the recorded figure speaks.
    expect(over.rejected[0]?.reason).toBe("only 800 XLM is in the margin account");
  });

  /**
   * A repay is paid from the token balance the margin account really holds (`account_token_balance`), not from
   * recorded collateral, which leaves out the proceeds of a borrow in that token. A stated amount is repaid from
   * what the account holds, up to the amount; the wallet is never topped up unless the user asked to repay with it.
   * 22 Oct, three live reports: 50 XLM posted, 90 borrowed, "repay 90" deposited 90 more first.
   */
  const accountHolds = (symbol: string, human: string): Observation =>
    obs(`tb-${symbol}`, "account_token_balance", { holder: "CACCOUNT", symbol, decimals: 7, human }, { asset: symbol });
  const repayOf = (amount: string, observations: Observation[], asset = "XLM") =>
    resolvePlans([plan([{ op: "repay", asset, sizing: { kind: "literal", amount, sourceQuote: `repay ${amount} ${asset}` } }])], ctx(observations, [`repay ${amount} ${asset}`]));

  it("repays a stated amount straight from the account when it really holds that much, whatever is recorded as collateral", () => {
    // Recorded collateral 50 (the dev's own deposit); the account actually holds 140 after borrowing 90.
    const result = repayOf("90", [...rows("500", "50", "300"), accountHolds("XLM", "140")]);
    expect(result.rejected).toEqual([]);
    expect(result.candidates[0]?.steps?.map((s) => [s.op, s.amount])).toEqual([["repay", "90"]]);
  });

  it("repays what the account holds, not a wallet deposit, when it holds less than was asked", () => {
    const result = repayOf("90", [...rows("500", "0", "300"), accountHolds("XLM", "50")]);
    expect(result.rejected).toEqual([]);
    const candidate = result.candidates[0]!;
    expect(candidate.steps?.map((s) => [s.op, s.amount])).toEqual([["repay", "50"]]);
    expect(candidate.rationale).toContain("Repays 50 of the 90 XLM you asked for");
    expect(candidate.rationale).toContain("Leaves 250 XLM of debt");
  });

  it("says plainly when the account holds nothing to repay with, and offers the wallet only by name", () => {
    const result = repayOf("90", [...rows("500", "0", "300"), accountHolds("XLM", "0")]);
    expect(result.candidates).toEqual([]);
    expect(result.rejected[0]?.reason).toBe("Your margin account holds no XLM to repay with. Deposit XLM into the account first, or ask to repay with your wallet's XLM");
  });

  it("leaves the stated repay alone, with no deposit, when the account's balance could not be read", () => {
    const result = repayOf("100", rows("500", "0", "300"));
    expect(result.rejected).toEqual([]);
    expect(result.candidates[0]?.steps?.map((s) => [s.op, s.amount])).toEqual([["repay", "100"]]);
  });

  it("still refuses to repay more than is owed", () => {
    const result = repayOf("400", [...rows("500", "0", "300"), accountHolds("XLM", "900")]);
    expect(result.rejected[0]?.reason).toBe("you owe only 300 XLM");
  });

  it("behaves the same for another token and other amounts: the rule is about the balance, not a symbol", () => {
    const usdc = (wallet: string, owed: string, held: string): Observation[] => [
      obs("w", "wallet_balances", { assets: [{ symbol: "XLM", balance: "60", decimals: 7, status: "ok" }, { symbol: "XLM_SAC", balance: "60", decimals: 7, status: "ok" }, { symbol: "AQUSDC", balance: wallet, decimals: 7, status: "ok" }], fee_reserve_xlm: "0.5" }),
      obs("p", "asset_price", { price_usd: "1" }, { asset: "AQUSDC" }),
      obs("m", "earn_market", { supply_apr_pct: "4", borrow_apr_pct: "8", utilization_pct: "62.5" }, { asset: "AQUSDC" }),
      obs("ac", "account_collateral", { collateral: [] }),
      obs("ad", "account_debt", { debt: [{ symbol: "AQUSDC", balance: owed }] }),
      accountHolds("AQUSDC", held),
    ];
    const enough = repayOf("7.5", usdc("40", "11.78", "12"), "AQUSDC");
    expect(enough.candidates[0]?.steps?.map((s) => [s.op, s.amount])).toEqual([["repay", "7.5"]]);
    const short = repayOf("11", usdc("40", "11.78", "3.25"), "AQUSDC");
    expect(short.candidates[0]?.steps?.map((s) => [s.op, s.amount])).toEqual([["repay", "3.25"]]);
    expect(short.candidates[0]?.rationale).toContain("Repays 3.25 of the 11 AQUSDC you asked for");
  });

  it("a Blend supply uses what the account really holds, and a true shortfall is named, never topped up from the wallet", () => {
    const supply = (account: string, wallet: string) => resolvePlans(
      [plan([{ op: "supply_blend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "supply 100 XLM" } }])],
      ctx([...rows(wallet, "40", "0"), accountHolds("XLM", account)], ["supply 100 XLM to Blend"]));
    // Recorded collateral is 40, the account really holds 140: nothing to deposit.
    expect(supply("140", "500").candidates[0]?.steps?.map((s) => [s.op, s.amount])).toEqual([["supply_blend", "100"]]);
    // It really holds 60: the Farm page's rule - say what is missing, whatever the wallet could add.
    for (const wallet of ["0", "500"]) {
      const short = supply("60", wallet);
      expect(short.candidates).toEqual([]);
      expect(short.rejected[0]?.reason).toBe("Your margin account holds 60 XLM and this needs 100. Deposit the other 40 XLM into the account first");
    }
    // The balance was not read: no deposit is made up either; the sizer's own check against the recorded figure speaks.
    const unread = resolvePlans([plan([{ op: "supply_blend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "supply 100 XLM" } }])], ctx(rows("500", "40", "0"), ["supply 100 XLM to Blend"]));
    expect(unread.candidates).toEqual([]);
    expect(unread.rejected[0]?.reason).toBe("only 40 XLM is in the margin account");
  });

  it("asks for the account's real balance for a repay and for a Blend supply, but not for a deposit", () => {
    const supply = readsForPlans([plan([{ op: "supply_blend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "supply 100 XLM" } }])], [], NOW);
    expect(supply).toContainEqual({ capability: "account_token_balance", args: { asset: "XLM" } });
    const deposit = readsForPlans([plan([{ op: "deposit_collateral", asset: "XLM", sizing: { kind: "literal", amount: "5", sourceQuote: "deposit 5 XLM" } }])], [], NOW);
    expect(deposit.map((r) => r.capability)).not.toContain("account_token_balance");
  });

  it("keeps the wallet top-up for a repay the user sized from their wallet", () => {
    const result = resolvePlans([plan([{ op: "repay", asset: "XLM", sizing: { kind: "all_wallet" } }])], ctx([...rows("500", "0", "300"), accountHolds("XLM", "0")], ["repay with my idle xlm"]));
    expect(result.candidates[0]?.steps?.map((s) => s.op)).toEqual(["deposit_collateral", "repay"]);
  });

  it("previous_leg follows the tokens: a borrow takes nothing from the leg before it", () => {
    const { rejected } = resolvePlans([plan([
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_wallet" } },
      { op: "borrow", asset: "XLM", sizing: { kind: "previous_leg" } },
    ])], { ...ctx(rows("500", "0", "0"), ["deposit and borrow, HF above 1.3"]), capacity: { grossCollateralUsd: "144", debtUsd: "54", floor: "1.3" } });
    // The list of takers is read from the table, so a new account-drawing op joins it by itself.
    expect(rejected[0]?.reason).toMatch(/^a deposit puts tokens in the account - .* them next, not a borrow$/);
  });
});
