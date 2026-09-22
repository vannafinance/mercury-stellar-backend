import { describe, expect, it } from "vitest";
import { disagreesOnNewDebt, drawsNewDebt } from "@/lib/copilot/leg-direction";

/**
 * Live, 23 Sep, auto-approve on, one click from executing: "lend me 50xlm" was understood as
 * "Borrow 50 XLM on margin" while the deterministic extractor read the same words as `lend`.
 *
 * The axis is read from OP_FLOW, so an op nobody enumerated here is still classified.
 */
describe("two readings that disagree about creating debt", () => {
  it("knows which ops draw new debt, from OP_FLOW and not from a list", () => {
    expect(drawsNewDebt("borrow")).toBe(true);
    expect(drawsNewDebt("lend")).toBe(false);
    expect(drawsNewDebt("repay")).toBe(false);
    expect(drawsNewDebt("deposit_collateral")).toBe(false);
  });

  it("catches the live case: lend read as borrow", () => {
    expect(disagreesOnNewDebt("lend", "borrow")).toBe(true);
  });

  it("does not fire when both readings agree about debt", () => {
    expect(disagreesOnNewDebt("lend", "lend")).toBe(false);
    // Different destination, same answer on debt — "put money in" either way. Asking here
    // would cost more than the mistake, which is the whole reason this axis is narrow.
    expect(disagreesOnNewDebt("lend", "deposit_collateral")).toBe(false);
    expect(disagreesOnNewDebt("supply_blend", "lend")).toBe(false);
    expect(disagreesOnNewDebt("repay", "withdraw_collateral")).toBe(false);
  });

  it("is symmetric — neither reading is privileged", () => {
    expect(disagreesOnNewDebt("borrow", "lend")).toBe(disagreesOnNewDebt("lend", "borrow"));
  });

  it("stays silent on an op it cannot place, rather than guessing", () => {
    expect(disagreesOnNewDebt("borrow", "not_an_op")).toBe(false);
    expect(drawsNewDebt("not_an_op")).toBe(false);
  });

  /**
   * Un-enumerated input: `deploy_to_blend` is a planner spelling that OP_FLOW does not carry
   * under that name. It resolves through the alias table, so the axis holds for a spelling
   * this test file never taught it.
   */
  it("holds for a planner spelling it was never given directly", () => {
    expect(drawsNewDebt("deploy_to_blend")).toBe(false);
    expect(disagreesOnNewDebt("deploy_to_blend", "borrow")).toBe(true);
    expect(disagreesOnNewDebt("deploy_to_blend", "lend")).toBe(false);
  });
});
