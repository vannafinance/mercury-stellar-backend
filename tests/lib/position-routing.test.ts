import { describe, it, expect } from "vitest";
import { routeMessage } from "@/lib/copilot/router";

/**
 * "What am I holding?" must be understood WITHOUT the model.
 *
 * These asks reached an answer only through Vertex. On a machine whose `gcloud auth login`
 * had lapsed, the model call threw, the keyword router had no rule for the word "position",
 * and the turn fell through to the closing `clarify` — so the reply was the capability
 * blurb ("I can help with market data…"), which reads like a hardcoded response because
 * from the user's side that is exactly what it is.
 *
 * The deterministic route is the fix, so these tests pin it: any phrasing of the question,
 * no model involved.
 */
describe("position / portfolio reads route without the LLM", () => {
  const asks = [
    "tell me all my current open position",
    // Same question, words swapped. This is the pair that behaved differently between two
    // machines and started the whole investigation.
    "tell me my all current open position",
    "show my positions",
    "what are my open positions",
    "my portfolio",
    "what's in my account",
    "what am i holding",
    "what do i own",
    "what am i farming",
    "show me my holdings",
    "what is my exposure",
  ];

  for (const ask of asks) {
    it(`routes "${ask}" to the whole-account position read`, () => {
      const routed = routeMessage(ask);
      expect(routed.kind, ask).toBe("read");
      if (routed.kind !== "read") return;
      expect(routed.template_id, ask).toBe("query_all_positions");
      expect(routed.requires_account, ask).toBe(true);
    });
  }

  it("is confident enough to skip the model — the template is on the fast-path allowlist", () => {
    // Mirrors the allowlist in handleChat. If the two ever diverge, the route exists but
    // still waits on Vertex, which is the bug this whole change is about.
    const routed = routeMessage("show my positions");
    expect(routed.kind).toBe("read");
    if (routed.kind !== "read") return;
    expect(
      [
        "query_all_earn_pools",
        "query_blend",
        "query_account_health",
        "query_prices_batch",
        "query_price",
        "query_pool_stats",
        "query_wallet_balance",
        "query_farm_overview",
        "query_all_positions",
        "query_blend_position",
        "query_collateral_config",
        "query_addresses",
        "query_resolve",
      ].includes(routed.template_id!),
    ).toBe(true);
  });
});

describe("the position route does not steal other intents", () => {
  it("leaves a named venue to that venue's own read", () => {
    // Naming Blend means the answer should be Blend's numbers, not a whole-account roll-up.
    // The router itself does not resolve this one (it never did — `handleChat`'s blendRead
    // override turns it into query_blend_position, deterministically, with no model). What
    // matters here is that the new rule does not claim it first.
    for (const ask of [
      "how much have i supplied to my blend position",
      "my aquarius lp position",
      "my btoken position",
    ]) {
      const routed = routeMessage(ask);
      if (routed.kind === "read") {
        expect(routed.template_id, ask).not.toBe("query_all_positions");
      }
    }
  });

  it("routes a Blend reserve read to Blend", () => {
    const routed = routeMessage("blend apy for my position");
    expect(routed.kind).toBe("read");
    if (routed.kind !== "read") return;
    expect(routed.template_id).toBe("query_blend");
  });

  it("does not answer an instruction with a summary", () => {
    // "Close my position" is a command. Replying with a position list would read as though
    // something had been done.
    const routed = routeMessage("close my position");
    if (routed.kind === "read") {
      expect(routed.template_id).not.toBe("query_all_positions");
    }
  });

  it("still routes a plain health question to the health read", () => {
    const routed = routeMessage("what is my health factor");
    expect(routed.kind).toBe("read");
    if (routed.kind !== "read") return;
    expect(routed.template_id).toBe("query_account_health");
  });

  it("still routes a write", () => {
    const routed = routeMessage("deposit 5 XLM as collateral");
    expect(routed.kind).toBe("write");
  });
});

describe("the generic fallback is tagged so it can be told apart from a real answer", () => {
  it("tags the capability blurb", () => {
    const routed = routeMessage("qwerty zxcvb asdfg");
    expect(routed.kind).toBe("clarify");
    if (routed.kind !== "clarify") return;
    // handleChat replaces this one — and only this one — with an explicit
    // "could not reach the model" when the Vertex call also failed.
    expect(routed.template_id).toBe("clarify_capabilities");
  });
});
