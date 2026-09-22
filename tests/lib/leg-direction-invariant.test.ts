import { describe, expect, it } from "vitest";
import { contradictsStatedSource, flowOf, statedSourcePockets } from "@/lib/copilot/leg-direction";
import { routeMessage } from "@/lib/copilot/router";
import { OP_FLOW, POCKET_HOLDER, WORKFLOW_OPS } from "@/lib/copilot/workflow/types";

/**
 * Money must not move the way the user did not ask.
 *
 * Live, 22 Sep: "withdraw 30 XLM from blend and lend it in earn" planned
 * `lend 30 XLM` then `deploy_to_blend BLUSDC` — INTO Blend, the opposite direction, in
 * an asset never mentioned, sitting on WAITING ON YOUR SIGNATURE. The multi-goal
 * planner pushes a Blend leg on the presence of the word "blend" alone, so a sentence
 * taking money OUT of Blend built a leg putting money in.
 *
 * The same sentence routes correctly as a single leg, which is what makes refusing the
 * plan safe: the direction is then read from the user's own words.
 */

type Routed = { kind: string; op?: string; steps?: Array<{ op?: string }> };
const route = (message: string) => routeMessage(message) as Routed;
const opsOf = (routed: Routed) => routed.steps?.map((step) => step.op) ?? [routed.op];

describe("THE LIVE BUG: a plan that moves money the wrong way", () => {
  const message = "withdraw 30 XLM from blend and lend it in earn";

  it("never plans a leg that supplies into the pocket it was told to draw from", () => {
    expect(opsOf(route(message))).not.toContain("deploy_to_blend");
  });

  it("reads the direction the user stated", () => {
    expect(opsOf(route(message))).toContain("withdraw_from_blend");
  });
});

/**
 * The invariant reads `OP_FLOW`'s pockets, so it holds for every op that has a reverse
 * twin — including the pairs the fix names nowhere.
 */
describe("a source-naming prompt never resolves to an op's reverse twin", () => {
  const CASES: Array<{ message: string; banned: string }> = [
    // The reported pair.
    { message: "withdraw 30 XLM from blend and lend it in earn", banned: "deploy_to_blend" },
    // Pairs the fix does not name — proof this comes from the flow table, not a list.
    { message: "redeem 20 XLM from earn and deposit it as collateral", banned: "lend" },
    { message: "withdraw 50 XLM from collateral and lend it", banned: "deposit_collateral" },
  ];

  for (const { message, banned } of CASES) {
    it(`"${message}" never plans ${banned}`, () => {
      expect(opsOf(route(message))).not.toContain(banned);
    });
  }
});

describe("the flow table is what decides", () => {
  const pockets = (op: keyof typeof OP_FLOW) => ({ from: OP_FLOW[op].from, to: OP_FLOW[op].to });

  it("resolves planner spellings onto their canonical flow", () => {
    expect(flowOf("deploy_to_blend")).toEqual(pockets("supply_blend"));
    expect(flowOf("withdraw_from_blend")).toEqual(pockets("blend_withdraw"));
    expect(flowOf("supply_to_blend")).toEqual(pockets("supply_blend"));
  });

  /** The twins really are opposites, which is what makes the one-sided test meaningful. */
  it("reads a reverse twin as the reverse", () => {
    expect(flowOf("deploy_to_blend")).toEqual({
      from: flowOf("withdraw_from_blend")!.to,
      to: flowOf("withdraw_from_blend")!.from,
    });
  });

  it("knows every canonical op without an alias", () => {
    for (const op of WORKFLOW_OPS) {
      expect(flowOf(op), `no flow for ${op}`).not.toBeNull();
    }
  });

  it("says nothing about an op it does not know", () => {
    expect(flowOf("create_account")).toBeNull();
    expect(contradictsStatedSource("create_account", "open an account from wallet")).toBe(false);
  });
});

describe("a source is read from grammar, not from a verb", () => {
  it("reads the pocket named after a source preposition", () => {
    expect(statedSourcePockets("withdraw 30 XLM from blend")).toEqual(new Set(["blend"]));
    expect(statedSourcePockets("take it out of my earn position")).toEqual(new Set(["earn"]));
  });

  it("names no source when the sentence states none", () => {
    expect(statedSourcePockets("supply 20 XLM to blend").size).toBe(0);
  });

  /**
   * The vocabulary is derived from `POCKET_HOLDER`, not written out, so every pocket a
   * user can speak of is understood without being listed — including any added later.
   * `debt` is the one deliberate exclusion: nobody says "from my debt" to mean a borrow
   * draws on it, and reading it as a source would refuse a legitimate repay.
   */
  it("understands every spoken pocket by its own name, with no list to maintain", () => {
    for (const pocket of Object.keys(POCKET_HOLDER) as Array<keyof typeof POCKET_HOLDER>) {
      const seen = statedSourcePockets(`take it from ${pocket}`);
      if (pocket === "debt") expect(seen.size, "debt must not read as a source").toBe(0);
      else expect(seen, `"${pocket}" should be read as a source`).toContain(pocket);
    }
  });

  it("does not refuse a repay, which lands in debt by definition", () => {
    expect(contradictsStatedSource("repay", "repay it from my wallet")).toBe(false);
  });

  /**
   * A leg that draws from a stated source is doing what it was told, whatever else the
   * sentence names — the test is one-sided on purpose. A swap both spends and receives
   * inside the margin account, so a sentence naming that account as the source must not
   * be read as contradicting it.
   */
  it("allows a leg whose own source is also stated", () => {
    expect(contradictsStatedSource("swap", "swap 100 XLM from my margin account")).toBe(false);
    expect(contradictsStatedSource("withdraw_from_blend", "withdraw 30 XLM from blend")).toBe(false);
  });

  it("does not refuse a plain supply that names no source", () => {
    expect(contradictsStatedSource("deploy_to_blend", "supply 20 XLM to blend")).toBe(false);
  });
});
