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

  it("does not gate the copilot surface — it still reaches the write path", async () => {
    // Forced to the in-memory mock client so this never makes a real network call —
    // this test is only proving the gate does not fire outside surface: "assistant",
    // not exercising the real write pipeline (that is covered elsewhere).
    process.env.MCP_MODE = "mock";
    resetMcpClient();
    try {
      const res = await handleChat({
        ...base,
        surface: "copilot",
        message: "deposit 5 XLM as collateral",
      });
      expect(res.intent?.template_id).not.toBe("assistant_surface_redirect");
    } finally {
      delete process.env.MCP_MODE;
      resetMcpClient();
    }
  });
});
