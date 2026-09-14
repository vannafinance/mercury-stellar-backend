/**
 * The op-flow table — one truth for what each op does, shared by the sizer, the reads a
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
    expect(WORKFLOW_OPS.filter((op) => OP_FLOW[op].positionRead !== null).sort()).toEqual(["blend_withdraw", "redeem", "repay", "swap", "withdraw_collateral"]);
    expect(WORKFLOW_OPS.filter((op) => OP_FLOW[op].rate !== null).sort()).toEqual(["borrow", "lend", "supply_blend"]);
    expect(OP_FLOW.borrow.rate).toBe("earn_borrow");
  });

  it("agrees with the allowlist about which venue's tool each op calls", () => {
    for (const op of WORKFLOW_OPS) {
      const tool = TOOLS[op];
      const venue = OP_FLOW[op].venue;
      if (venue === "earn") expect(tool, op).toMatch(/^vanna_(lend|redeem)$/);
      if (venue === "blend") expect(tool, op).toMatch(/blend/);
      if (venue === "margin") expect(tool, op).toMatch(/^vanna_(deposit_collateral|withdraw_collateral|borrow|repay|swap)$/);
    }
  });
});

describe("what the protocol can actually swap", () => {
  it("is exactly the four directions its pools hold, and nothing else", async () => {
    /**
     * Confirmed against the Trade page, 15 Sep: AqUSDC↔XLM on Aquarius, SoUSDC↔XLM on
     * Soroswap. BLUSDC is Blend's USDC and has no pool at all, so `lpVenue` is null for it
     * AND for XLM — XLM carries none because it is the other side of every pair, not a
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
     * 14 Sep, live: "withdraw all XLM from Blend" sized correctly on the card — 26,565.288
     * XLM — and Prepare answered "no XLM Blend supply was read this investigation". The
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

  it("a stated lend is funded from the wallet: the shape matrix found 'lend 100 XLM' offered from an empty wallet", () => {
    const empty = resolvePlans([plan([{ op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "lend 100 XLM" } }])], ctx(rows("0", "0", "0"), ["lend 100 XLM"]));
    expect(empty.candidates).toEqual([]);
    expect(empty.rejected[0]?.reason).toBe("no idle XLM in the wallet");
    const short = resolvePlans([plan([{ op: "lend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "lend 100 XLM" } }])], ctx(rows("60", "0", "0"), ["lend 100 XLM"]));
    expect(short.rejected[0]?.reason).toBe("only 59.5 XLM is spendable in the wallet");
  });

  it("a stated Blend supply is funded from the account's own balance, without a deposit before it", () => {
    const { candidates, rejected } = resolvePlans([plan([{ op: "supply_blend", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "supply 100 XLM" } }])], ctx(rows("0", "800", "0"), ["supply 100 XLM to Blend"]));
    expect(rejected).toEqual([]);
    expect(candidates[0]?.steps?.map((s) => [s.op, s.amount])).toEqual([["supply_blend", "100"]]);
    const over = resolvePlans([plan([{ op: "supply_blend", asset: "XLM", sizing: { kind: "literal", amount: "900", sourceQuote: "supply 900 XLM" } }])], ctx(rows("0", "800", "0"), ["supply 900 XLM to Blend"]));
    expect(over.rejected[0]?.reason).toBe("only 800 XLM is in the margin account");
  });

  it("a stated repay comes from the account when it holds enough, else the wallet puts it in first", () => {
    const fromAccount = resolvePlans([plan([{ op: "repay", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "repay 100 XLM" } }])], ctx(rows("0", "800", "300"), ["repay 100 XLM"]));
    expect(fromAccount.candidates[0]?.steps?.map((s) => [s.op, s.amount])).toEqual([["repay", "100"]]);
    const fromWallet = resolvePlans([plan([{ op: "repay", asset: "XLM", sizing: { kind: "literal", amount: "100", sourceQuote: "repay 100 XLM" } }])], ctx(rows("500", "0", "300"), ["repay 100 XLM"]));
    expect(fromWallet.candidates[0]?.steps?.map((s) => [s.op, s.amount])).toEqual([["deposit_collateral", "100"], ["repay", "100"]]);
    const overOwed = resolvePlans([plan([{ op: "repay", asset: "XLM", sizing: { kind: "literal", amount: "400", sourceQuote: "repay 400 XLM" } }])], ctx(rows("500", "0", "300"), ["repay 400 XLM"]));
    expect(overOwed.rejected[0]?.reason).toBe("you owe only 300 XLM");
  });

  it("previous_leg follows the tokens: a borrow takes nothing from the leg before it", () => {
    const { rejected } = resolvePlans([plan([
      { op: "deposit_collateral", asset: "XLM", sizing: { kind: "all_idle" } },
      { op: "borrow", asset: "XLM", sizing: { kind: "previous_leg" } },
    ])], { ...ctx(rows("500", "0", "0"), ["deposit and borrow, HF above 1.3"]), capacity: { grossCollateralUsd: "144", debtUsd: "54", floor: "1.3" } });
    // The list of takers is read from the table, so a new account-drawing op joins it by itself.
    expect(rejected[0]?.reason).toMatch(/^a deposit puts tokens in the account — .* them next, not a borrow$/);
  });
});
