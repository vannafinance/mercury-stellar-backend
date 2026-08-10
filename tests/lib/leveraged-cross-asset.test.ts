/**
 * The share-sized levered deposit must work for EVERY collateral/loan pair, in both
 * directions — not just the XLM → BLUSDC case it was first found on.
 *
 * The merge and the sizing are asset-agnostic by construction (the share sizes the
 * collateral, the leverage sizes the loan against its USD value), so these tests exist to
 * hold that property down: a future special-case for one asset would break them.
 */
import { describe, expect, it } from "vitest";
import { coalesceLeveragedDepositBorrow } from "@/lib/copilot/step-extractor";
import { freezePlan } from "@/lib/copilot/plan-approval";
import { planLeverage } from "@/lib/copilot/leverage-plan";
import { slotsToAction } from "@/lib/copilot/registry/intent";

const ASSETS = ["XLM", "BLUSDC", "AQUSDC", "SOUSDC"] as const;

/** The shape coalesce accepts — spelled out so the generic keeps every optional slot. */
type Step = {
  kind: string;
  op: string;
  asset?: string | null;
  amount?: number | null;
  fraction?: number | null;
  leverage?: number | null;
  args?: Record<string, unknown>;
};

/** Every ordered collateral→loan pair of distinct assets, plus the same-asset cases. */
const PAIRS: Array<[string, string]> = [];
for (const a of ASSETS) for (const b of ASSETS) PAIRS.push([a, b]);

describe("coalesce — a share-sized levered deposit merges for every asset pair", () => {
  for (const [coll, loan] of PAIRS) {
    it(`${coll} collateral → ${loan} borrow at 2x merges into one deposit_and_borrow`, () => {
      const steps = coalesceLeveragedDepositBorrow<Step>(
        [
          { kind: "write", op: "deposit_collateral", asset: coll, fraction: 0.25 },
          { kind: "write", op: "borrow", asset: loan, amount: null },
        ],
        { leverage: 2, message: `deposit 25% of my ${coll} and borrow ${loan} at 2x` },
      );
      expect(steps).toHaveLength(1);
      expect(steps[0].op).toBe("deposit_and_borrow");
      expect(steps[0].asset).toBe(coll);
      expect(steps[0].leverage).toBe(2);
      expect(steps[0].args?.borrow_asset).toBe(loan);
      // The share survives the merge — it is what sizes the collateral half.
      expect(steps[0].args?.fraction).toBe(0.25);
    });
  }
});

describe("the approval card shows a share for every asset pair", () => {
  for (const [coll, loan] of PAIRS.filter(([a, b]) => a !== b)) {
    it(`${coll}/${loan} renders the share and warns about no missing amount`, () => {
      const merged = coalesceLeveragedDepositBorrow<Step>(
        [
          { kind: "write", op: "deposit_collateral", asset: coll, fraction: 0.5 },
          { kind: "write", op: "borrow", asset: loan, amount: null },
        ],
        { leverage: 3, message: `deposit half my ${coll} and borrow ${loan} at 3x` },
      );
      const frozen = freezePlan(
        { kind: "plan", template_id: "t", summary: "s", steps: merged } as never,
        Date.now(),
      );
      expect(frozen.steps).toHaveLength(1);
      expect(frozen.steps[0].fraction).toBe(0.5);
      // "no amount yet" must NOT fire — a share IS the amount.
      expect(frozen.warnings.join(" ")).not.toMatch(/no amount yet/i);
      // A levered step is still two signatures, whatever the assets are.
      expect(frozen.signature_count).toBe(2);
    });
  }
});

describe("a share satisfies requires_amount for every collateral asset", () => {
  for (const coll of ASSETS) {
    it(`deposit_and_borrow ${coll} with a fraction needs no amount`, () => {
      const a = slotsToAction(
        "deposit_and_borrow",
        { asset: coll, fraction: 0.25, leverage: 2, borrow_asset: "XLM" },
        { smartAccount: null, trader: null },
      );
      expect(a.requires_amount).toBe(false);
      expect(a.fraction).toBe(0.25);
    });
  }
});

/**
 * The borrow size itself is `deposit_value × (L − 1)`, converted through the oracle when
 * the two tokens differ — the same rule `borrow-box.tsx` uses. Verified here across pairs
 * so a cross-asset position cannot silently size like a same-asset one.
 */
describe("planLeverage sizes the loan from collateral VALUE, across assets", () => {
  // Stables resolve to $1 inside planLeverage, so only XLM needs an oracle reading.
  const prices: Record<string, number> = { XLM: 0.16 };

  const sized = (slots: Parameters<typeof planLeverage>[0]) => {
    const r = planLeverage(slots, prices);
    expect("gap" in r, JSON.stringify(r)).toBe(false);
    return "gap" in r ? null : r.plan;
  };

  it("same-asset 2x borrows one times the deposit", () => {
    const p = sized({ collateralAsset: "BLUSDC", collateralAmount: 100, leverage: 2 });
    expect(p?.borrowAmount).toBeCloseTo(100, 6);
    expect(p?.crossAsset).toBe(false);
  });

  it("XLM collateral, USD-stable loan converts through price", () => {
    // 1000 XLM × $0.16 = $160 of equity; 2x ⇒ borrow $160 ⇒ 160 BLUSDC.
    const p = sized({
      collateralAsset: "XLM",
      collateralAmount: 1000,
      leverage: 2,
      borrowAsset: "BLUSDC",
    });
    expect(p?.borrowAmount).toBeCloseTo(160, 4);
    expect(p?.crossAsset).toBe(true);
  });

  it("stable collateral, XLM loan converts the other way", () => {
    // 100 BLUSDC = $100; 3x ⇒ borrow $200 ⇒ 1250 XLM at $0.16.
    const p = sized({
      collateralAsset: "BLUSDC",
      collateralAmount: 100,
      leverage: 3,
      borrowAsset: "XLM",
    });
    expect(p?.borrowAmount).toBeCloseTo(1250, 4);
  });

  it("two different stables still size 1:1 by value", () => {
    const p = sized({
      collateralAsset: "AQUSDC",
      collateralAmount: 250,
      leverage: 2,
      borrowAsset: "SOUSDC",
    });
    expect(p?.borrowAmount).toBeCloseTo(250, 6);
  });
});
