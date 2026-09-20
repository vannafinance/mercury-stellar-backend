import { describe, expect, it } from "vitest";
import { bindProse, formatFactValue } from "@/lib/copilot/investigation/answer-prose";
import type { ResearchFact } from "@/lib/copilot/investigation/view";

/**
 * The model phrases; code supplies every figure.
 *
 * Answers are composed from fixed templates today, which is why "what is my Blend supply?"
 * reads as `Blend: XLM 122.6934092, USDC 0.` — the data is derived but the sentence is
 * written in code, so every new case needs another template. Handing the whole answer to
 * the model would fix the prose and break the thing that matters: on 20 Sep an answer
 * attached a b-rate to an XLM label and called it a balance, and a model free to type
 * digits can do that on purpose.
 *
 * What is pinned here is the division: a template may say anything about the facts and
 * nothing about their values. A citation of a fact nobody read, or a digit the model typed
 * itself, is refused — so the caller keeps its deterministic sentence rather than
 * publishing an unbacked number.
 */

const fact = (over: Partial<ResearchFact> = {}): ResearchFact => ({
  id: "e1:positions[0].balance",
  label: "BLUSDC Blend supply",
  value: "122.6934092",
  unit: "BLUSDC",
  venue: "blend",
  evidenceId: "e1",
  sourcePath: "positions[0].balance",
  readAt: 1_700_000_000_000,
  ...over,
});

describe("prose bound to audited facts", () => {
  it("lets the model choose the words and fills in the value", () => {
    const result = bindProse(
      "Your Blend supply is {{e1:positions[0].balance}}, all of it in one pool.",
      [fact()],
    );
    expect(result.ok).toBe(true);
    expect(result.text).toBe("Your Blend supply is 122.6934092 BLUSDC, all of it in one pool.");
  });

  it("formats a USD fact as money, matching the deterministic path", () => {
    const usd = fact({ id: "e2:total_usd", unit: "USD", value: "1668.394" });
    expect(formatFactValue(usd)).toBe("$1,668.39");
    const result = bindProse("You have {{e2:total_usd}} deployed.", [usd]);
    expect(result.text).toBe("You have $1,668.39 deployed.");
  });

  it("refuses a template citing a fact nobody read", () => {
    const result = bindProse("Your Aquarius position is {{e9:made.up}}.", [fact()]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not read/);
  });

  it("refuses a template in which the model typed a figure itself", () => {
    // The dangerous shape: a real citation beside an invented number, which reads as
    // though both came from the same read.
    const result = bindProse(
      "Your Blend supply is {{e1:positions[0].balance}}, earning 4.2% a year.",
      [fact()],
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/wrote itself/);
  });

  it("allows prose with no figures at all", () => {
    const result = bindProse("Nothing is supplied to Blend right now.", [fact()]);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("Nothing is supplied to Blend right now.");
  });

  it("refuses an empty template rather than publishing a blank answer", () => {
    expect(bindProse("   ", [fact()]).ok).toBe(false);
  });
});
