import { describe, expect, it } from "vitest";
import { readDeadlineMs } from "@/lib/copilot/investigation/runtime";
import { catalogEntry } from "@/lib/copilot/investigation/catalog";

/**
 * 8 Oct, live: "borrow the maximum I can safely" read max_borrow for four assets at once. Three answered in about 5 s,
 * the fourth in 19 s, past the flat 15 s limit, so the answer lost its figures and carried a raw "data was unavailable" note.
 * The allowance now follows the catalogue's own cost class for the read.
 */
describe("readDeadlineMs", () => {
  it("keeps the base limit for a cheap read and gives a moderate one twice as long", () => {
    expect(readDeadlineMs(15_000, "cheap")).toBe(15_000);
    expect(readDeadlineMs(15_000, "moderate")).toBe(30_000);
    expect(readDeadlineMs(15_000, "expensive")).toBe(45_000);
  });
  it("treats an unknown capability as cheap", () => {
    expect(readDeadlineMs(15_000, undefined)).toBe(15_000);
  });
  it("lets the 19 s fourth max_borrow read finish while a cheap read still gets 15 s", () => {
    expect(readDeadlineMs(15_000, catalogEntry("max_borrow")?.cost)).toBeGreaterThan(19_000);
    expect(readDeadlineMs(15_000, catalogEntry("asset_price")?.cost)).toBe(15_000);
  });
  /**
   * 24 Oct, live: "deposit 5 xlm and dual borrow blusdc and soudsdc at 3x leverage" stopped at a plan twice, both times
   * on the SOUSDC max_borrow read "exceeded its time limit". Measured against the same MCP: SOUSDC took 23.7 s alone and
   * 30.0 s beside three other searches (BLUSDC 4-8 s, XLM 7 s, AQUSDC 5 s) - the chain search for a deep pool - against a
   * 30 s allowance. The read that searches the chain for a ceiling is classed by what it costs, not by its neighbours.
   * (can_borrow and can_withdraw check one stated amount, are not searches and were not measured: they stay as they are.)
   */
  it("gives the ceiling search room for the 30 s the deepest pool was measured to take", () => {
    expect(readDeadlineMs(15_000, catalogEntry("max_borrow")?.cost)).toBeGreaterThan(30_000);
  });
});
