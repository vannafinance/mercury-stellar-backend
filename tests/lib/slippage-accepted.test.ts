/**
 * The user accepting a bad price is a decision they STATE, located by the model and
 * verified against their own words — not inferred from their prose, and not inferred
 * for them at all.
 *
 * ## The live failure this pins
 *
 * 16 Sep: "Swap 100 XLM for SOUSDC and i dont care if i loss please swap anywayu".
 * The model understood it perfectly and wrote "User explicitly accepts potential
 * loss/slippage" onto the card — into `constraints`, a free-text list nothing
 * downstream reads. So the sizer still refused the thin-pool fill, the pre-write
 * re-quote still refused it, and the MCP still withheld auto-sign: three guards all
 * declining a trade the user had plainly agreed to, with no way for them to lift it.
 *
 * The fix is the same shape as `amountAsset` and `healthFactorFloor`: give the model a
 * FIELD to state the decision in, and verify the quote against the real message. What
 * must never happen is the opposite — consent conjured from a paraphrase.
 */
import { describe, expect, it } from "vitest";
import { anchoredSlippageAccepted } from "@/lib/copilot/investigation/floor";

const PROMPT = "Swap 100 XLM for SOUSDC and i dont care if i loss please swap anywayu";

describe("anchoredSlippageAccepted", () => {
  it("accepts when the model quotes the user's own words", () => {
    expect(anchoredSlippageAccepted(
      { slippageAccepted: { accepted: true, sourceQuote: "i dont care if i loss please swap anywayu" } },
      [PROMPT],
    )).toBe(true);
  });

  it("rejects a quote the user never said — consent is not the model's to supply", () => {
    expect(anchoredSlippageAccepted(
      { slippageAccepted: { accepted: true, sourceQuote: "the user is fine with any price" } },
      [PROMPT],
    )).toBe(false);
  });

  it("rejects a paraphrase, however faithful", () => {
    expect(anchoredSlippageAccepted(
      { slippageAccepted: { accepted: true, sourceQuote: "I don't care if I lose, please swap anyway" } },
      [PROMPT],
    )).toBe(false);
  });

  it("is absent by default — the protective refusal holds unless asked to lift", () => {
    expect(anchoredSlippageAccepted({}, [PROMPT])).toBe(false);
    expect(anchoredSlippageAccepted(undefined, [PROMPT])).toBe(false);
    expect(anchoredSlippageAccepted(null, [PROMPT])).toBe(false);
  });

  it("does not accept `accepted: false` even with a real quote", () => {
    expect(anchoredSlippageAccepted(
      { slippageAccepted: { accepted: false, sourceQuote: "i dont care if i loss" } },
      [PROMPT],
    )).toBe(false);
  });
});

describe("parseDecision carries slippageAccepted", () => {
  const base = {
    kind: "research_complete",
    goal: { objective: "Swap 100 XLM", constraints: [], borrowing: "unspecified" as const },
    findings: [{ summary: "quoted", evidenceIds: [] }],
    openQuestions: [],
  };

  it("keeps a well-formed acceptance", async () => {
    const { parseDecision } = await import("@/lib/copilot/investigation/decision");
    const out = parseDecision({
      ...base,
      goal: { ...base.goal, slippageAccepted: { accepted: true, sourceQuote: "i dont care if i loss" } },
    });
    expect(out?.kind).toBe("research_complete");
    expect(out && "goal" in out ? out.goal.slippageAccepted : null)
      .toEqual({ accepted: true, sourceQuote: "i dont care if i loss" });
  });

  it("drops a malformed one rather than voiding the whole research", async () => {
    const { parseDecision } = await import("@/lib/copilot/investigation/decision");
    const out = parseDecision({
      ...base,
      goal: { ...base.goal, slippageAccepted: { accepted: true } },
    });
    expect(out?.kind).toBe("research_complete");
    expect(out && "goal" in out ? out.goal.slippageAccepted : "absent").toBeUndefined();
  });
});
