import { describe, expect, it } from "vitest";
import { normalizeResearchFacts } from "@/lib/copilot/investigation/normalize";
import { factualAnswer } from "@/lib/copilot/investigation/answer";
import type { Observation } from "@/lib/copilot/investigation/types";

/**
 * 24 Oct, live: asked for "the supply APY, borrow APY and utilization for all four lending pools", the written reply
 * timed out (Gemini's tail) and the plain fallback printed supply rates only, plus a line "XLM Earn total liquidity:
 * 42,690.19 XLM" nobody asked for. On the Earn page the same pool shows 120.47K supplied and 77.78K borrowed: 42,690 is
 * what is LEFT (supplied minus borrowed), so "total liquidity" read as a disagreement with the page.
 * The payloads are the real ones, read from the MCP that day.
 */
const read = (asset: string, id: string, data: Record<string, unknown>): Observation =>
  ({ id, capability: "earn_market", args: { asset }, observedAt: 1000, status: "ok", data });
const RATE_BASIS = { supply: "apr", borrow: "apr", compounding: "not_assumed" };
const XLM = read("XLM", "e1", {
  pool_symbol: "XLM", utilization_pct: "64.563700", borrow_apr_pct: "22.597356737507227200", supply_apr_pct: "14.589689",
  supply_apy_pct: "14.589689", rate_basis: RATE_BASIS, total_liquidity_human: "42690.194958100000000000",
  total_borrows_human: "77780.360227144374781674", total_assets_human: "120470.555185244374781674",
});
const SOUSDC = read("SOUSDC", "e2", {
  pool_symbol: "SOUSDC", utilization_pct: "34.890000", borrow_apr_pct: "12.210000", supply_apr_pct: "4.260000",
  supply_apy_pct: "4.260000", rate_basis: RATE_BASIS, total_liquidity_human: "108452.670000", total_borrows_human: "58139.010000", total_assets_human: "166591.680000",
});
const ASK = "Show the supply APY, borrow APY and utilization for all four Vanna lending pools.";
const facts = () => normalizeResearchFacts([XLM, SOUSDC]).facts;

describe("the plain answer for pool rates", () => {
  it("names what the liquidity figure is: what is left to borrow, never a total", () => {
    const liquidity = facts().find((fact) => fact.evidenceId === "e1" && fact.sourcePath === "total_liquidity_human");
    expect(liquidity?.label).toMatch(/available/i);
    expect(liquidity?.label).not.toMatch(/total/i);
  });

  it("carries the supply rate, the borrow rate and the utilization of every pool it read", () => {
    const text = factualAnswer(facts(), ASK) ?? "";
    expect(text).toMatch(/Supply[^.\n]*XLM[^.\n]*14\.59%[^.\n]*SOUSDC[^.\n]*4\.26%/i);
    expect(text).toMatch(/Borrow[^.\n]*XLM[^.\n]*22\.60%[^.\n]*SOUSDC[^.\n]*12\.21%/i);
    expect(text).toMatch(/Utilization[^.\n]*XLM[^.\n]*64\.56%[^.\n]*SOUSDC[^.\n]*34\.89%/i);
  });

  it("does not call anything a total liquidity", () => {
    expect(factualAnswer(facts(), ASK) ?? "").not.toMatch(/total liquidity/i);
  });
});
