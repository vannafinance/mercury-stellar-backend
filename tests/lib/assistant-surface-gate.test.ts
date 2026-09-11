/**
 * The floating "Vanna Assistant" widget (docked on every page besides /copilot) and the
 * dedicated /copilot workspace hit the exact same `/api/copilot` endpoint and the exact
 * same `handleChat`. The widget is meant to be a Gemini-Assist-style page guide — explain,
 * answer, navigate — never sign or submit a transaction; that belongs on the Copilot page.
 * Before this fix there was no way to tell them apart server-side: "deposit 5 XLM as
 * collateral" typed into the floating widget signed and submitted for real, identically to
 * typing it on /copilot. `surface: "assistant"` now gates both the structured write
 * continuations (approved_plan / auto_sign / pending_write / resume_multi_leg) and a plain
 * write/plan/auto_sign sentence once routing has classified it.
 *
 * Both cases here return before `handleChat` ever touches MCP (the redirect fires ahead of
 * any `runWrite` / `runPlan` / `handleAutoSignAction` call), so no MCP mode setup or mocking
 * is needed — this is true regardless of `MCP_MODE`.
 */
import { describe, expect, it } from "vitest";
import { handleChat } from "@/lib/copilot/handle";
import { resetMcpClient } from "@/lib/copilot/mcp-client";

const base = { user_id: "guest", tier: "free" as const, smart_account: null };

describe("assistant surface never executes a transaction", () => {
  it("redirects a plain write sentence instead of running it", async () => {
    const res = await handleChat({
      ...base,
      surface: "assistant",
      message: "deposit 5 XLM as collateral",
    });
    expect(res.kind).toBe("blocked");
    expect(res.intent?.template_id).toBe("assistant_surface_redirect");
    expect(res.message).toMatch(/copilot/i);
  });

  it("redirects a resumed pending_write instead of running it", async () => {
    const res = await handleChat({
      ...base,
      surface: "assistant",
      message: "",
      pending_write: { op: "lend", asset: "XLM", amount: 5 },
    });
    expect(res.kind).toBe("blocked");
    expect(res.intent?.template_id).toBe("assistant_surface_redirect");
  });

  it("redirects an approved_plan submission instead of running it", async () => {
    const res = await handleChat({
      ...base,
      surface: "assistant",
      message: "",
      approved_plan: {
        plan_id: "does-not-matter",
        created_at: Date.now(),
        steps: [{ op: "lend", asset: "XLM", amount: 5 }],
      },
    });
    expect(res.kind).toBe("blocked");
    expect(res.intent?.template_id).toBe("assistant_surface_redirect");
  });

  it("redirects an auto_sign action instead of running it", async () => {
    const res = await handleChat({
      ...base,
      surface: "assistant",
      message: "",
      auto_sign: { action: "use_defaults" },
    });
    expect(res.kind).toBe("blocked");
    expect(res.intent?.template_id).toBe("assistant_surface_redirect");
  });

  it("does not treat the copilot surface as the assistant widget", async () => {
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    try {
      const res = await handleChat({
        ...base,
        surface: "copilot",
        message: "deposit 5 XLM as collateral",
      });
      expect(res.intent?.template_id).not.toBe("assistant_surface_redirect");
      expect(res.intent?.template_id).toBe("investigation_owns_planning");
    } finally {
      delete process.env.MCP_MODE;
      resetMcpClient();
    }
  });

  it("redirects the owner-style strategy paragraph without keyword-planning it", async () => {
    const res = await handleChat({
      ...base,
      surface: "assistant",
      message:
        "use some USDC and BLUSDC to build a strategy so my health factor doesn't go below 1.3 — you can use spot and farm markets yourself, and you can even take new loans.",
    });
    expect(res.kind).toBe("blocked");
    expect(res.intent?.template_id).toBe("assistant_surface_redirect");
  });

  it("redirects enable auto-sign instead of starting a session", async () => {
    const res = await handleChat({
      ...base,
      surface: "assistant",
      message: "enable auto-sign",
    });
    expect(res.kind).toBe("blocked");
    expect(res.intent?.template_id).toBe("assistant_surface_redirect");
  });

  it("does not Vertex-plan a live health question into a write", async () => {
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    try {
      const res = await handleChat({
        ...base,
        surface: "assistant",
        message: "what's my health factor?",
      });
      expect(res.kind).not.toBe("executed");
      expect(res.intent?.template_id).not.toBe("assistant_surface_redirect");
    } finally {
      delete process.env.MCP_MODE;
      resetMcpClient();
    }
  });
});
