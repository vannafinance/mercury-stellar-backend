import { describe, expect, it } from "vitest";
import { clauseToStep } from "@/lib/copilot/step-extractor";

/**
 * "add" puts collateral in, exactly as "deposit" does.
 *
 * Live A/B on one account, 21 Sep, with the verb as the only difference:
 *
 *   "deposit 10 xlm and borrow with 6x leverage"  ->  Borrow 50 XLM, sized
 *   "add 10 xlm and borrow with 6x leverage"      ->  "How much USDC to borrow?"
 *
 * A clause needs BOTH a deposit verb and a borrow verb to become
 * `deposit_and_borrow`, and `expandLeveredWrites` gates leverage sizing on exactly
 * that op. With "add" unrecognised there was no deposit leg, so no merged op, so
 * `planLeverage` never ran — and the user was asked to type a number the margin page
 * derives instantly from the same collateral, leverage and oracle price.
 *
 * 10 XLM at 6x is a 50 XLM borrow (same-asset: deposit x (L-1)), which is what the
 * Margin page showed for the identical inputs.
 */

const global = { leverage: null, minHf: null };

describe("'add' is a deposit verb", () => {
  it("reads 'add N XLM and borrow at 6x' as one levered position, as 'deposit' already did", () => {
    const step = clauseToStep("add 10 xlm and borrow with 6x leverage", global);
    expect(step?.op).toBe("deposit_and_borrow");
    expect(step?.asset).toBe("XLM");
    expect(step?.amount).toBe(10);
    expect(step?.leverage).toBe(6);
  });

  it("agrees with the same sentence written with 'deposit'", () => {
    const added = clauseToStep("add 10 xlm and borrow with 6x leverage", global);
    const deposited = clauseToStep("deposit 10 xlm and borrow with 6x leverage", global);
    expect(added?.op).toBe(deposited?.op);
    expect(added?.asset).toBe(deposited?.asset);
    expect(added?.amount).toBe(deposited?.amount);
    expect(added?.leverage).toBe(deposited?.leverage);
  });

  it("reads a bare 'add N ASSET' as posting collateral", () => {
    const step = clauseToStep("add 250 AQUSDC as collateral", global);
    expect(step?.op).toBe("deposit_collateral");
    expect(step?.asset).toBe("AQUSDC");
    expect(step?.amount).toBe(250);
  });

  /**
   * The one other thing "add" means here. `hasAmmLpIntent` keeps it an LP write, so
   * widening the deposit verb cannot quietly turn a pool deposit into margin collateral.
   */
  it("does not steal 'add liquidity' from the LP path", () => {
    for (const clause of [
      "add liquidity on aquarius",
      "add 15 XLM and AQUSDC liquidity on aquarius",
      "provide 20 XLM and AQUSDC liquidity",
    ]) {
      const step = clauseToStep(clause, global);
      expect(step?.op).not.toBe("deposit_collateral");
      expect(step?.op).not.toBe("deposit_and_borrow");
    }
  });

  /**
   * Un-enumerated input: neither the verb pairing nor the asset below appears in the
   * fix, so this passing is evidence the rule generalises rather than matching a list.
   */
  it("generalises to a cross-asset levered add nobody enumerated", () => {
    const step = clauseToStep("add 500 AQUSDC at 3x and borrow XLM", global);
    expect(step?.op).toBe("deposit_and_borrow");
    expect(step?.asset).toBe("AQUSDC");
    expect(step?.amount).toBe(500);
    expect(step?.leverage).toBe(3);
  });

  it("leaves 'deposit into earn' as an Earn lend, not margin collateral", () => {
    const step = clauseToStep("add 40 XLM into the earn pool", global);
    expect(step?.op).not.toBe("deposit_collateral");
  });
});
