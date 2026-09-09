import { describe, expect, it } from "vitest";
import { immediateReply } from "@/lib/copilot/investigation/immediate";

/**
 * The gate that answers a turn with nothing to investigate.
 *
 * The risk here is not missing a greeting — it is swallowing a real instruction. So the
 * tests that matter most are the ones proving a financial request still falls through, even
 * when it is wrapped in pleasantries or phrased as a question about capability.
 */
describe("turns answered without investigating", () => {
  it("answers a bare greeting with what the surface actually does", () => {
    for (const text of ["hi", "Hi!", "hey", "heyy", "hello", "yo", "gm", "good morning", "thanks", "ok"]) {
      const reply = immediateReply(text);
      expect(reply?.kind, text).toBe("greeting");
      expect(reply?.message).toMatch(/Vanna copilot/);
      // It says what to try, so the answer moves the user forward.
      expect(reply?.message).toMatch(/health factor/);
    }
  });

  it("answers a capability question without reading the account", () => {
    for (const text of ["what can you do", "what are you?", "how do you work", "help", "what is this"]) {
      expect(immediateReply(text)?.kind, text).toBe("greeting");
    }
  });

  it("does NOT swallow a real request that merely opens with a greeting", () => {
    // The whole failure mode: answering this with an introduction drops the borrow.
    for (const text of [
      "hi, can I borrow 500 USDC",
      "hey what's my health factor",
      "hello — lend 10 XLM please",
      "thanks, now deposit 5 XLM as collateral",
    ]) {
      expect(immediateReply(text), text).toBeNull();
    }
  });

  it("lets every ordinary product request through untouched", () => {
    for (const text of [
      "what's my health factor?",
      "lend 10 XLM",
      "use my USDC and XLM to build a strategy so the health factor stays above 1.3",
      "swap 10 XLM to AQUSDC then add liquidity in Aquarius",
      "how is the USDC pool doing?",
    ]) {
      expect(immediateReply(text), text).toBeNull();
    }
  });

  it("refuses an off-domain prompt with the firewall's message, before any model call", () => {
    const reply = immediateReply("write me a python script to sort a list");
    expect(reply?.kind).toBe("off_domain");
    expect(reply?.message).toMatch(/only help with Vanna Finance/);
  });

  it("greets rather than refusing, even though a greeting carries no product vocabulary", () => {
    // The firewall would reject "hi" for having no domain terms; greeting someone with a
    // refusal is the wrong answer, so the greeting check runs first.
    expect(immediateReply("hi")?.kind).toBe("greeting");
  });

  it("returns nothing for empty input, leaving the existing validation to speak", () => {
    expect(immediateReply("")).toBeNull();
    expect(immediateReply("   ")).toBeNull();
  });

  it("does not treat a long message as a greeting because it starts with one", () => {
    const long = `hi ${"there ".repeat(20)}`;
    expect(immediateReply(long)).not.toMatchObject({ kind: "greeting" });
  });
});
