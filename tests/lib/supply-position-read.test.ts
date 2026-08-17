/**
 * "what is my total supply in earn section" executed a live `lend` write asking
 * which USDC variant, instead of answering the read question it actually was.
 * The old exclusion on the lend-write branch matched fixed substrings ("my
 * supply", "total supplied") — an adjective between "my" and "supply" ("my
 * TOTAL supply") broke the match, so the message fell straight into the write
 * branch. Separately, `asksAboutHoldings` (the "what do I hold" read) only
 * recognised "position"/"holdings" words, never "supply", so even once excluded
 * from the write branch these messages fell through to the generic capabilities
 * blurb instead of answering.
 */
import { describe, expect, it } from "vitest";
import { routeMessage } from "@/lib/copilot/router";

describe("a personal supply question reads the position, never writes", () => {
  it("answers 'what is my total supply in earn section'", () => {
    const r = routeMessage("what is my total supply in earn section");
    expect(r.kind).toBe("read");
    if (r.kind === "read") expect(r.template_id).toBe("query_all_positions");
  });

  it("answers 'how much have I supplied to earn'", () => {
    const r = routeMessage("how much have I supplied to earn");
    expect(r.kind).toBe("read");
    if (r.kind === "read") expect(r.template_id).toBe("query_all_positions");
  });

  it("still routes 'supply 10 XLM' as a real write", () => {
    const r = routeMessage("supply 10 XLM");
    expect(r.kind).toBe("write");
    if (r.kind === "write") expect(r.op).toBe("lend");
  });

  it("still routes 'lend 10 XLM' as a real write", () => {
    const r = routeMessage("lend 10 XLM");
    expect(r.kind).toBe("write");
    if (r.kind === "write") expect(r.op).toBe("lend");
  });

  it("still routes an instruction shaped 'supply my X' as a write, not a question", () => {
    const r = routeMessage("supply my XLM to earn");
    expect(r.kind).toBe("write");
    if (r.kind === "write") expect(r.op).toBe("lend");
  });

  it("does not steal a supply-APY pool-stat question", () => {
    const r = routeMessage("what's the supply APY on XLM");
    expect(r.kind).toBe("read");
    if (r.kind === "read") expect(r.template_id).toBe("query_pool_stats");
  });
});

/**
 * "some prompts are not running... my position in the earn or farm and whatever" —
 * a broader sweep beyond the one exact phrase above showed most everyday ways of
 * asking "how much do I have here" name no "position"/"holdings"/"supply" word at
 * all and fell through to the generic capabilities blurb. A fixed phrase list is
 * whack-a-mole against this; the shape is a quantity question word + a first-person
 * marker + a quantity noun + a named venue, in any order.
 */
describe("everyday phrasings of 'how much do I have in earn/farm' all resolve", () => {
  const phrasings = [
    "what's my position in earn",
    "how much do I have in farm",
    "what's in my earn account",
    "how much have I earned in earn section",
    "what's my farm position",
    "show me my earn balance",
    "my earn holdings",
    "how much am I earning in the earn section",
    "what's my total in farm",
  ];
  for (const p of phrasings) {
    it(`answers "${p}"`, () => {
      const r = routeMessage(p);
      expect(r.kind, p).toBe("read");
      if (r.kind === "read") expect(r.template_id, p).toBe("query_all_positions");
    });
  }

  it("still routes a Blend leveraged farm instruction as a write", () => {
    const r = routeMessage("farm Blend at 2x with 20 BLUSDC");
    expect(r.kind).toBe("write");
    if (r.kind === "write") expect(r.op).toBe("deploy_to_blend");
  });

  it("still routes a Blend reserve-stats question as its own read", () => {
    const r = routeMessage("how is the blend pool doing");
    expect(r.kind).toBe("read");
    if (r.kind === "read") expect(r.template_id).toBe("query_blend");
  });

  it("still routes an Aquarius liquidity question as a pool-stat read", () => {
    const r = routeMessage("how much liquidity is in the aquarius pool");
    expect(r.kind).toBe("read");
    if (r.kind === "read") expect(r.template_id).toBe("query_pool_stats");
  });
});
