import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ update: vi.fn(async () => true) }));
vi.mock("@/lib/copilot/request-user", () => ({ loadUserFromRequest: vi.fn(async () => ({ bound: { sub: "stellar:wallet", kind: "stellar", wallet: "wallet", accessToken: "" }, commit: (response: unknown) => response })) }));
vi.mock("@/lib/copilot/session-store", () => ({ updateSessionExecutionReceipt: mocks.update, deleteConversation: vi.fn(), openConversation: vi.fn(), pinConversation: vi.fn(), renameConversation: vi.fn(), updateSessionAssistantText: vi.fn() }));
import { PATCH } from "@/app/api/copilot/session/[id]/route";
const receipt = { origin: "wallet", workflowId: "setup", status: "completed", network: "testnet",
  steps: [{ operation: "create_account", asset: "", amount: "", label: "Your margin account is open", status: "settled", txHash: "a".repeat(64) }] };
const patch = (value: unknown) => PATCH(new NextRequest("http://localhost/api/copilot/session/chat", { method: "PATCH", body: JSON.stringify({ executionReceipt: value }) }), { params: Promise.resolve({ id: "chat" }) });
beforeEach(() => vi.clearAllMocks());
describe("account setup receipt persistence", () => {
  it("accepts lifecycle receipts without inventing a token amount and preserves their wallet origin", async () => {
    expect((await patch(receipt)).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({ subject: "stellar:wallet", conversationId: "chat", receipt });
  });
  it.each(["deposit_collateral", "unknown_operation"])("does not relax sized-operation validation for %s", async operation => {
    expect((await patch({ ...receipt, steps: [{ ...receipt.steps[0], operation }] })).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("refuses unknown receipt origins", async () => {
    expect((await patch({ ...receipt, origin: "invented" })).status).toBe(400);
  });
});
