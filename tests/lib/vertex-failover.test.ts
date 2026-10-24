import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 24 Oct, live: the same research request against gemini-3.8-flash took 25, 18, 73, 67, 83, 48, 18 and 104 s, one after
 * another (Google's side; gemini-3.5-flash answered the identical request in 1.6-5.4 s). Two such calls spend the whole
 * research budget, so the user saw "The investigation ran out of time" for prompts whose reads took 1 s.
 *
 * A call to the primary model that outlasts a threshold is moved to the registry's fallback, and the primary is
 * left alone for a few minutes (a degraded spell costs one slow call, not one per call). Nothing is ever sent twice
 * while the primary is healthy: this is a failover, not a hedge.
 */
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() { return { credentials: {}, getAccessToken: async () => ({ token: "token-1" }) }; }
  },
}));

const ok = () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"kind":"clarify","question":"Budget?"}' }] } }] });
const modelOf = (fetcher: ReturnType<typeof vi.fn>, call: number) => String((fetcher.mock.calls[call] as unknown as [string])[0]).match(/models\/([^:/]+)/)?.[1];

/** A primary call that never answers until it is aborted, as a 60-second generation looks to the caller. */
const hangs = (init: RequestInit | undefined) => new Promise<Response>((_, reject) => {
  init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
});

async function load() { vi.resetModules(); return import("@/lib/copilot/vertex"); }
const run = (vertex: Awaited<ReturnType<typeof load>>, model = "gemini-3.8-flash", signal = new AbortController().signal) =>
  vertex.generateInvestigationJson(model, "system", "user", signal);

beforeEach(() => {
  vi.stubEnv("GOOGLE_WORKLOAD_IDENTITY_AUDIENCE", "");
  vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", JSON.stringify({ client_email: "fixture@example.test", private_key: "fixture" }));
  vi.stubEnv("VERTEX_MODEL", "gemini-3.8-flash");
  vi.stubEnv("VERTEX_MODEL_FALLBACKS", "gemini-3.5-flash");
  vi.stubEnv("COPILOT_MODEL_SLOW_MS", "60");
  vi.stubEnv("COPILOT_MODEL_BREAKER_MS", "400");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("a slow primary model fails over to the fallback", () => {
  it("answers from the fallback when the primary outlasts the threshold, without waiting for it", async () => {
    const vertex = await load();
    const fetcher = vi.fn()
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => hangs(init))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetcher);
    const started = Date.now();
    await expect(run(vertex)).resolves.toEqual({ kind: "clarify", question: "Budget?" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect([modelOf(fetcher, 0), modelOf(fetcher, 1)]).toEqual(["gemini-3.8-flash", "gemini-3.5-flash"]);
  });

  it("goes straight to the fallback while the primary is known to be slow", async () => {
    const vertex = await load();
    const fetcher = vi.fn()
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => hangs(init))
      .mockImplementation(async () => ok());
    vi.stubGlobal("fetch", fetcher);
    await run(vertex);
    await run(vertex);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(modelOf(fetcher, 2)).toBe("gemini-3.5-flash");
  });

  it("tries the primary again once the cool-off has passed", async () => {
    const vertex = await load();
    const fetcher = vi.fn()
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => hangs(init))
      .mockImplementation(async () => ok());
    vi.stubGlobal("fetch", fetcher);
    await run(vertex);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await run(vertex);
    expect(modelOf(fetcher, 2)).toBe("gemini-3.8-flash");
  });

  it("fails over on an unavailable primary (503, 429) as well as a slow one", async () => {
    for (const status of [503, 429]) {
      const vertex = await load();
      const fetcher = vi.fn()
        .mockResolvedValueOnce(new Response("unavailable", { status }))
        .mockResolvedValueOnce(ok());
      vi.stubGlobal("fetch", fetcher);
      await expect(run(vertex)).resolves.toEqual({ kind: "clarify", question: "Budget?" });
      expect(modelOf(fetcher, 1), String(status)).toBe("gemini-3.5-flash");
    }
  });
});

describe("a failover never happens when it should not", () => {
  it("sends one call, to the primary, when the primary is healthy", async () => {
    const vertex = await load();
    const fetcher = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetcher);
    await run(vertex);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(modelOf(fetcher, 0)).toBe("gemini-3.8-flash");
  });

  it("does not count the user's own cancel as slowness", async () => {
    vi.stubEnv("COPILOT_MODEL_SLOW_MS", "5000"); // far longer than the cancel, so only the cancel can end the call
    const vertex = await load();
    const controller = new AbortController();
    const fetcher = vi.fn()
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => hangs(init))
      .mockImplementation(async () => ok());
    vi.stubGlobal("fetch", fetcher);
    const pending = run(vertex, "gemini-3.8-flash", controller.signal);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await run(vertex);
    expect(modelOf(fetcher, 1)).toBe("gemini-3.8-flash");
  });

  it("leaves a call to any other model exactly as it was, however long it takes", async () => {
    const vertex = await load();
    const fetcher = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); return ok(); });
    vi.stubGlobal("fetch", fetcher);
    await run(vertex, "gemini-3.7-flash");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(modelOf(fetcher, 0)).toBe("gemini-3.7-flash");
  });

  it("gives up with the fallback's own answer when the fallback fails too, and never loops", async () => {
    const vertex = await load();
    const fetcher = vi.fn()
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => hangs(init))
      .mockImplementation(async () => new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(run(vertex)).rejects.toThrow(/HTTP 503/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does nothing when no fallback is configured", async () => {
    vi.stubEnv("VERTEX_MODEL_FALLBACKS", "gemini-3.8-flash");
    const vertex = await load();
    const fetcher = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); return ok(); });
    vi.stubGlobal("fetch", fetcher);
    await run(vertex);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
