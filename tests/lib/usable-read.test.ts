import { describe, expect, it } from "vitest";
import {
  claimedSet,
  isUsable,
  pricedUsd,
  requireListedResults,
  unavailable,
  usable,
} from "@/lib/usable-read";

describe("usable-read", () => {
  it("never prices a real amount at a missing or zero price", () => {
    expect(pricedUsd(1020.57, 0, "borrowed BLUSDC")).toEqual(
      unavailable("borrowed BLUSDC: missing or zero price"),
    );
    expect(pricedUsd(1020.57, Number.NaN, "borrowed BLUSDC").ok).toBe(false);
    expect(pricedUsd(0, 0, "borrowed BLUSDC")).toEqual(usable(0));
    expect(pricedUsd(1020.57, 1, "borrowed BLUSDC")).toEqual(usable(1020.57));
  });

  it("does not treat an empty collection as a verified negative", () => {
    expect(claimedSet([], "bindings_empty")).toEqual(unavailable("bindings_empty"));
    expect(isUsable(claimedSet(["GABC"], "bindings_empty"))).toBe(true);
  });

  it("refuses a listed identifier whose row never arrived", () => {
    expect(requireListedResults(
      ["XLM", "USDC"],
      { XLM: { amount: "1" } },
      (id) => `Incomplete debt read: ${id}`,
    )).toEqual(unavailable("Incomplete debt read: USDC"));
    expect(requireListedResults(
      ["XLM", "USDC"],
      { XLM: { amount: "1" }, USDC: { amount: "2" } },
      (id) => `Incomplete debt read: ${id}`,
    ).ok).toBe(true);
  });
});
