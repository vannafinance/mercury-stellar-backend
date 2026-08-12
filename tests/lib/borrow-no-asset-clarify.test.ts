/**
 * "borrow the max I can safely" named no asset word at all, yet the borrow branch
 * defaulted `asset ?? "USDC"` — which then hit the bare-USDC ambiguity gate and asked
 * which USDC variant *before* ever asking a size. See docs/copilot/TEST-RUN-FINDINGS.md
 * §1 item 2.
 */
import { describe, expect, it } from "vitest";
import { routeMessage } from "@/lib/copilot/router";

describe("borrow with no asset word at all asks for amount + asset together", () => {
  it("does not default to a USDC write for a nameless borrow", () => {
    const r = routeMessage("borrow the max I can safely");
    expect(r.kind).toBe("clarify");
    if (r.kind === "clarify") {
      expect(r.template_id).toBe("borrow_amount_and_asset");
      expect(r.message).toMatch(/how much/i);
      expect(r.message).toMatch(/asset/i);
    }
  });

  it("asks only for the asset when an amount was already given", () => {
    const r = routeMessage("borrow 50 please");
    expect(r.kind).toBe("clarify");
    if (r.kind === "clarify") {
      expect(r.template_id).toBe("borrow_amount_and_asset");
      expect(r.message).toMatch(/50/);
    }
  });

  it("still routes straight to a borrow write when an asset is named", () => {
    const r = routeMessage("borrow 50 XLM");
    expect(r.kind).toBe("write");
    if (r.kind === "write") {
      expect(r.op).toBe("borrow");
      expect(r.asset).toBe("XLM");
      expect(r.amount).toBe(50);
    }
  });

  it("still routes to a borrow write with the USDC-variant default when the user says bare USDC", () => {
    const r = routeMessage("borrow 50 USDC");
    expect(r.kind).toBe("write");
    if (r.kind === "write") {
      expect(r.op).toBe("borrow");
      expect(r.asset).toBe("USDC");
    }
  });
});
