/**
 * Leveraged margin must behave like the margin UI for ANY wording.
 *
 * ## The failure this pins
 *
 *   "Deposit 500 AqUSDC and take 3x Leverage and Borrow xlm in borrowed capital"
 *   → leg 1 deposited 500 AQUSDC, leg 2 paused on "Borrow 11 USDC", asked for a size,
 *     and offered BLUSDC / AQUSDC / SOUSDC chips.
 *
 * Every input needed was in the sentence. The site computes this on every render; the
 * copilot asked for it back. Three separate defects, each general:
 *
 *   A  borrow SIZE was never computed from leverage across two different assets — the
 *      split assumed borrow units are deposit units, so a cross-asset ask had nothing
 *      to show and fell through to "how much?"
 *   B  borrow ASSET did not exist as a slot. One `asset` answered both legs, so a
 *      stated XLM borrow was overwritten by the collateral — or by the default "USDC"
 *   C  the variant chips fired on `action.asset` alone, an action with two asset slots
 *
 * So these tests are written as CLASSES, not as that sentence. If a future prompt
 * expresses the same three slots in different words, it lands in the same rows below.
 */

import { describe, expect, it } from "vitest";
import {
  describeLeveragePlan,
  leverageLegs,
  leveragePriceSymbols,
  planLeverage,
  sameAsset,
} from "@/lib/copilot/leverage-plan";
import { ambiguousUsdcSlot } from "@/lib/copilot/mcp-write";
import {
  findBorrowAmount,
  findBorrowAsset,
  findCollateralAsset,
  routeMessage,
} from "@/lib/copilot/router";
import { actionFromExpanded, expandPlanWrites, materializeLeverageWrites } from "@/lib/copilot/multi-leg-agent";

/** The oracle's answer, not a guess. One feed for all three dollar stables. */
const PRICES = { XLM: 0.11, AQUA: 0.004 };

function plan(slots: Parameters<typeof planLeverage>[0]) {
  const out = planLeverage(slots, PRICES);
  if ("gap" in out) throw new Error(`expected a plan, got gap=${out.gap}`);
  return out.plan;
}

// ── A. leverage → borrow size ───────────────────────────────────────────────

describe("a stated leverage always produces a borrow size", () => {
  it("case 1 — cross-asset: 500 AQUSDC at 3× borrowing XLM", () => {
    const p = plan({
      collateralAsset: "AQUSDC",
      collateralAmount: 500,
      leverage: 3,
      borrowAsset: "XLM",
    });
    // $500 collateral × (3−1) = $1000 of debt, priced into XLM at 0.11.
    expect(p.collateralUsd).toBe(500);
    expect(p.borrowUsd).toBe(1000);
    expect(p.borrowAmount).toBeCloseTo(1000 / 0.11, 4);
    expect(p.borrowAsset).toBe("XLM");
    expect(p.crossAsset).toBe(true);
  });

  it("case 2 — same asset: 20 XLM at 2× borrows 20 XLM", () => {
    const p = plan({ collateralAsset: "XLM", collateralAmount: 20, leverage: 2 });
    expect(p.borrowAmount).toBe(20);
    expect(p.borrowAsset).toBe("XLM");
    expect(p.crossAsset).toBe(false);
  });

  it("case 3 — cross stable: 100 BLUSDC at 5× borrowing AQUSDC goes through USD", () => {
    const p = plan({
      collateralAsset: "BLUSDC",
      collateralAmount: 100,
      leverage: 5,
      borrowAsset: "AQUSDC",
    });
    expect(p.collateralUsd).toBe(100);
    expect(p.borrowUsd).toBe(400);
    expect(p.borrowAmount).toBe(400);
    // Distinct TOKENS, one PRICE — the conversion is real even though the rate is 1.
    expect(p.crossAsset).toBe(true);
    expect(sameAsset("BLUSDC", "AQUSDC")).toBe(false);
  });

  it("Nx is total position, not borrow = N × deposit", () => {
    expect(plan({ collateralAsset: "XLM", collateralAmount: 20, leverage: 3 }).borrowAmount).toBe(40);
    expect(plan({ collateralAsset: "XLM", collateralAmount: 20, leverage: 2 }).borrowAmount).toBe(20);
  });

  it("an explicit borrow figure wins over the multiple", () => {
    const p = plan({
      collateralAsset: "XLM",
      collateralAmount: 20,
      leverage: 5,
      borrowAmount: 7,
    });
    expect(p.borrowAmount).toBe(7);
    expect(p.borrowExplicit).toBe(true);
  });

  it("stable-to-stable needs no oracle round-trip at all", () => {
    expect(leveragePriceSymbols({ collateralAsset: "AQUSDC", borrowAsset: "BLUSDC" })).toEqual([]);
    expect(leveragePriceSymbols({ collateralAsset: "AQUSDC", borrowAsset: "XLM" })).toEqual(["XLM"]);
  });

  it("a same-asset position still sizes with the oracle down", () => {
    const out = planLeverage({ collateralAsset: "XLM", collateralAmount: 20, leverage: 2 }, {});
    expect("plan" in out && out.plan.borrowAmount).toBe(20);
  });

  it("REFUSES to invent a price rather than size a cross-asset borrow wrong", () => {
    // Defaulting a missing XLM price to 1.0 would size this ~9× too small and hand it
    // to a signature prompt. Saying so is the only acceptable answer.
    const out = planLeverage(
      { collateralAsset: "AQUSDC", collateralAmount: 500, leverage: 3, borrowAsset: "XLM" },
      {},
    );
    expect("gap" in out && out.gap).toBe("missing_price");
    expect("symbol" in out && out.symbol).toBe("XLM");
  });

  it("names the missing slot instead of asking a generic question", () => {
    expect(
      "gap" in planLeverage({ collateralAsset: "XLM", leverage: 2 }, PRICES) &&
        (planLeverage({ collateralAsset: "XLM", leverage: 2 }, PRICES) as { gap: string }).gap,
    ).toBe("missing_collateral_amount");
    expect(
      (planLeverage({ collateralAsset: "XLM", collateralAmount: 20 }, PRICES) as { gap: string }).gap,
    ).toBe("missing_leverage");
  });

  it("shows the USD equivalents on a cross-asset plan, like the site", () => {
    const line = describeLeveragePlan(
      plan({ collateralAsset: "AQUSDC", collateralAmount: 500, leverage: 3, borrowAsset: "XLM" }),
    );
    expect(line).toContain("$500");
    expect(line).toContain("$1000");
    expect(line).toContain("XLM");
  });
});

