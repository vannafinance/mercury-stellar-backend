import { describe, expect, it } from "vitest";
import { accountSetupPrompt, accountSetupRequest } from "@/lib/copilot/account-setup-continuation";
const pending = { wallet: "wallet", conversationId: "chat", request: "Deposit 5 XLM", setupRequestId: "setup" };
const context = { wallet: "wallet", conversationId: "chat", setupRequestId: "setup", operation: "create_account", cancelled: false, settled: true };
describe("account setup continuation identity", () => {
  it("keeps multi-action requests and later user constraints without paraphrasing", () => {
    expect(accountSetupPrompt({ originalRequest: "Supply XLM to Blend and borrow BLUSDC", refinements: ["Use 20 XLM and borrow 2 BLUSDC", "Keep my health factor above 2"] }))
      .toBe("Supply XLM to Blend and borrow BLUSDC\n\nUse 20 XLM and borrow 2 BLUSDC\n\nKeep my health factor above 2");
  });
  it("retains the exact original request for its setup action", () => {
    expect(accountSetupRequest(pending, context)).toBe("Deposit 5 XLM");
  });
  it.each([{ wallet: "another" }, { conversationId: "another" }, { setupRequestId: "another" }, { operation: "deposit" }, { cancelled: true }, { settled: false }])("rejects changed or cancelled setup context %j", change => {
    expect(accountSetupRequest(pending, { ...context, ...change })).toBeNull();
  });
  it("cannot re-arm a consumed continuation", () => { expect(accountSetupRequest(null, context)).toBeNull(); });
  it("requires the actual setup request identity before resuming", () => {
    expect(accountSetupRequest({ ...pending, setupRequestId: null }, { ...context, setupRequestId: null })).toBeNull();
  });
});
