/**
 * Reported live: "What is my XLM Balance in Margin account?" answered "No XLM balance
 * figure is available because only the margin smart account address was resolved... its
 * token positions were not returned in this lookup." — it had been routed to
 * `query_resolve` (account-address resolution), not a real balance read. `query_resolve`'s
 * own match (`any(text, "resolve", "smart account", "margin account") && any(text, "look
 * up", "resolve", "find my", "what is my")`) is broad enough that ANY possessive question
 * mentioning "margin account" wins there, because no earlier branch had a pattern for
 * "<asset> balance ... in margin account" at all — `asksAboutOwnCollateral` required the
 * literal word "collateral", which this question never says.
 */
import { describe, expect, it } from "vitest";
import { routeMessage } from "@/lib/copilot/router";

describe("'<asset> balance in margin account' routes to a real balance read", () => {
  it("does not fall into query_resolve", () => {
    const r = routeMessage("What is my XLM Balance in Margin account?");
    expect(r.kind).toBe("read");
    if (r.kind === "read") {
      expect(r.template_id).not.toBe("query_resolve");
      expect(r.template_id).toBe("query_collateral");
    }
  });

  it("works for other assets and phrasing, not just this exact sentence", () => {
    for (const ask of [
      "What is my BLUSDC balance in margin account?",
      "what's my USDC balance in my margin account",
    ]) {
      const r = routeMessage(ask);
      expect(r.kind, ask).toBe("read");
      if (r.kind === "read") expect(r.template_id, ask).toBe("query_collateral");
    }
  });

  it("genuine account-resolution questions still route to query_resolve", () => {
    for (const ask of [
      "what is my smart account address",
      "resolve my margin account",
      "look up my smart account",
    ]) {
      const r = routeMessage(ask);
      expect(r.kind, ask).toBe("read");
      if (r.kind === "read") expect(r.template_id, ask).toBe("query_resolve");
    }
  });
});
