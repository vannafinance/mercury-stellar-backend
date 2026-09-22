/**
 * Reported live, 21 Sep: a genuine question containing a write verb got mined for a
 * write step with a missing amount, instead of being answered.
 *
 *   - "can you tell me one thing supply to blend go through margin wallet or normal
 *     wallet" — contains "supply". The card asked "How much XLM do you want to supply
 *     to Blend?" for a question that named no amount at all.
 *   - "what is the best place to supply my USDC, earn or blend" — a comparison
 *     question. The clause splitter cut it on the comma into "what is the best place
 *     to supply my USDC" (mined for a write, again with "supply") and "earn or blend"
 *     (leftover residue). The card ended up paused mid-plan on "How much BLUSDC to
 *     deploy to blend?" with a fabricated default of 51 — for a question, not an
 *     instruction, that named no asset amount and no Blend venue at all.
 *
 * `clauseToStepSpannedRaw` matched on write-verb presence alone, with no regard for
 * whether the clause was phrased as a question. The fix: a clause opening with an
 * interrogative and naming no literal `amount asset` pair is never mined for a write,
 * whatever verb it also contains — see `QUESTION_OPENER` in step-extractor.ts. A
 * literal write ("supply 25 AQUSDC to earn") is untouched, since it always carries
 * the amount the guard checks for.
 */
import { describe, expect, it } from "vitest";
import { clauseToStep } from "@/lib/copilot/step-extractor";

const NO_GLOBAL = { leverage: null, minHf: null };

describe("a question is never mined for a write with a missing amount", () => {
  it("THE LIVE BUG: 'can you tell me ... supply to blend go through margin wallet or normal wallet'", () => {
    const step = clauseToStep(
      "can you tell me one thing supply to blend go through margin wallet or normal wallet",
      NO_GLOBAL,
    );
    expect(step).toBeNull();
  });

  it("THE LIVE BUG, half fixed: the first clause of 'what is the best place to supply my USDC, earn or blend' is no longer mined for a write", () => {
    // The clause splitter cuts this on the comma into two clauses. This pins the
    // first: "what is the best place to supply my USDC" no longer produces a false
    // `lend`/`deploy_to_blend` write. The second clause, "earn or blend", still
    // reaches a write through a DIFFERENT mechanism — unnamed-intent.ts's multi-goal
    // fallback re-routes the full original message through `routeMessage`, whose
    // Blend-deploy branch fires on "supply" appearing anywhere in that full text.
    // Closing that is a separate fix; this test only pins what THIS one covers.
    const step = clauseToStep("what is the best place to supply my USDC", NO_GLOBAL);
    expect(step).toBeNull();
  });

  it("other question openers with a write verb and no amount are not writes", () => {
    for (const ask of [
      "how much can I borrow",
      "what is the best way to repay my debt",
      "does supply to earn go through my wallet or the margin account",
      "should I deposit XLM as collateral",
    ]) {
      expect(clauseToStep(ask, NO_GLOBAL)).toBeNull();
    }
  });

  it("a literal write is untouched — it always carries the amount the guard checks for", () => {
    for (const [ask, op] of [
      ["deposit 100 XLM as collateral", "deposit_collateral"],
      ["supply 20 BLUSDC to blend", "deploy_to_blend"],
      ["what is my health factor" /* read-shaped, no write verb */, null],
    ] as const) {
      const step = clauseToStep(ask, NO_GLOBAL);
      if (op === null) {
        expect(step).toBeNull();
      } else {
        expect(step?.op).toBe(op);
      }
    }
  });

  it("a sizing phrase with no wh-opener is untouched", () => {
    // "borrow the maximum I can safely" has a write verb and no amount, same as the
    // bug shape — but it opens with the verb, not a question word, so it must still
    // extract as a write for the deterministic multi-leg path to size it.
    const step = clauseToStep("borrow the maximum I can safely", NO_GLOBAL);
    expect(step?.op).toBe("borrow");
  });
});
