import { describe, expect, it } from "vitest";
import { applyWorkflowCompletion, completionMatches, completionStep, needsCompletionRecovery, immediateCompletion, receiptBeside, receiptKey, settledTransactions, shortTransactionHash, type WorkflowCompletionReply } from "@/lib/copilot/workflow-completion";
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
  it("restores only completed workflows whose matching summary is missing", () => {
    const r = receipt();
    expect(needsCompletionRecovery(r, undefined)).toBe(true);
    expect(needsCompletionRecovery(r, reply(r).completion)).toBe(false);
    expect(needsCompletionRecovery(r, { ...reply(r).completion, workflowId: "other" })).toBe(true);
    expect(needsCompletionRecovery({ ...r, status: "running" }, undefined)).toBe(false);
    expect(needsCompletionRecovery({ ...r, status: "cancelled" }, undefined)).toBe(false);
  });
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

describe("immediateCompletion and shortTransactionHash", () => {
  it("builds a reply from the receipt alone, keyed to it, so the settled list draws without any model", () => {
    const r = receipt();
    const reply = immediateCompletion(r, 1_000)!;
    expect(reply.completion).toEqual({ workflowId: r.workflowId, receiptKey: receiptKey(r), generatedAt: 1_000, source: "fallback" });
    expect(completionMatches(r, reply.completion)).toBe(true);
    expect(reply.message).toMatch(/ - settled on-chain\.$/);
    const [paragraph] = reply.replyBlocks;
    expect(paragraph).toMatchObject({ type: "paragraph" });
    // The plain text and the blocks say the same thing, and what was done is the bold figure.
    expect((paragraph as { segments: Array<{ text: string; figure?: true }> }).segments.map((s) => s.text).join("")).toBe(reply.message);
    expect((paragraph as { segments: Array<{ text: string; figure?: true }> }).segments[0].figure).toBe(true);
  });
  it("offers nothing for a run that has not fully settled, so a stopped run keeps its execution card", () => {
    expect(immediateCompletion({ ...receipt(), status: "blocked" })).toBeNull();
    expect(immediateCompletion({ ...receipt(), steps: [] })).toBeNull();
  });
  it("is replaced by the model-worded reply for the same receipt", () => {
    const r = receipt();
    const first = immediateCompletion(r)!;
    const composed = { ...first, message: "You lent 5 XLM.", completion: { ...first.completion, source: "model" as const } };
    const afterImmediate = applyWorkflowCompletion([{ role: "assistant", executionReceipt: r, text: "x" }], first)!;
    const afterComposed = applyWorkflowCompletion(afterImmediate, composed)!;
    expect(afterComposed[0]).toMatchObject({ text: "You lent 5 XLM.", completion: { source: "model" } });
  });
  it("shows the ends of a hash, and leaves a short value alone", () => {
    expect(shortTransactionHash("73f69a1791b34ea5c6d076d42c259e93c2aabd616836d9a61f58be4e2f2d512b")).toBe("73f69a…512b");
    expect(shortTransactionHash("abc")).toBe("abc");
  });
});

/**
 * 7 Oct: a finished run sat with no summary because the summary only started once an earlier step (saving the receipt) had
 * succeeded, and nothing said what to do when it had not. The next step for a finished run is now decided from the run itself.
 */
describe("completionStep: a finished run always has a next step toward its summary", () => {
  const settled = { workflowId: "wf", status: "completed" as const, network: "testnet",
    steps: [{ operation: "lend" as const, asset: "XLM", amount: "5", status: "settled" as const, txHash: "c".repeat(64), settledLedger: 9 }] };
  const noBuild = () => null;

  it("composes when the turn already carries a settled receipt", () => {
    expect(completionStep({ status: "completed" }, settled, noBuild)).toEqual({ kind: "compose", receipt: settled });
  });

  it("builds the receipt from the run when the turn has none, instead of waiting for something else to put it there", () => {
    expect(completionStep({ status: "completed" }, null, () => settled)).toEqual({ kind: "attach", receipt: settled });
    expect(completionStep({ status: "completed" }, undefined, () => settled)).toEqual({ kind: "attach", receipt: settled });
  });

  it("repairs a stale in-progress receipt from the completed journal before composing", () => {
    const stale = { ...settled, status: "awaiting_signature" as const,
      steps: [{ ...settled.steps[0], status: "awaiting_signature" as const, txHash: undefined, settledLedger: undefined }] };
    expect(completionStep({ status: "completed" }, stale, () => settled)).toEqual({ kind: "attach", receipt: settled });
    expect(completionStep({ status: "completed" }, stale, () => ({ ...settled, workflowId: "another-run" }))).toEqual({ kind: "wait" });
  });

  it("waits only for a run that has not finished, or has nothing settled to say", () => {
    expect(completionStep({ status: "running" }, null, () => settled)).toEqual({ kind: "wait" });
    expect(completionStep({ status: "completed" }, null, noBuild)).toEqual({ kind: "wait" });
    expect(completionStep({ status: "completed" }, { ...settled, steps: [] }, noBuild)).toEqual({ kind: "wait" });
    expect(completionStep({ status: "completed" }, null, () => ({ ...settled, steps: [{ ...settled.steps[0], status: "failed" as const, txHash: undefined }] }))).toEqual({ kind: "wait" });
  });
});

/**
 * 7 Oct: the reply listed "Deposited 5 XLM" and "Supplied 5 XLM to Blend", and the receipt listed the same two again with their hashes.
 * One list carries both when the reply has one item per transaction; otherwise the verified list stays.
 */
describe("receiptBeside: where a transaction's hash can sit beside the reply's own words", () => {
  const list = (n: number) => ({ type: "bullets", items: Array.from({ length: n }, () => []) });

  it("is the list with exactly one item per settled transaction", () => {
    expect(receiptBeside([{ type: "paragraph" }, list(2)], 2)).toBe(1);
  });

  it("is nothing for a single transaction, a list of another length, or no list - the verified list then stays", () => {
    expect(receiptBeside([{ type: "paragraph" }, list(2)], 1)).toBeNull();
    expect(receiptBeside([{ type: "paragraph" }, list(3)], 2)).toBeNull();
    expect(receiptBeside([{ type: "paragraph" }], 2)).toBeNull();
    expect(receiptBeside(undefined, 2)).toBeNull();
  });
});
