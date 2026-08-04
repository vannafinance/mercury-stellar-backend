import { describe, it, expect } from "vitest";
import { normalizeAnswer, answerToText } from "@/lib/copilot/answer-schema";

/**
 * `receiptFacts` is module-private in vertex.ts (it needs a live token to reach through
 * `vertexSummarizeExecution`), so these assert the contract it has to satisfy: the shape it
 * emits must survive `normalizeAnswer` and flatten sensibly, since `message` carries the
 * same content for any surface without the renderer.
 */
describe("a receipt keeps its aggregate figures", () => {
  it("survives normalisation with facts intact", () => {
    const a = normalizeAnswer({
      headline: "Delta-neutral XLM carry is live.",
      facts: [
        { label: "steps settled", value: "4 of 4", tone: "good" },
        { label: "transactions", value: "4" },
        { label: "health factor", value: "1.62", tone: "warn" },
      ],
    });
    expect(a).not.toBeNull();
    expect(a!.facts).toHaveLength(3);
    expect(a!.facts[0]).toMatchObject({ label: "steps settled", value: "4 of 4", tone: "good" });
  });

  it("flattens to text that still states the outcome", () => {
    // The `message` field is what a surface without AnswerView shows, so the figures must
    // not live only in the rendered grid.
    const a = normalizeAnswer({
      headline: "Deposited 10 BLUSDC.",
      facts: [{ label: "steps settled", value: "1 of 4", tone: "bad" }],
    })!;
    const text = answerToText(a);
    expect(text).toContain("Deposited 10 BLUSDC.");
    expect(text).toContain("steps settled: 1 of 4");
  });

  it("drops a malformed fact rather than rendering a blank row", () => {
    const a = normalizeAnswer({
      headline: "ok",
      facts: [{ label: "steps settled", value: "2 of 3" }, { label: "", value: "x" }, { label: "y" }],
    })!;
    expect(a.facts).toHaveLength(1);
  });

  it("rejects an unknown tone instead of passing it to the renderer", () => {
    const a = normalizeAnswer({
      headline: "ok",
      facts: [{ label: "transactions", value: "2", tone: "catastrophic" }],
    })!;
    expect(a.facts[0].tone).toBeUndefined();
  });
});
