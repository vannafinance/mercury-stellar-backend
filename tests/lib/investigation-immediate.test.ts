import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  classifySocialLane: vi.fn(),
}));

vi.mock("@/lib/copilot/investigation/social-lane", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copilot/investigation/social-lane")>();
  return { ...actual, classifySocialLane: mocks.classifySocialLane };
});

import { immediateReply } from "@/lib/copilot/investigation/immediate";
import { isProductInvestigationTurn } from "@/lib/copilot/investigation/social-lane";

const SOCIAL_REPLY =
  "Hi — I’m Vanna Copilot. Ask about your margin account, Earn, Farm, or a move you want sized from live reads.";

beforeEach(() => {
  mocks.classifySocialLane.mockReset();
  mocks.classifySocialLane.mockResolvedValue({ lane: "social", reply: SOCIAL_REPLY });
});

afterEach(() => {
  mocks.classifySocialLane.mockReset();
});

/**
 * The gate that answers a turn with nothing to investigate.
 *
 * The risk here is not missing a greeting — it is swallowing a real instruction. So the
 * tests that matter most are the ones proving a financial request still falls through, even
 * when it is wrapped in pleasantries, and that those turns never wait on Flash-Lite.
 */
describe("turns answered without investigating", () => {
  it("answers a leftover greeting from Flash-Lite, not a canned blob", async () => {
    for (const text of ["hi", "Hi!", "hey", "heyy", "hello", "yo", "gm", "good morning", "thanks", "ok"]) {
      const reply = await immediateReply(text);
      expect(reply?.kind, text).toBe("greeting");
      expect(reply?.message, text).toBe(SOCIAL_REPLY);
      expect(mocks.classifySocialLane, text).toHaveBeenCalled();
    }
  });

  it("answers a capability question without reading the account", async () => {
    for (const text of ["what can you do", "what are you?", "how do you work", "help", "what is this"]) {
      expect((await immediateReply(text))?.kind, text).toBe("greeting");
    }
  });

  it("answers a swap capability question from the executable registry, including a misspelled venue", async () => {
    const reply = await immediateReply("Can You swap in Aquarious");
    expect(reply?.kind).toBe("capability");
    expect(reply?.message).toMatch(/Aquarius/i);
    expect(reply?.message).toMatch(/live quote/i);
    expect(await immediateReply("Can you swap 10 XLM to AQUSDC in Aquarius")).toBeNull();
    expect(mocks.classifySocialLane).not.toHaveBeenCalled();
  });

  it("does NOT swallow a real request that merely opens with a greeting", async () => {
    for (const text of [
      "hi, can I borrow 500 USDC",
      "hey what's my health factor",
      "hello — lend 10 XLM please",
      "thanks, now deposit 5 XLM as collateral",
    ]) {
      expect(await immediateReply(text), text).toBeNull();
    }
    expect(mocks.classifySocialLane).not.toHaveBeenCalled();
  });

  it("lets every ordinary product request through untouched", async () => {
    for (const text of [
      "what's my health factor?",
      "lend 10 XLM",
      "use my USDC and XLM to build a strategy so the health factor stays above 1.3",
      "swap 10 XLM to AQUSDC then add liquidity in Aquarius",
      "how is the USDC pool doing?",
    ]) {
      expect(await immediateReply(text), text).toBeNull();
    }
    expect(mocks.classifySocialLane).not.toHaveBeenCalled();
  });

  it("refuses an off-domain prompt with the firewall's message, before any model call", async () => {
    const reply = await immediateReply("write me a python script to sort a list");
    expect(reply?.kind).toBe("off_domain");
    expect(reply?.message).toMatch(/only help with Vanna Finance/);
    expect(mocks.classifySocialLane).not.toHaveBeenCalled();
  });

  it("greets rather than refusing, even though a greeting carries no product vocabulary", async () => {
    expect((await immediateReply("hi"))?.kind).toBe("greeting");
  });

  it("returns nothing for empty input, leaving the existing validation to speak", async () => {
    expect(await immediateReply("")).toBeNull();
    expect(await immediateReply("   ")).toBeNull();
    expect(mocks.classifySocialLane).not.toHaveBeenCalled();
  });

  it("does not treat a long leftover as a greeting when Lite says work", async () => {
    mocks.classifySocialLane.mockResolvedValue({ lane: "work", reply: "" });
    const long = `hi ${"there ".repeat(20)}`;
    expect(await immediateReply(long)).not.toMatchObject({ kind: "greeting" });
  });

  it("does not start investigation when Lite times out on a leftover greeting", async () => {
    mocks.classifySocialLane.mockResolvedValue(null);
    const reply = await immediateReply("hi");
    expect(reply?.kind).toBe("greeting");
    expect(reply?.message).toMatch(/Vanna Copilot/);
  });

  it("does not investigate an identity leftover on the live subject+signal path", async () => {
    const opts = { subject: "user", signal: AbortSignal.timeout(5_000) };
    for (const text of ["Hi who are you??", "who are you", "what can you do"]) {
      mocks.classifySocialLane.mockResolvedValue(null);
      expect((await immediateReply(text, opts))?.kind, `${text} timeout`).toBe("greeting");
      mocks.classifySocialLane.mockResolvedValue({ lane: "work", reply: "" });
      expect((await immediateReply(text, opts))?.kind, `${text} work`).toBe("greeting");
    }
    expect(await immediateReply("lend 10 XLM", opts)).toBeNull();
  });
});

describe("product turns skip the greeting model", () => {
  it("treats mixed greeting+task as investigation, not social", () => {
    expect(isProductInvestigationTurn("hi, can I borrow 500 USDC")).toBe(true);
    expect(isProductInvestigationTurn("lend 10 XLM")).toBe(true);
    expect(isProductInvestigationTurn("hi")).toBe(false);
    expect(isProductInvestigationTurn("heyy")).toBe(false);
    expect(isProductInvestigationTurn("yo")).toBe(false);
    expect(isProductInvestigationTurn("what can you do")).toBe(false);
    expect(isProductInvestigationTurn("who are you")).toBe(false);
    expect(isProductInvestigationTurn("Hi who are you??")).toBe(false);
    expect(isProductInvestigationTurn("BLUSDC")).toBe(true);
    expect(isProductInvestigationTurn("write me a python script to sort a list")).toBe(false);
  });
});
