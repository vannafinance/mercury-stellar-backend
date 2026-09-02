/**
 * Live: "lend 1000 XLM, 100 BLUSDC, 100 SOUSDC, 100 AQUSDC" staged a single
 * "Lend 1000 BLUSDC". "Supply liquidity" with the same sizes was treated as
 * Aquarius AMM add_liquidity and rejected BLUSDC.
 *
 * Earn has four pools. Multiple sized earn assets + lend/supply is a 4-leg plan.
 */
import { describe, expect, it } from "vitest";
import { routeMessage } from "@/lib/copilot/router";

const LEND = "Can you lend 1000 XLM, 100 BLUSDC, 100 SOUSDC, 100 AQUSDC";
const SUPPLY =
  "Can you Supply Liquidity 1000 XLM & 100 BLUSDC & 100 SOUSDC & 100 AQUSDC";

function lendLegs(message: string) {
  const r = routeMessage(message);
  expect(r.kind, message).toBe("plan");
  if (r.kind !== "plan") return [];
  const writes = r.steps.filter((s) => s.kind === "write");
  expect(writes.map((s) => s.op)).toEqual(["lend", "lend", "lend", "lend"]);
  return writes.map((s) => ({ asset: s.asset, amount: s.amount }));
}

describe("lend and supply-liquidity across Earn pools are the same 4-leg plan", () => {
  it("lend names every pool at the stated size", () => {
    expect(lendLegs(LEND)).toEqual([
      { asset: "XLM", amount: 1000 },
      { asset: "BLUSDC", amount: 100 },
      { asset: "SOUSDC", amount: 100 },
      { asset: "AQUSDC", amount: 100 },
    ]);
  });

  it("supply liquidity with the same sizes is the same plan, not Aquarius LP", () => {
    expect(lendLegs(SUPPLY)).toEqual([
      { asset: "XLM", amount: 1000 },
      { asset: "BLUSDC", amount: 100 },
      { asset: "SOUSDC", amount: 100 },
      { asset: "AQUSDC", amount: 100 },
    ]);
  });

  it("two-sided add liquidity in Aquarius is still AMM, not two Earn lends", () => {
    const r = routeMessage("add 10 XLM and 10 AQUSDC to Aquarius");
    expect(r.kind).toBe("write");
    if (r.kind === "write") expect(r.op).toBe("add_liquidity");
  });
});
