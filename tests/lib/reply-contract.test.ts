import { describe, expect, it, vi } from "vitest";
import { bindReplyBlocks, plainReply, replyFactContext, REPLY_LIMITS } from "@/lib/copilot/investigation/reply-contract";
import { composeReply } from "@/lib/copilot/investigation/compose";
import type { ResearchFact, ResearchView } from "@/lib/copilot/investigation/view";

const facts: ResearchFact[] = [{ id: "read:balance", label: "ExampleAsset balance", value: "14.25", unit: "ExampleAsset", quantity: true,
  venue: "wallet", evidenceId: "read", sourcePath: "positions.balance", readAt: 123, requested: true }];
const text = (text: string) => ({ type: "text", text });
const fact = (factId = facts[0].id) => ({ type: "fact", factId });
const paragraph = (segments: unknown[]) => ({ type: "paragraph", segments });
const view = (over: Partial<ResearchView> = {}): ResearchView => ({ status: "researched", message: "verified fallback", originalRequest: "explain the balances clearly",
  refinements: [], understanding: { intent: "answer", objective: "balance", constraints: [], borrowing: "forbidden" },
  facts, checks: [], warnings: [], question: null, scope: { wallet: "sensitive-wallet", smartAccount: null, network: "testnet" },
  continuation: "sealed", executionAllowed: false, ...over });

describe("adaptive reply contract", () => {
  it("supports mixed structure and preserves fact identity without parsing placeholder text", () => {
    const bound = bindReplyBlocks({ blocks: [
      paragraph([text("You hold "), fact(), text(" in your wallet.")]),
      { type: "heading", segments: [text("Your holdings")] },
      { type: "bullets", items: [[text("Spendable balance: "), fact()]] },
      { type: "steps", items: [[text("Review the balance: "), fact()], [text("Choose an action when ready.")]] },
      { type: "table", columns: [[text("Location")], [text("Balance")]], rows: [[[text("Wallet")], [fact()]]] },
    ] }, facts);
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.blocks.map((b) => b.type)).toEqual(["paragraph", "heading", "bullets", "steps", "table"]);
    expect(bound.blocks[0].type === "paragraph" && bound.blocks[0].segments[1]).toEqual({ text: "14.25 ExampleAsset", figure: true, factId: "read:balance" });
    expect(plainReply(bound.blocks)).toContain("1. Review the balance: 14.25 ExampleAsset\n2. Choose an action when ready.");
    expect(plainReply(bound.blocks)).toContain("Location | Balance\nWallet | 14.25 ExampleAsset");
  });

  it.each([
    { blocks: [paragraph([fact("unknown")])] },
    { blocks: [paragraph([text("Your balance is 99"), fact()])] },
    { blocks: [paragraph([text("<script>"), fact()])] },
    { blocks: [paragraph([text("{{read:balance}}")])] },
    { blocks: [paragraph([{ ...fact(), text: "999" }])] },
    { blocks: [paragraph([{ type: "text", text: "Value", approved: true }, fact()])] },
    { blocks: [{ ...paragraph([fact()]), text: "conflicting legacy field" }] },
    { blocks: [paragraph([text(" ")])] },
    { blocks: [paragraph([text("not grounded")])] },
    { blocks: [{ type: "steps", items: [] }] },
    { blocks: [{ type: "table", columns: [[text("A")], [text("B")]], rows: [[ [fact()] ]] }] },
    { blocks: [paragraph([fact()])], approval: true },
  ])("rejects invalid or ungrounded payload %#", (payload) => {
    expect(bindReplyBlocks(payload, facts).ok).toBe(false);
  });

  it("rejects ambiguous source identities and applies common size budgets", () => {
    expect(bindReplyBlocks({ blocks: [paragraph([fact()])] }, [...facts, { ...facts[0], value: "different" }]).ok).toBe(false);
    expect(bindReplyBlocks({ blocks: Array.from({ length: REPLY_LIMITS.blocks + 1 }, () => paragraph([fact()])) }, facts).ok).toBe(false);
    expect(bindReplyBlocks({ blocks: [paragraph([text("x".repeat(REPLY_LIMITS.text + 1)), fact()])] }, facts).ok).toBe(false);
  });

  it("supplies provenance and unit/quantity distinctions as structured data", () => {
    expect(replyFactContext(facts[0])).toMatchObject({ label: "ExampleAsset balance", unit: "ExampleAsset", quantity: true, requested: true,
      evidence: { id: "read", path: "positions.balance", readAt: 123 } });
    expect(replyFactContext({ ...facts[0], quantity: undefined, readAt: 0 })).toMatchObject({ quantity: null, evidence: { readAt: null } });
  });

  it("composes an adaptive response while preserving all execution and research fields", async () => {
    const original = view();
    const generate = vi.fn(async () => ({ blocks: [{ type: "bullets", items: [[text("Wallet: "), fact()]] }] }));
    const out = await composeReply(original, new AbortController().signal, generate);
    expect(out.message).toBe("• Wallet: 14.25 ExampleAsset");
    const { message: _message, replyBlocks: _blocks, ...unchanged } = out;
    const { message: _originalMessage, ...before } = original;
    expect(unchanged).toEqual(before);
    const user = JSON.parse((generate.mock.calls[0] as unknown as [string, string])[1]);
    expect(user.context.scope).toEqual({ network: "testnet", walletPresent: true, smartAccountPresent: false });
    expect(user.facts[0].evidence.path).toBe("positions.balance");
    expect(JSON.stringify(user)).not.toContain("sensitive-wallet");
  });

  it("records safe composition and skip outcomes without user content or fact values", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await composeReply(view(), new AbortController().signal, async () => ({ blocks: [paragraph([fact()])] }));
      await composeReply(view({ warnings: ["private upstream detail"] }), new AbortController().signal, async () => ({ blocks: [paragraph([fact()])] }));
      await composeReply(view({ facts: [], warnings: ["private upstream detail"] }), new AbortController().signal, vi.fn());
      const events = log.mock.calls.filter((call) => call[0] === "[copilot] reply composition").map((call) => call[1]);
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "composed", lane: "answer" }), expect.objectContaining({ outcome: "skipped", reason: "no_facts" })]));
      expect(JSON.stringify(events)).not.toContain("private upstream detail");
      expect(JSON.stringify(events)).not.toContain("sensitive-wallet");
      expect(JSON.stringify(events)).not.toContain("14.25");
    } finally { log.mockRestore(); }
  });
});
