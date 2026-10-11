import { describe, expect, it } from "vitest";
import { compactResearchMessages, researchCodec } from "@/lib/copilot/investigation/continuation";

const scope = { subject: "alice", trader: "wallet", smartAccount: "account", network: "testnet" };
describe("bounded chat context renewal", () => {
  it("packs more than eight prompts while preserving source quotes and latest intent verbatim", () => {
    const messages = ["keep 100 XLM liquid", ...Array.from({ length: 8 }, (_, i) => `refinement ${i}`), "compare current rates"];
    const packed = compactResearchMessages(messages);
    expect(packed.length).toBeLessThanOrEqual(8);
    expect(packed[0]).toBe(messages[0]);
    expect(packed.at(-1)).toBe(messages.at(-1));
    for (const message of messages) expect(packed.some((part) => part.includes(message))).toBe(true);
    const codec = researchCodec("s".repeat(32), "server");
    expect(codec.open(codec.seal(scope, packed, null), scope).messages).toEqual(packed);
  });
  it("renews only the same authenticated scope and drops expired evidence and questions", () => {
    let now = 1000;
    const codec = researchCodec("s".repeat(32), "server", () => now);
    const token = codec.seal(scope, ["keep 100 XLM liquid"], "Which plan?", { capturedAt: now, observations: [], capacity: null });
    now += 31 * 60_000;
    expect(() => codec.open(token, scope)).toThrow();
    const renewed = codec.renew(token, scope);
    expect(renewed.messages).toEqual(["keep 100 XLM liquid"]);
    expect(renewed.evidence).toBeUndefined();
    expect(renewed.lastQuestion).toBeNull();
    expect(() => codec.renew(token, { ...scope, trader: "other" })).toThrow();
    expect(() => codec.renew(token + "tamper", scope)).toThrow();
    now += 31 * 24 * 60 * 60_000;
    expect(() => codec.renew(token, scope)).toThrow();
  });
  it("keeps the total text limit instead of silently discarding older constraints", () => {
    const codec = researchCodec("s".repeat(32), "server");
    expect(() => codec.seal(scope, compactResearchMessages(Array(9).fill("x".repeat(8_000))), null)).toThrow();
  });
});
