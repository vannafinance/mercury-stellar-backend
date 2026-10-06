import { describe, expect, it } from "vitest";
import { applyWorkflowCompletion, completionMatches, receiptKey, settledTransactions, type WorkflowCompletionReply } from "@/lib/copilot/workflow-completion";
import type { ExecutionReceiptSnapshot } from "@/lib/copilot/execution-receipt";

export function receipt(): ExecutionReceiptSnapshot {
  return { workflowId: "run-1", network: "testnet", status: "completed", steps: [
    { operation: "deposit_collateral", label: "Deposit 10 XLM", asset: "XLM", amount: "10", status: "settled", txHash: "a".repeat(64), settledLedger: 123 },
    { operation: "borrow", label: "Borrow 2 BLUSDC", asset: "BLUSDC", amount: "2", status: "settled", txHash: "b".repeat(64), settledLedger: 124 },
  ] };
}
export function reply(r = receipt()): WorkflowCompletionReply {
  return { receipt: r, message: "Your requested actions completed.", replyBlocks: [{ type: "paragraph", segments: [{ text: "Your requested actions completed." }] }],
    completion: { workflowId: r.workflowId, receiptKey: receiptKey(r), generatedAt: 1, source: "model" } };
}

describe("post-settlement presentation contract", () => {
  it("groups actual transactions without mutating their journal receipt", () => {
    const r = receipt();
    r.steps.push({ ...r.steps[0], operation: "lend", label: "Supply 10 XLM" });
    const original = structuredClone(r);
    const groups = settledTransactions(r)!;
    expect(groups).toHaveLength(2);
    expect(groups[0].steps).toHaveLength(2);
    expect(groups[0].url).toBe(`https://stellar.expert/explorer/testnet/tx/${"a".repeat(64)}`);
    expect(r).toEqual(original);
  });

  it.each(["running", "blocked", "cancelled", "uncertain", "awaiting_signature"] as const)("keeps %s runs out of full-success presentation", (status) => {
    expect(settledTransactions({ ...receipt(), status })).toBeNull();
  });

  it("requires every step and receipt field; conflicting ledgers never become success", () => {
    for (const change of [{ status: "submitted" }, { txHash: null }, { txHash: "javascript:alert(1)" }, { settledLedger: null }, { settledLedger: 0 }]) {
      const r = receipt(); Object.assign(r.steps[1], change);
      expect(settledTransactions(r)).toBeNull();
    }
    const r = receipt(); r.steps[1].txHash = r.steps[0].txHash;
    expect(settledTransactions(r)).toBeNull();
    expect(settledTransactions({ ...receipt(), steps: [] })).toBeNull();
    expect(settledTransactions({ ...receipt(), network: "private" })).toBeNull();
  });

  it("single-leg and public-network receipts have exactly one correct explorer entry", () => {
    const r = receipt(); r.steps = [r.steps[0]]; r.network = "mainnet";
    expect(settledTransactions(r)).toMatchObject([{ ledger: 123, url: `https://stellar.expert/explorer/public/tx/${"a".repeat(64)}` }]);
  });

  it("replaces only the owning turn even after another question, and ignores orphan/stale results", () => {
    const r = receipt(); const result = reply(r);
    const turns = [{ role: "assistant", text: "Approval", executionReceipt: r }, { role: "user", text: "Hi" }, { role: "assistant", text: "Hello" }];
    const updated = applyWorkflowCompletion(turns, result)!;
    expect(updated[0].text).toBe(result.message);
    expect(updated[2].text).toBe("Hello");
    expect(turns[0].text).toBe("Approval");
    expect(applyWorkflowCompletion(turns.slice(1), result)).toBeNull();
    const changed = structuredClone(r); changed.steps[0].amount = "11";
    expect(applyWorkflowCompletion([{ ...turns[0], executionReceipt: changed }], result)).toBeNull();
    expect(completionMatches(changed, result.completion)).toBe(false);
  });
});