// ── B. asset routing ────────────────────────────────────────────────────────

describe("collateral and borrow are independent slots, for any phrasing", () => {
  const phrasings: Array<[string, { collateral: string; borrow: string | null }]> = [
    [
      "Deposit 500 AqUSDC and take 3x Leverage and Borrow xlm in borrowed capital",
      { collateral: "AQUSDC", borrow: "XLM" },
    ],
    ["park 20 XLM at 2x and borrow BLUSDC", { collateral: "XLM", borrow: "BLUSDC" }],
    ["deposit 100 SOUSDC 5x borrow XLM", { collateral: "SOUSDC", borrow: "XLM" }],
    ["lever 3x with 50 AQUSDC borrowing XLM", { collateral: "AQUSDC", borrow: "XLM" }],
    ["deposit 30 XLM and borrow 2x", { collateral: "XLM", borrow: null }],
    // The backing asset after "against" is collateral, never the thing borrowed.
    ["borrow 5 BLUSDC against my XLM", { collateral: "XLM", borrow: "BLUSDC" }],
  ];

  for (const [message, want] of phrasings) {
    it(`reads both slots from "${message}"`, () => {
      expect(findCollateralAsset(message)).toBe(want.collateral);
      expect(findBorrowAsset(message)).toBe(want.borrow);
    });
  }

  it("the router carries the borrow asset onto the write, not just the collateral", () => {
    const routed = routeMessage("deposit 500 AQUSDC at 3x and borrow XLM");
    expect(routed.kind).toBe("write");
    if (routed.kind !== "write") return;
    expect(routed.op).toBe("deposit_and_borrow");
    expect(routed.asset).toBe("AQUSDC");
    expect(routed.borrow_asset).toBe("XLM");
    expect(routed.leverage).toBe(3);
  });

  it("never rewrites a named borrow asset to the collateral's", () => {
    const routed = routeMessage("deposit 100 AQUSDC and borrow XLM at 2x");
    if (routed.kind !== "write") throw new Error("expected a write");
    expect(routed.borrow_asset).not.toBe(routed.asset);
  });

  it("an explicit borrow size survives when no multiple was given", () => {
    expect(findBorrowAmount("deposit 100 AQUSDC and borrow 25 XLM")).toBe(25);
    // "3x" is leverage, never a quantity.
    expect(findBorrowAmount("deposit 100 AQUSDC at 3x and borrow XLM")).toBeNull();
  });
});

// ── C. variant chips only when actually ambiguous ───────────────────────────

