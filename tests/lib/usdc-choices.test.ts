import { describe, expect, it } from "vitest";
import { usdcChoicesFor } from "@/lib/copilot/investigation/plan";

describe("usdcChoicesFor", () => {
  it("re-sends the user's own request with each USDC variant swapped in", () => {
    const choices = usdcChoicesFor("Borrow 10 USDC");
    expect(choices.map((c) => c.id)).toEqual(["BLUSDC", "AQUSDC", "SOUSDC"]);
    expect(choices.map((c) => c.send)).toEqual(["Borrow 10 BLUSDC", "Borrow 10 AQUSDC", "Borrow 10 SOUSDC"]);
  });
  it("keeps punctuation around the word and replaces every bare occurrence", () => {
    expect(usdcChoicesFor("Swap usdc, then lend usdc?")[0].send).toBe("Swap BLUSDC, then lend BLUSDC?");
  });
  it("offers no chips when there is no bare USDC word to replace", () => {
    expect(usdcChoicesFor("Borrow 10 XLM")).toEqual([]);
    expect(usdcChoicesFor("Borrow 10 BLUSDC")).toEqual([]);
  });
});
