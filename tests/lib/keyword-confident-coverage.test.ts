/**
 * A deterministic read route is only actually deterministic if it is TRUSTED — every bug
 * this test guards against had the router already producing the right answer, with
 * Vertex re-deciding the message from scratch anyway and occasionally landing somewhere
 * else ("swap 10 XLM to USDC" losing its own "which USDC?" clarify; "What is Balance of
 * XLM in my Margin Account" falling to the generic blurb while the fixed test phrasing
 * for the identical question worked).
 *
 * This used to be an opt-IN allowlist (`KEYWORD_CONFIDENT_READ_TEMPLATES`), and this
 * exact test — checking that list against what the router actually produces — found
 * five more reads in the same broken state in one pass. An opt-in list finds gaps one
 * at a time forever, because "forgot to add the new route" leaves no trace. The
 * allowlist was flipped to an opt-OUT one (`VERTEX_REVIEWED_READ_TEMPLATES`,
 * `lib/copilot/handle.ts`) — every deterministic read is trusted by default now, so this
 * test's job changed from "is this template on the list" to "has anyone put this
 * template back on Vertex's-review list without meaning to."
 *
 * Every phrase below is a real, working trigger for a real read template (most lifted
 * from this session's own bug reports and the product's own suggested prompts).
 */
import { describe, expect, it } from "vitest";
import { routeMessage } from "@/lib/copilot/router";
import { VERTEX_REVIEWED_READ_TEMPLATES } from "@/lib/copilot/handle";

const REPRESENTATIVE_READS: Array<[string, string]> = [
  ["what's my health factor?", "query_account_health"],
  ["how much interest accrued on my BLUSDC", "query_accrued_interest"],
  ["list protocol addresses", "query_addresses"],
  ["list all earn pools", "query_all_earn_pools"],
  ["what are my positions", "query_all_positions"],
  ["how much credit do I have", "query_available_credit"],
  ["blend reserve stats", "query_blend"],
  ["can I borrow 20 BLUSDC?", "query_can_borrow"],
  ["can I withdraw 20 XLM?", "query_can_withdraw"],
  ["how much collateral do I have?", "query_collateral"],
  ["collateral config", "query_collateral_config"],
  ["how much do I owe", "query_debt"],
  ["how much have I supplied to earn", "query_earn_position"],
  ["what is the exchange rate", "query_exchange_rate"],
  ["my farm position", "query_farm_position"],
  ["keep my health factor above 1.4", "query_account_health"],
  ["inactive account", "query_inactive"],
  ["net available collateral", "query_margin_figure"],
  ["what is xlm to sousdc ratio in the soroswap pool", "query_pool_ratio"],
  ["AQUSDC pool stats", "query_pool_stats"],
  ["price of xlm", "query_price"],
  ["prices of xlm and usdc", "query_prices_batch"],
  ["what is my smart account address", "query_resolve"],
  ["vtoken", "query_vtoken"],
];

describe("every representative read phrase is trusted outright, never silently re-decided", () => {
  for (const [message, expectedTemplate] of REPRESENTATIVE_READS) {
    it(`"${message}" → ${expectedTemplate}, and is not on Vertex's review list`, () => {
      const r = routeMessage(message);
      expect(r.kind, message).toBe("read");
      if (r.kind !== "read") return;
      expect(r.template_id, message).toBe(expectedTemplate);
      expect(
        VERTEX_REVIEWED_READ_TEMPLATES.includes(r.template_id),
        `"${message}" routes to "${r.template_id}", which is on VERTEX_REVIEWED_READ_TEMPLATES — ` +
          `it can be silently re-decided by Vertex, the exact bug class this test exists to catch.`,
      ).toBe(false);
    });
  }

  it("the opt-out list itself stays empty unless a future read is deliberately marked fuzzy", () => {
    // Not a ban on ever adding to it — a tripwire. If this fails, it means someone did
    // add an entry; the failure is a prompt to confirm that was deliberate, not silent.
    expect(VERTEX_REVIEWED_READ_TEMPLATES).toEqual([]);
  });
});
