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
    expect(catalogEntry("max_borrow")?.cost).toBe("moderate");
    expect(readDeadlineMs(15_000, catalogEntry("max_borrow")?.cost)).toBeGreaterThan(19_000);
    expect(readDeadlineMs(15_000, catalogEntry("asset_price")?.cost)).toBe(15_000);
  });
});
