import { describe, expect, it } from "vitest";
import { handleChat } from "@/lib/copilot/handle";
import { recordTokenUsage, resetTokenUsage, withTokenSubject } from "@/lib/copilot/token-budget";

const base = {
  user_id: "guest",
  tier: "free" as const,
  smart_account: null,
};

describe("Copilot surface does not keyword-plan", () => {
  it("refuses a free-text prompt on the Copilot page", async () => {
    const res = await handleChat({
      ...base,
      surface: "copilot",
      message: "what's my health factor?",
    });
    expect(res.kind).toBe("blocked");
    expect(res.intent?.template_id).toBe("investigation_owns_planning");
  });

  it("still accepts an approved-plan payload on the Copilot surface", async () => {
    const res = await handleChat({
      ...base,
      surface: "copilot",
      message: "ignored",
      approved_plan: {
        plan_id: "not-a-real-fingerprint",
        created_at: Date.now(),
        steps: [{ op: "lend", asset: "XLM", amount: 5 }],
      },
    });
    expect(res.intent?.template_id).not.toBe("investigation_owns_planning");
    expect(res.intent?.template_id).toMatch(/^plan_rejected_/);
  });

  it("meters the daily token cap by the verified subject, not the client user_id", async () => {
    recordTokenUsage("did:privy:alice", 5_000_000);
    try {
      const res = await withTokenSubject("did:privy:alice", () =>
        handleChat({
          ...base,
          user_id: "GBC2B7N2QPSZVLGOI7LNYQ5UPDRRSPBFYOAUCCICUDAFXYGZ4YL5NJC5",
          message: "what is the capital of france",
        }),
      );
      expect(res.intent?.template_id).toBe("domain_firewall");
      expect((res.data as { reason?: string } | undefined)?.reason).toBe("token_cap");
    } finally {
      resetTokenUsage();
    }
  });
});