describe("the USDC variant question is asked only about a bare-USDC slot", () => {
  it("case 5 — a named borrow asset never triggers chips", () => {
    expect(ambiguousUsdcSlot({ asset: "AQUSDC", borrow_asset: "XLM" })).toBeNull();
    expect(ambiguousUsdcSlot({ asset: "AQUSDC", borrow_asset: "AQUSDC" })).toBeNull();
    expect(ambiguousUsdcSlot({ asset: "XLM", borrow_asset: "BLUSDC" })).toBeNull();
    expect(ambiguousUsdcSlot({ asset: "SOUSDC", borrow_asset: null })).toBeNull();
    expect(ambiguousUsdcSlot({ asset: "XLM", borrow_asset: "AQUA" })).toBeNull();
  });

  it("case 4 — bare USDC still asks, and says which slot it is asking about", () => {
    expect(ambiguousUsdcSlot({ asset: "USDC" })).toBe("collateral");
    expect(ambiguousUsdcSlot({ asset: "XLM", borrow_asset: "USDC" })).toBe("borrow");
  });

  it("THE LIVE BUG: a concrete collateral with a concrete borrow asks nothing", () => {
    const routed = routeMessage(
      "Deposit 500 AqUSDC and take 3x Leverage and Borrow xlm in borrowed capital",
    );
    if (routed.kind !== "write") throw new Error("expected a write");
    expect(ambiguousUsdcSlot(routed)).toBeNull();
  });
});

// ── D. the second leg is fully determined ───────────────────────────────────

describe("leg 2 needs nothing more from the user", () => {
  it("case 6 — the borrow leg carries both the computed size and the right asset", () => {
    const legs = leverageLegs(
      plan({ collateralAsset: "AQUSDC", collateralAmount: 500, leverage: 3, borrowAsset: "XLM" }),
    );
    expect(legs.deposit).toEqual({ op: "deposit_collateral", asset: "AQUSDC", amount: 500 });
    expect(legs.borrow.op).toBe("borrow");
    expect(legs.borrow.asset).toBe("XLM");
    expect(legs.borrow.amount).toBeGreaterThan(0);
    // Resuming this leg re-enters the write path with a concrete asset, so the chip
    // gate has nothing to ask about — which is what kept re-opening the question.
    expect(ambiguousUsdcSlot({ asset: legs.borrow.asset })).toBeNull();
  });

  it("a same-asset plan still splits into two legs during multi-leg expansion", () => {
    const [dep, bor] = expandPlanWrites([
      { kind: "write", op: "deposit_and_borrow", asset: "XLM", amount: 20, args: { leverage: 2 } },
    ]);
    expect(dep.op).toBe("deposit_collateral");
    expect(bor.op).toBe("borrow");
    expect(bor.asset).toBe("XLM");
    expect(bor.amount).toBe(20);
  });

  it("a cross-asset plan keeps its shape so the executor can price it", () => {
    // Splitting here would have to size the borrow, and this expansion has no oracle.
    // Emitting a borrow leg in the WRONG units is the failure being prevented.
    const [only] = expandPlanWrites([
      {
        kind: "write",
        op: "deposit_and_borrow",
        asset: "AQUSDC",
        amount: 500,
        args: { leverage: 3, borrow_asset: "XLM" },
      },
    ]);
    expect(only.op).toBe("deposit_and_borrow");
    expect(only.borrow_asset).toBe("XLM");
    expect(only.amount).toBe(500);
    // And it survives the hand-off into the action the executor runs.
    expect(actionFromExpanded(only, { smartAccount: null, trader: null, minHf: null }).borrow_asset).toBe(
      "XLM",
    );
  });

  it("materialize turns cross-asset deposit_and_borrow into deposit + XLM borrow", () => {
    // THE LIVE BUG: expand left one deposit_and_borrow; the multi-leg loop ran deposit
    // only, dropped next_step, and declared the plan complete with debt $0.
    const raw = expandPlanWrites([
      {
        kind: "write",
        op: "deposit_and_borrow",
        asset: "AQUSDC",
        amount: 50,
        args: { leverage: 2, borrow_asset: "XLM" },
      },
    ]);
    expect(raw).toHaveLength(1);
    const mat = materializeLeverageWrites(raw, PRICES);
    expect(mat.ok).toBe(true);
    if (!mat.ok) return;
    expect(mat.writes).toHaveLength(2);
    expect(mat.writes[0].op).toBe("deposit_collateral");
    expect(mat.writes[0].asset).toBe("AQUSDC");
    expect(mat.writes[0].amount).toBe(50);
    expect(mat.writes[1].op).toBe("borrow");
    expect(mat.writes[1].asset).toBe("XLM");
    // $50 × (2−1) = $50 debt → XLM at 0.11
    expect(mat.writes[1].amount).toBeCloseTo(50 / 0.11, 4);
  });
});
