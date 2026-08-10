import { describe, expect, it } from "vitest";
import { applyFraction, findBalanceFraction } from "@/lib/copilot/amount-intent";
import { routeMessage } from "@/lib/copilot/router";
import { slotsToAction } from "@/lib/copilot/registry/intent";

const CTX = { smartAccount: null, trader: null };

describe("findBalanceFraction — a share of a balance is a size", () => {
  it("reads an explicit percentage", () => {
    expect(findBalanceFraction("deposit 50% of the XLM in my wallet")).toBe(0.5);
    expect(findBalanceFraction("supply 10% of my BLUSDC")).toBe(0.1);
    expect(findBalanceFraction("supply 100% of my BLUSDC")).toBe(1);
  });

  it("reads half and quarter", () => {
    expect(findBalanceFraction("lend half my XLM")).toBe(0.5);
    expect(findBalanceFraction("deposit a quarter of my wallet XLM")).toBe(0.25);
  });

  it("reads all/max only when the sentence names the balance it is a share of", () => {
    expect(findBalanceFraction("supply all my XLM to earn")).toBe(1);
    expect(findBalanceFraction("lend max XLM from my wallet")).toBe(1);
    expect(findBalanceFraction("deposit everything I have")).toBe(1);
  });

  /**
   * The reason this is stricter than findAmountFraction. "max yield" is a ranking
   * preference the router already understands; reading it as a size would move a whole
   * wallet into a pool on a prompt that never stated an amount.
   */
  it("never turns a yield superlative into 100% of a wallet", () => {
    expect(findBalanceFraction("invest for max yield")).toBeNull();
    expect(findBalanceFraction("put my money in the pool with the maximum apy")).toBeNull();
    expect(findBalanceFraction("earn me the best return")).toBeNull();
    expect(findBalanceFraction("lend 25 XLM")).toBeNull();
  });

  it("still sizes when a size and a ranking preference appear together", () => {
    expect(findBalanceFraction("invest all my USDC for max profit")).toBe(1);
  });

  it("rejects an out-of-range percentage rather than guessing", () => {
    expect(findBalanceFraction("supply 250% of my XLM")).toBeNull();
    expect(findBalanceFraction("supply 0% of my XLM")).toBeNull();
  });
});

describe("applyFraction — floors to Stellar's 7dp, never rounds up past the balance", () => {
  it("floors rather than rounding", () => {
    // 9850.8085671 / 3 would round up at 7dp; the chip must never exceed the balance.
    expect(applyFraction(9850.8085671, 0.5)).toBe(4925.4042835);
    expect(applyFraction(1.99999999, 1)).toBe(1.9999999);
  });

  it("is zero for a non-positive balance or fraction", () => {
    expect(applyFraction(0, 0.5)).toBe(0);
    expect(applyFraction(-5, 0.5)).toBe(0);
    expect(applyFraction(100, 0)).toBe(0);
    expect(applyFraction(Number.NaN, 0.5)).toBe(0);
  });

  it("caps a fraction above 1 at the whole balance", () => {
    expect(applyFraction(100, 2)).toBe(100);
  });
});

describe("routeMessage — a stated share survives as a fraction slot", () => {
  /** The owner's reported failure: answered with "How much XLM do you want to supply?" */
  it("deposit XLM 50% of XLM in my wallet into the XLM pool → lend, fraction 0.5, no amount ask", () => {
    const r = routeMessage("deposit XLM 50% of XLM in my wallet into the XLM pool");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("lend");
    expect(r.asset).toBe("XLM");
    expect(r.amount).toBeNull();
    expect(r.fraction).toBe(0.5);
    expect(r.requires_amount).toBe(false);
  });

  it("deposit 25% of my XLM as collateral → deposit_collateral with a fraction", () => {
    const r = routeMessage("deposit 25% of my XLM in my wallet as collateral");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("deposit_collateral");
    expect(r.fraction).toBe(0.25);
    expect(r.requires_amount).toBe(false);
  });

  it("withdraw half my XLM collateral → withdraw_collateral with a fraction", () => {
    const r = routeMessage("withdraw half my XLM collateral");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("withdraw_collateral");
    expect(r.fraction).toBe(0.5);
    expect(r.requires_amount).toBe(false);
  });

  it("an explicit number still wins over any fraction reading", () => {
    const r = routeMessage("lend 10 XLM into the earn pool");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.amount).toBe(10);
    expect(r.fraction).toBeNull();
  });

  it("a sizeless supply still asks, so no amount is ever invented", () => {
    const r = routeMessage("supply XLM to the earn pool");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.amount).toBeNull();
    expect(r.fraction).toBeNull();
    expect(r.requires_amount).toBe(true);
  });
});

describe("swap — the Trade/Spot 25/50/75/Max meter, in language", () => {
  it("swap half my XLM to USDC → fraction 0.5, no amount ask", () => {
    const r = routeMessage("swap half my XLM to USDC");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.op).toBe("swap");
    expect(r.amount).toBeNull();
    expect(r.fraction).toBe(0.5);
    expect(r.requires_amount).toBe(false);
  });

  it("swap 75% of my XLM to USDC → fraction 0.75", () => {
    const r = routeMessage("swap 75% of my XLM to USDC");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.fraction).toBe(0.75);
  });

  it("an explicit amount still wins", () => {
    const r = routeMessage("swap 10 XLM to USDC");
    expect(r.kind).toBe("write");
    if (r.kind !== "write") return;
    expect(r.amount).toBe(10);
    expect(r.fraction).toBeNull();
  });
});

describe("slotsToAction — a fraction counts as a size for balance-sized ops", () => {
  for (const op of ["lend", "deposit_collateral", "withdraw_collateral", "repay", "remove_liquidity"]) {
    it(`${op} with a fraction needs no amount`, () => {
      expect(slotsToAction(op, { asset: "XLM", fraction: 0.5 }, CTX).requires_amount).toBe(false);
    });
  }

  it("an op with no single balance to divide still requires an amount", () => {
    expect(slotsToAction("borrow", { asset: "XLM", fraction: 0.5 }, CTX).requires_amount).toBe(true);
  });
});
