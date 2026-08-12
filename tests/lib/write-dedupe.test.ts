/**
 * Confirmed live (Z-07, §16): two concurrent identical "lend 1 XLM" requests both
 * executed independently before this fix — two real transactions, not one deduped
 * into the other. See docs/copilot/TEST-RUN-FINDINGS.md §3 item 5.
 */
import { describe, expect, it } from "vitest";
import { claimOnce, planDedupeKey, writeDedupeKey } from "@/lib/copilot/write-dedupe";

describe("claimOnce", () => {
  it("allows the first claim of a key", () => {
    expect(claimOnce("k1", 1_000)).toBe(true);
  });

  it("refuses a repeat of the same key inside the window", () => {
    expect(claimOnce("k2", 1_000)).toBe(true);
    expect(claimOnce("k2", 1_500)).toBe(false);
    expect(claimOnce("k2", 8_999)).toBe(false);
  });

  it("allows the same key again once the window has fully elapsed", () => {
    expect(claimOnce("k3", 1_000)).toBe(true);
    expect(claimOnce("k3", 9_001)).toBe(true);
  });

  it("treats different keys independently", () => {
    expect(claimOnce("a", 1_000)).toBe(true);
    expect(claimOnce("b", 1_000)).toBe(true);
    expect(claimOnce("a", 1_000)).toBe(false);
    expect(claimOnce("b", 1_000)).toBe(false);
  });
});

describe("planDedupeKey", () => {
  it("namespaces a plan_id so it can't collide with a write key", () => {
    expect(planDedupeKey("abc123")).toBe("plan:abc123");
  });
});

describe("writeDedupeKey", () => {
  it("is stable for the same trader/op/asset/amount", () => {
    const a = writeDedupeKey({ trader: "G123", op: "lend", asset: "XLM", amount: 1 });
    const b = writeDedupeKey({ trader: "G123", op: "lend", asset: "XLM", amount: 1 });
    expect(a).toBe(b);
  });

  it("differs when any field differs", () => {
    const base = writeDedupeKey({ trader: "G123", op: "lend", asset: "XLM", amount: 1 });
    expect(writeDedupeKey({ trader: "G456", op: "lend", asset: "XLM", amount: 1 })).not.toBe(base);
    expect(writeDedupeKey({ trader: "G123", op: "borrow", asset: "XLM", amount: 1 })).not.toBe(base);
    expect(writeDedupeKey({ trader: "G123", op: "lend", asset: "USDC", amount: 1 })).not.toBe(base);
    expect(writeDedupeKey({ trader: "G123", op: "lend", asset: "XLM", amount: 2 })).not.toBe(base);
  });

  it("tolerates missing fields without throwing", () => {
    expect(() => writeDedupeKey({})).not.toThrow();
  });
});
