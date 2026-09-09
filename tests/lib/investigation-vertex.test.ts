import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() { return { getAccessToken: async () => ({ token: "test-only-token" }) }; }
  },
}));

import { generateInvestigationJson } from "@/lib/copilot/vertex";

beforeEach(() => {
  vi.stubEnv("GOOGLE_WORKLOAD_IDENTITY_AUDIENCE", "");
  vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", JSON.stringify({ client_email: "fixture@example.test", private_key: "fixture" }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function response(parts: Array<{ text: string; thought?: boolean }>, finishReason = "STOP") {
  return Response.json({ candidates: [{ finishReason, content: { parts } }] });
}

describe("Vertex investigation transport", () => {
  it("uses 3.8 reasoning configuration, excludes thought text, and forwards the abort signal", async () => {
    const decision = { kind: "clarify", question: "Which objective?" };
    const fetcher = vi.fn(async () => response([
      { text: "private thinking must not become output", thought: true }, { text: JSON.stringify(decision) },
    ]));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    expect(await generateInvestigationJson("gemini-3.8-flash", "system", "user", signal)).toEqual(decision);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("gemini-3.8-flash:generateContent");
    expect(init.signal).toBe(signal);
    const body = JSON.parse(String(init.body));
    expect(body.generationConfig).toEqual({
      responseMimeType: "application/json", maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: "MEDIUM" },
    });
    expect(body).not.toHaveProperty("tools");
  });

  it("does not retry another model or expose error response bodies", async () => {
    const fetcher = vi.fn(async () => new Response("sensitive provider diagnostics", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(generateInvestigationJson("gemini-3.8-flash", "system", "user", new AbortController().signal))
      .rejects.toThrow(/^Vertex investigation HTTP 503$/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects token-exhausted partial JSON even when the text looks parseable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response([{ text: '{"kind":"clarify","question":"Budget?"}' }], "MAX_TOKENS")));
    await expect(generateInvestigationJson("gemini-3.8-flash", "system", "user", new AbortController().signal))
      .rejects.toThrow("did not finish a decision");
  });

  it("does not dispatch when cancelled or configured to use Pro", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    controller.abort();
    await expect(generateInvestigationJson("gemini-3.8-flash", "system", "user", controller.signal)).rejects.toBeDefined();
    await expect(generateInvestigationJson("gemini-3.8-pro", "system", "user", new AbortController().signal))
      .rejects.toThrow("Gemini Flash");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
