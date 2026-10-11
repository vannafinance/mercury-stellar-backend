import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { executionReceiptFromWorkflowView } from "@/lib/copilot/execution-receipt";
import { receiptKey } from "@/lib/copilot/workflow-completion";
import type { WorkflowView } from "@/lib/copilot/workflow/types";
const m = vi.hoisted(() => ({ lookup: vi.fn(), read: vi.fn(), save: vi.fn(), compose: vi.fn(), position: vi.fn(), user: vi.fn() }));
vi.mock("@/lib/copilot/request-user", () => ({ loadUserFromRequest: m.user }));
vi.mock("@/lib/copilot/config", () => ({ copilotConfig: { publicOrigin: "http://test", mcpBaseUrl: "http://mcp", sessionSecret: "x".repeat(32) } }));
vi.mock("@/lib/copilot/investigation/proposal", () => ({ workflowJournal: () => ({ lookup: m.lookup }) }));
vi.mock("@/lib/copilot/workflow/types", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/copilot/workflow/types")>(), workflowView: (value: { view: unknown }) => value.view }));
vi.mock("@/lib/copilot/session-store", () => ({ readConversation: m.read, updateSessionWorkflowCompletion: m.save }));
vi.mock("@/lib/copilot/investigation/compose", () => ({ composeCompletion: m.compose }));
vi.mock("@/lib/copilot/investigation/capacity", () => ({ computeAccountPosition: m.position }));
vi.mock("@/lib/copilot/investigation/completion", () => ({ completionReply: () => "Completed requested actions." }));
import { POST } from "@/app/api/copilot/workflow/[id]/reply/route";
const ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const view: WorkflowView = { id: ID, revision: 3, digest: "d", status: "completed", objective: "Deposit 1 XLM", message: "", expiresAt: 0, assumptions: [], constraints: [], slippageAccepted: false,
  steps: [{ id: "s1", op: "deposit_collateral", asset: "XLM", amount: "1", label: "Deposit 1 XLM", status: "settled", txHash: "a".repeat(64), settledLedger: 123 }] };
function stored(v = view) { return { value: { view: v, proposal: { server: "http://mcp", scope: { network: "testnet", smartAccount: "account", subject: "alice" } } } }; }
function call(body: object = { conversationId: "conversation" }) {
  return POST(new NextRequest(`http://test/api/copilot/workflow/${ID}/reply`, { method: "POST", headers: { origin: "http://test", "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: ID }) });
}
beforeEach(() => {
  vi.clearAllMocks();
  m.user.mockResolvedValue({ bound: { sub: "alice" }, commit: (response: Response) => response });
  m.lookup.mockResolvedValue(stored());
  m.read.mockResolvedValue({ turns: [{ role: "assistant", text: "Approve", executionReceipt: executionReceiptFromWorkflowView(view, "testnet") }] });
  m.save.mockResolvedValue(true);
  m.compose.mockResolvedValue({ message: "Your deposit completed.", blocks: [{ type: "paragraph", segments: [{ text: "Your deposit completed." }] }] });
  m.position.mockResolvedValue({ healthFactor: "2", grossCollateralUsd: "20", debtUsd: "10" });
});
describe("server-owned completion route", () => {
  it("carries the original request and approved safety target instead of only the plan title", async () => {
    const journal = stored();
    m.lookup.mockResolvedValue({ value: { ...journal.value, proposal: { ...journal.value.proposal,
      messages: ["Place my idle balance and borrow safely above my chosen health floor", "Borrow SOUSDC"],
      floor: "1.73", constraints: ["Keep my chosen safety floor"],
    } } });
    expect((await call({ conversationId: "conversation", healthFloor: "9", request: "fake" })).status).toBe(200);
    expect(m.compose.mock.calls[0][0]).toMatchObject({
      request: "Place my idle balance and borrow safely above my chosen health floor\nBorrow SOUSDC",
      healthFloor: "1.73", constraints: ["Keep my chosen safety floor"],
    });
  });
  it("uses only owned journal data, anchors the fresh read and persists before returning", async () => {
    const response = await call({ conversationId: "conversation", message: "fake", replyBlocks: [{ text: "fake" }], receipt: { txHash: "fake" } });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.receipt.steps[0]).toMatchObject({ txHash: "a".repeat(64), settledLedger: 123, amount: "1" });
    expect(result.completion.source).toBe("model");
    expect(result.message).toContain(`https://stellar.expert/explorer/testnet/tx/${"a".repeat(64)}`);
    expect(result.message).toContain("Ledger 123");
    expect(m.lookup).toHaveBeenCalledWith(ID, "alice");
    expect(m.position).toHaveBeenCalledWith("account", expect.any(AbortSignal), "a".repeat(64));
    expect(m.save).toHaveBeenCalledWith({ subject: "alice", conversationId: "conversation", reply: result });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("refuses foreign/missing conversation ownership before composing", async () => {
    m.read.mockResolvedValue(null);
    expect((await call()).status).toBe(409);
    expect(m.compose).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
  });
  it("anchors the account refresh to the greatest included ledger even when operations share hashes", async () => {
    const v: WorkflowView = { ...view, steps: [
      { ...view.steps[0], txHash: "b".repeat(64), settledLedger: 125 },
      { ...view.steps[0], id: "s2", txHash: "a".repeat(64), settledLedger: 123 },
    ] };
    m.lookup.mockResolvedValue(stored(v));
    m.read.mockResolvedValue({ turns: [{ role: "assistant", executionReceipt: executionReceiptFromWorkflowView(v, "testnet") }] });
    expect((await call()).status).toBe(200);
    expect(m.position).toHaveBeenCalledWith("account", expect.any(AbortSignal), "b".repeat(64));
  });
  it.each(["running", "blocked", "uncertain", "cancelled"] as const)("does not transition a %s run", async (status) => {
    m.lookup.mockResolvedValue(stored({ ...view, status }));
    expect((await call()).status).toBe(204);
    expect(m.position).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
  });
  it("retains verified fallback plus receipt when the model or post-read is unavailable", async () => {
    m.compose.mockResolvedValue(null); m.position.mockRejectedValue(new Error("unavailable"));
    const response = await call(); const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.completion.source).toBe("fallback");
    expect(result.replyBlocks).toHaveLength(1);
    expect(result.receipt.steps[0].settledLedger).toBe(123);
    expect(m.compose.mock.calls[0][0].healthNow).toBeNull();
    expect(m.compose.mock.calls[0][0].positionNow).toBeUndefined();
  });
  it("reuses the durable summary on repeat requests without re-reading or re-composing", async () => {
    const receipt = executionReceiptFromWorkflowView(view, "testnet");
    m.read.mockResolvedValue({ turns: [{ role: "assistant", text: "Saved summary", blocks: [{ type: "paragraph", segments: [{ text: "Saved summary" }] }], executionReceipt: receipt,
      completion: { workflowId: ID, receiptKey: receiptKey(receipt), generatedAt: 1, source: "model" } }] });
    expect((await (await call()).json()).message).toBe("Saved summary");
    expect(m.position).not.toHaveBeenCalled();
    expect(m.compose).not.toHaveBeenCalled();
  });
  it("does not return summary mode when persistence loses ownership or the journal changed", async () => {
    m.save.mockResolvedValue(false);
    expect((await call()).status).toBe(409);
    m.save.mockResolvedValue(true);
    m.lookup.mockResolvedValueOnce(stored()).mockResolvedValueOnce(stored({ ...view, status: "blocked" }));
    expect((await call()).status).toBe(409);
  });
  it("requires a signed-in owner", async () => {
    m.user.mockResolvedValue({ bound: null, commit: (response: Response) => response });
    expect((await call()).status).toBe(401);
    expect(m.lookup).not.toHaveBeenCalled();
  });
});
