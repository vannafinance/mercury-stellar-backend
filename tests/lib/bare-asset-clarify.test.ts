/**
 * A bare recognized asset name with no verb ("SOUSDC", "XLM") named a real token in our
 * domain but said nothing about what to do with it, and fell through everything to the
 * generic capabilities blurb — reported live when answering a swap's "which token did
 * you mean?" clarify with just the token name. In-domain input should always ask what to
 * do with it; the generic blurb is reserved for genuinely out-of-domain input.
 */
import { describe, expect, it } from "vitest";
import { routeMessage } from "@/lib/copilot/router";

describe("a bare asset name asks what to do with it, not the generic blurb", () => {
  it("asks for SOUSDC alone", () => {
    const r = routeMessage("SOUSDC");
    expect(r.kind).toBe("clarify");
    if (r.kind === "clarify") {
      expect(r.template_id).toBe("bare_asset_clarify");
      expect(r.message).toMatch(/what do you want to do with sousdc/i);
    }
  });

  it("asks for XLM alone, case-insensitively", () => {
    const r = routeMessage("xlm");
    expect(r.kind).toBe("clarify");
    if (r.kind === "clarify") expect(r.template_id).toBe("bare_asset_clarify");
  });

  it("still refuses genuinely out-of-domain input with the generic blurb", () => {
    const r = routeMessage("qwerty zxcvb asdfg");
    expect(r.kind).toBe("clarify");
    if (r.kind === "clarify") expect(r.template_id).toBe("clarify_capabilities");
  });

  it("does not steal a real instruction that happens to be just an asset plus a verb", () => {
    const r = routeMessage("lend SOUSDC");
    expect(r.kind).not.toBe("clarify");
  });
});
