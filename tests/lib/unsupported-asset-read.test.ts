/**
 * The unsupported-asset gate only fired on write verbs (lend, borrow, swap, ...), so a
 * plain read-style question naming an unsupported ticker — "what's the XLM/BTC pool" —
 * matched none of them and fell through to the generic capabilities blurb instead of
 * the specific "not a Vanna asset" refusal. See docs/copilot/TEST-RUN-FINDINGS.md
 * §1 item 3.
 */
import { describe, expect, it } from "vitest";
import { routeMessage } from "@/lib/copilot/router";

describe("a read-style question naming an unsupported asset gets a specific refusal", () => {
  it("refuses 'what's the XLM/BTC pool' instead of the generic capabilities blurb", () => {
    const r = routeMessage("what's the XLM/BTC pool");
    expect(r.kind).toBe("clarify");
    if (r.kind === "clarify") {
      expect(r.template_id).toBe("unsupported_asset");
      expect(r.message).toMatch(/BTC/);
    }
  });

  it("refuses a price question about an unsupported asset", () => {
    const r = routeMessage("what's the price of DOGE");
    expect(r.kind).toBe("clarify");
    if (r.kind === "clarify") {
      expect(r.template_id).toBe("unsupported_asset");
    }
  });

  it("never fires the unsupported-asset refusal for a supported asset", () => {
    const r = routeMessage("what's the XLM pool");
    if (r.kind === "clarify") {
      expect(r.template_id).not.toBe("unsupported_asset");
    }
  });
});
