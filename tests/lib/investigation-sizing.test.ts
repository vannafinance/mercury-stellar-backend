import { describe, expect, it } from "vitest";
import {
  LIQUIDATION_THRESHOLD_WAD, maxBorrowForFloorWad, sizeLegs,
  type LegRequest,
} from "@/lib/copilot/investigation/sizing";
import { decimalWad, formatWad, WAD } from "@/lib/copilot/investigation/fixed";

/**
 * Deterministic sizing. No model output reaches this code, so every number here is
 * re-derivable from its inputs — which is the whole point of taking amounts away from
 * the model.
 *
 * The authoritative formula is dev's (`lib/margin-health.ts`): HF = gross/debt,
 * liquidation at HF <= 1.1. Borrowing raises BOTH sides, because the smart account
 * contract credits borrowed proceeds into its own collateral ledger; modelling a borrow
 * as debt-only is what cratered the displayed HF on dual-borrow positions.
 */

// The live authorised account at the ledger measured on 2026-09-08.
const BASE = { grossCollateralUsd: "4219.36", debtUsd: "1736.19" };

const leg = (op: LegRequest["op"], amountUsd: LegRequest["amountUsd"], label: string = op): LegRequest =>
  ({ op, amountUsd, label });

describe("maxBorrowForFloorWad", () => {
  it("solves the closed form exactly, counting the borrow on both sides", () => {
    // (G - F*D) / (F - 1) = (4219.36 - 2257.047) / 0.30 = 6541.043333...
    const max = maxBorrowForFloorWad(decimalWad("4219.36"), decimalWad("1736.19"), decimalWad("1.30"));
    expect(formatWad(max)).toBe("6541.043333333333333333");
  });

  it("lands exactly on the floor, never below it", () => {
    const gross = decimalWad("4219.36");
    const debt = decimalWad("1736.19");
    const floor = decimalWad("1.30");
    const max = maxBorrowForFloorWad(gross, debt, floor);
    // Truncating division can only round the size DOWN, so the resulting ratio is >= floor.
    const hfAfter = (gross + max) * WAD / (debt + max);
    expect(hfAfter >= floor).toBe(true);
    // And one whole unit more must breach it, proving the bound is tight.
    const oneMore = max + WAD;
    expect((gross + oneMore) * WAD / (debt + oneMore) < floor).toBe(true);
  });

  it("reports no capacity rather than a negative size when already at the floor", () => {
    // HF is exactly 1.30 here, so there is nothing left to borrow.
    expect(maxBorrowForFloorWad(decimalWad("1300"), decimalWad("1000"), decimalWad("1.30"))).toBe(BigInt(0));
    // And below the floor.
    expect(maxBorrowForFloorWad(decimalWad("1100"), decimalWad("1000"), decimalWad("1.30"))).toBe(BigInt(0));
  });

  it("refuses a floor at or below 1, where the algebra has no useful solution", () => {
    for (const bad of ["1", "0.5"]) {
      expect(() => maxBorrowForFloorWad(decimalWad("100"), decimalWad("10"), decimalWad(bad)))
        .toThrow("floor_must_exceed_one");
    }
  });

  it("gives unbounded-looking capacity a real bound when there is no debt", () => {
    // With no debt, capacity is G/(F-1): borrowing x makes HF = (G+x)/x.
    const max = maxBorrowForFloorWad(decimalWad("100"), BigInt(0), decimalWad("1.50"));
    expect(formatWad(max)).toBe("200");
    expect((decimalWad("100") + max) * WAD / max).toBe(decimalWad("1.5"));
  });
});

