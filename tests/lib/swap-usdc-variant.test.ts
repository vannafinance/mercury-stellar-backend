/**
 * A swap must never buy a different token than the one on the card.
 *
 * Found live 2026-08-10: "swap 10 XLM to BLUSDC" produced a card headed
 * "Swap 10 XLM → BLUSDC (aquarius)" over a transaction that bought AQUSDC — because the
 * venue mapper rewrote every USDC variant to the venue's own, while the label was
 * deliberately built from the user's word. BLUSDC, AQUSDC and SOUSDC are three separate,
 * non-interchangeable tokens.
 */
import { describe, expect, it } from "vitest";
import { mapOpToMcpStep } from "@/lib/copilot/mcp-write";

const CTX = {
  trader: "G".padEnd(56, "A"),
  smartAccount: "C".padEnd(56, "B"),
} as never;

const swap = (params: Record<string, unknown>) =>
  mapOpToMcpStep("swap", { amount: 10, token_a: "XLM", ...params } as never, CTX);

describe("swap — a named USDC variant is honoured, never substituted", () => {
  it("refuses BLUSDC rather than quietly filling it with AQUSDC", () => {
    const r = swap({ token_b: "BLUSDC" });
    expect(r.step).toBeUndefined();
    expect(r.blocker).toMatch(/BLUSDC/);
    expect(r.blocker).toMatch(/AQUSDC|SOUSDC/);
  });

  it("SOUSDC selects Soroswap instead of being rewritten to AQUSDC", () => {
    const r = swap({ token_b: "SOUSDC" });
    expect(r.blocker).toBeUndefined();
    expect(r.step?.args.token_out).toBe("SOUSDC");
    expect(r.step?.args.venue).toBe("soroswap");
  });

  it("AQUSDC selects Aquarius", () => {
    const r = swap({ token_b: "AQUSDC" });
    expect(r.step?.args.token_out).toBe("AQUSDC");
    expect(r.step?.args.venue).toBe("aquarius");
  });

  it("a variant that contradicts an explicitly named venue is refused, not coerced", () => {
    const r = swap({ token_b: "SOUSDC", venue: "aquarius" });
    expect(r.step).toBeUndefined();
    expect(r.blocker).toMatch(/SOUSDC/);
    expect(r.blocker).toMatch(/aquarius/i);
  });

  /** Bare USDC is the ambiguous form and still takes the venue's own token — as the Trade page does. */
  it("bare USDC still resolves to the venue's USDC", () => {
    expect(swap({ token_b: "USDC" }).step?.args.token_out).toBe("AQUSDC");
    expect(swap({ token_b: "USDC", venue: "soroswap" }).step?.args.token_out).toBe("SOUSDC");
  });

  it("the label names the token actually traded, not the word the user typed", () => {
    const r = swap({ token_b: "USDC" });
    expect(r.step?.label).toContain("AQUSDC");
    expect(r.step?.label).not.toMatch(/→ USDC\b/);
  });

  it("puts the router quote in the label when expected_out is known", () => {
    const r = swap({ token_b: "SOUSDC", expected_out: 28.35 });
    expect(r.step?.label).toMatch(/28\.35/);
    expect(r.step?.label).toContain("SOUSDC");
    expect(r.step?.args.expected_out).toBe("28.35");
  });
});
