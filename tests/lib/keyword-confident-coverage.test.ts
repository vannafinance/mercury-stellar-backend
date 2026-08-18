/**
 * A deterministic read route is only actually deterministic if it is TRUSTED — every
 * bug this test guards against had the router already producing the right answer, with
 * Vertex re-deciding the message from scratch anyway and occasionally landing somewhere
 * else ("swap 10 XLM to USDC" losing its own "which USDC?" clarify; "What is Balance of
 * XLM in my Margin Account" falling to the generic blurb while the fixed test phrasing
 * for the identical question worked). The fix each time was adding the template_id to
 * `KEYWORD_CONFIDENT_READ_TEMPLATES` (`lib/copilot/handle.ts`) — and each time, the gap
 * existed because nothing checked that list against what the router can actually
 * produce.
 *
 * This is that check. Every phrase below is a real, working trigger for a real read
 * template (most lifted from this session's own bug reports and the product's own
 * suggested prompts); the assertion is simply that whatever `routeMessage` classifies it
 * as is on the trusted list. Add a new deterministic read route to `router.ts` tomorrow
 * without adding it here and to the trusted list, and — once a representative phrase for
 * it is added below — this test catches the gap before a live report does.
 */
import { describe, expect, it } from "vitest";
import { routeMessage } from "@/lib/copilot/router";
import { KEYWORD_CONFIDENT_READ_TEMPLATES } from "@/lib/copilot/handle";

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
  ["inactive account", "query_inactive"],
  ["net available collateral", "query_margin_figure"],
  ["what is xlm to sousdc ratio in the soroswap pool", "query_pool_ratio"],
  ["AQUSDC pool stats", "query_pool_stats"],
  ["price of xlm", "query_price"],
  ["prices of xlm and usdc", "query_prices_batch"],
  ["what is my smart account address", "query_resolve"],
  ["vtoken", "query_vtoken"],
];

describe("every representative read phrase resolves to a template on the trusted list", () => {
  for (const [message, expectedTemplate] of REPRESENTATIVE_READS) {
    it(`"${message}" → ${expectedTemplate}, and it is keyword-confident`, () => {
      const r = routeMessage(message);
      expect(r.kind, message).toBe("read");
      if (r.kind !== "read") return;
      expect(r.template_id, message).toBe(expectedTemplate);
      expect(
        (KEYWORD_CONFIDENT_READ_TEMPLATES as readonly string[]).includes(r.template_id),
        `"${message}" routes to "${r.template_id}", which is NOT on KEYWORD_CONFIDENT_READ_TEMPLATES — ` +
          `it can be silently re-decided by Vertex, the exact bug class this test exists to catch.`,
      ).toBe(true);
    });
  }
});
