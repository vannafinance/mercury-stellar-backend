import { describe, expect, it } from "vitest";
import { classifyCopilotEntry } from "@/lib/copilot/entry-lane";

describe("Copilot entry lanes", () => {
  it.each([
    "deposit 100 XLM as collateral",
    "borrow 20 XLM",
    "lend 10 XLM",
    "repay all my XLM debt",
    "remove my XLM position from Blend",
    "withdraw 100 XLM from Blend",
    "provide 10 XLM liquidity to Aquarius",
    "deposit 100 XLM, then borrow 20 BLUSDC and provide XLM/SOUSDC liquidity",
    "deposit 100 XLM into the margin account and borrow 2x BLUSDC and SOUSDC and then provide liquidity of BLUSDC in Blend and SOUSDC and XLM in Soroswap",
    "what is my health factor?",
    // An instruction with no amount is still an instruction: "all" is a size, not a goal.
    "withdraw all funds",
    "remove XLM position or USDC position from Blend farm",
  ])("routes a plain capability directly: %s", (message) => {
    expect(classifyCopilotEntry(message)).toBe("direct");
  });

  it.each([
    "build me a strategy that keeps health factor above 1.3",
    "where should I invest my funds?",
    "compare the rates and recommend the best pool",
    "borrow the maximum I can safely",
    "optimize my portfolio",
    "open a margin account",
  ])("routes strategy/dynamic workflows to investigation: %s", (message) => {
    expect(classifyCopilotEntry(message)).toBe("strategy");
  });

  it.each([
    "swap 10 XLM to AQUSDC",
    "trade 10 XLM for SOUSDC",
    "convert 10 XLM to AQUSDC",
  ])("keeps Swap on its existing strategy path: %s", (message) => {
    expect(classifyCopilotEntry(message)).toBe("strategy");
  });
});
