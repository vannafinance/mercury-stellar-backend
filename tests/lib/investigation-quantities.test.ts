import { describe, expect, it } from "vitest";
import { isTokenAmountIn, leverageFrom, percentFrom, quantitySpans } from "@/lib/copilot/investigation/quantities";
import { compileLeverageWrites } from "@/lib/copilot/investigation/leverage-compile";
import type { InvestigationScope } from "@/lib/copilot/investigation/types";

const SCOPE: InvestigationScope = {
  subject: "user",
  trader: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
  smartAccount: "CDNGNLGLM5PK4PQ2XDA66W7JDQT3FKDLDGJ7XOBHQXEVRQR5U4PJFV3C",
  network: "testnet",
};

describe("quantity kinds", () => {
  it("treats Nx as leverage and 5xlm as tokens", () => {
    expect(leverageFrom("borrow 2x aqusdc")).toBe(2);
    expect(leverageFrom("lever 3× into sousdc")).toBe(3);
    expect(leverageFrom("deposit me 5xlm")).toBeNull();
    expect(isTokenAmountIn("deposit me 5xlm", "5")).toBe(true);
    expect(isTokenAmountIn("borrow 2x aqusdc", "2")).toBe(false);
    expect(percentFrom("use 40% of idle")).toBe(40);
    expect(quantitySpans("2x")[0]?.kind).toBe("leverage");
  });
});

describe("compileLeverageWrites", () => {
  it("sizes a 3x into a named asset when the planner only nominated the deposit", async () => {
    const message = "put 10 xlm in and lever 3x into sousdc";
    const result = await compileLeverageWrites({
      goal: {
        intent: "strategy",
        objective: message,
        constraints: [],
        borrowing: "required",
        actions: [
          { op: "deposit_collateral", asset: "XLM", amount: "10", sourceQuote: "10 xlm" },
        ],
      },
      messages: [message],
      scope: SCOPE,
      mcp: { call: async () => ({}) },
      prices: { XLM: 0.18 },
    });
    expect(result).not.toBeNull();
    expect(result!.leverage).toBe(3);
    expect(result!.steps).toHaveLength(2);
    expect(result!.steps[0]).toMatchObject({ op: "deposit_collateral", asset: "XLM", amount: "10" });
    const borrow = result!.steps[1];
    expect(borrow.op).toBe("borrow");
    expect(borrow.asset).toBe("SOUSDC");
    // 10 XLM * 0.18 * (3-1) = 3.6 SOUSDC, not a token '3'
    expect(Number(borrow.amount)).toBeCloseTo(3.6, 2);
  });

  it("returns null instead of a deposit-only plan when prices are missing", async () => {
    const message = "put 10 xlm in and lever 3x into sousdc";
    const result = await compileLeverageWrites({
      goal: {
        intent: "strategy",
        objective: message,
        constraints: [],
        borrowing: "required",
        actions: [
          { op: "deposit_collateral", asset: "XLM", amount: "10", sourceQuote: "10 xlm" },
        ],
      },
      messages: [message],
      scope: SCOPE,
      mcp: { call: async () => ({}) },
      prices: {},
    });
    expect(result).toBeNull();
  });

  it("sizes dual 2x on a 5 XLM deposit like the Margin Dual Borrow control", async () => {
    const message = "put 10 xlm in and lever 2× into aqusdc and blusdc";
    const result = await compileLeverageWrites({
      goal: {
        intent: "strategy",
        objective: message,
        constraints: [],
        borrowing: "required",
        actions: [
          { op: "deposit_collateral", asset: "XLM", amount: "10", sourceQuote: "10 xlm" },
          { op: "borrow", asset: "AQUSDC", amount: "2", sourceQuote: "2×" },
          { op: "borrow", asset: "BLUSDC", amount: "2", sourceQuote: "2×" },
        ],
      },
      messages: [message],
      scope: SCOPE,
      mcp: { call: async () => ({}) },
      prices: { XLM: 0.182 },
      grossCollateralUsd: "1089.59",
      debtUsd: "279.56",
    });
    expect(result).not.toBeNull();
    expect(result!.leverage).toBe(2);
    expect(result!.steps).toHaveLength(3);
    expect(result!.steps[0]).toMatchObject({ op: "deposit_collateral", asset: "XLM", amount: "10" });
    const aq = Number(result!.steps.find((step) => step.asset === "AQUSDC")?.amount);
    const bl = Number(result!.steps.find((step) => step.asset === "BLUSDC")?.amount);
    // depositUsd = 1.82; (L-1)=1; split 50/50 → 0.91 each. Not 2 tokens.
    expect(aq).toBeCloseTo(0.91, 2);
    expect(bl).toBeCloseTo(0.91, 2);
    expect(aq).not.toBe(2);
    /**
     * No floor was stated, so there is no projection — and that is the point. A health
     * factor is projected against the user's own floor; the liquidation line (1.10) is
     * not a floor, it is the threshold at which the account IS liquidatable
     * (`margin-health.ts`: `hf <= LIQUIDATION_THRESHOLD`). Sizing to it leaves zero
     * margin, so `capacity` returns null at or below it and nothing is projected here.
     * Sizing above stands on its own: it comes from the deposit and the multiple.
     */
    expect(result!.healthFactorAfter).toBeNull();
  });
});