describe("sizeLegs", () => {
  it("projects a fixed borrow onto both sides and reports the resulting health factor", () => {
    const result = sizeLegs(BASE, [leg("borrow", "1000", "Borrow 1000 USDC")], "1.30");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.legs[0]).toMatchObject({
      amountUsd: "1000",
      grossAfterUsd: "5219.36",
      debtAfterUsd: "2736.19",
    });
    // 5219.36 / 2736.19 = 1.907...
    expect(result.finalHealthFactor?.slice(0, 5)).toBe("1.907");
  });

  it("sizes a max borrow to the floor and stops there", () => {
    const result = sizeLegs(BASE, [leg("borrow", "max", "Borrow as much as the floor allows")], "1.30");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.legs[0].amountUsd).toBe("6541.043333333333333333");
    // Exactly the floor, to the wei — the closed form does not overshoot and then trim.
    expect(result.finalHealthFactor).toBe("1.3");
  });

  it("rejects a plan that passes through a breach even when it ends healthy", () => {
    // Borrow far past the floor, then repay back to safety. The end state is fine; the
    // middle is not, and the chain does not wait for the sequence to finish.
    const result = sizeLegs(BASE, [
      leg("borrow", "20000", "Borrow 20000"),
      leg("repay", "20000", "Repay 20000"),
    ], "1.30");
    expect(result).toMatchObject({ ok: false, reason: "health_floor_breached", failingLeg: "Borrow 20000" });
    // The legs computed before the breach are still returned, so the reason is inspectable.
    if (!result.ok) expect(result.legs).toHaveLength(1);
  });

  it("counts a deposit as collateral only, raising the health factor", () => {
    const result = sizeLegs(BASE, [leg("deposit_collateral", "500", "Deposit 500")], "1.30");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.legs[0]).toMatchObject({ grossAfterUsd: "4719.36", debtAfterUsd: "1736.19" });
  });

  it("removes a repay from both sides, since the proceeds were collateral too", () => {
    const result = sizeLegs(BASE, [leg("repay", "700", "Repay 700")], "1.30");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.legs[0]).toMatchObject({ grossAfterUsd: "3519.36", debtAfterUsd: "1036.19" });
  });

  it("will not repay or withdraw more than exists", () => {
    expect(sizeLegs(BASE, [leg("repay", "99999", "Overpay")], "1.30"))
      .toMatchObject({ ok: false, reason: "repay_exceeds_debt", failingLeg: "Overpay" });
    expect(sizeLegs(BASE, [leg("withdraw_collateral", "99999", "Overdraw")], "1.30"))
      .toMatchObject({ ok: false, reason: "withdraw_exceeds_collateral", failingLeg: "Overdraw" });
  });

  it("catches a withdrawal that breaches the floor", () => {
    const result = sizeLegs(BASE, [leg("withdraw_collateral", "2000", "Withdraw 2000")], "1.30");
    expect(result).toMatchObject({ ok: false, reason: "health_floor_breached" });
  });

  it("treats a floor at or under the liquidation threshold as no margin at all", () => {
    // 1.1 is the threshold itself, and the contract is already unhealthy AT 1.1.
    for (const floor of ["1.1", "1.05"]) {
      expect(sizeLegs(BASE, [leg("borrow", "100")], floor))
        .toMatchObject({ ok: false, reason: "floor_below_liquidation_threshold" });
    }
    expect(formatWad(LIQUIDATION_THRESHOLD_WAD)).toBe("1.1");
  });

  it("does not apply the floor to a state with no debt left", () => {
    // Repaying everything leaves no debt, so there is no ratio to breach.
    const result = sizeLegs({ grossCollateralUsd: "1000", debtUsd: "100" },
      [leg("repay", "100", "Repay all")], "1.30");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.legs[0].healthFactorAfter).toBeNull();
    expect(result.finalHealthFactor).toBeNull();
  });

  it("rejects malformed input instead of coercing it to a number", () => {
    expect(sizeLegs({ grossCollateralUsd: "1e4", debtUsd: "100" }, [leg("borrow", "10")], "1.30"))
      .toMatchObject({ ok: false, reason: "invalid_base_or_floor" });
    expect(sizeLegs(BASE, [leg("borrow", "-10")], "1.30"))
      .toMatchObject({ ok: false, reason: "invalid_leg_amount" });
    expect(sizeLegs(BASE, [leg("borrow", "0")], "1.30"))
      .toMatchObject({ ok: false, reason: "zero_leg_amount" });
    expect(sizeLegs(BASE, [], "1.30")).toMatchObject({ ok: false, reason: "no_legs" });
    expect(sizeLegs(BASE, Array(9).fill(leg("borrow", "1")), "1.30"))
      .toMatchObject({ ok: false, reason: "too_many_legs" });
  });

  it("only accepts max on a borrow, where the bound is defined", () => {
    expect(sizeLegs(BASE, [leg("deposit_collateral", "max", "Deposit everything")], "1.30"))
      .toMatchObject({ ok: false, reason: "max_only_supported_for_borrow" });
  });

  it("keeps full decimal precision through a multi-leg sequence", () => {
    const result = sizeLegs({ grossCollateralUsd: "1000.000000000000000001", debtUsd: "1" }, [
      leg("deposit_collateral", "0.000000000000000001", "Dust deposit"),
      leg("borrow", "1", "Borrow 1"),
    ], "1.30");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.legs[0].grossAfterUsd).toBe("1000.000000000000000002");
    expect(result.legs[1]).toMatchObject({ grossAfterUsd: "1001.000000000000000002", debtAfterUsd: "2" });
  });
});
