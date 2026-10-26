import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 26 Oct, live: every research call logged `cached=0` although the rules and tools it opens with (about 13k tokens) are the
 * same for every user. Implicit caching only helps when the same prefix is sent again within minutes. An explicit cache
 * holds the prefix for 15 minutes, shared by every request, and a call that reads it has about 99.9% of its prompt cached
 * (measured on gemini-3.8-flash: 11,763 of 11,771 tokens).
 *
 * It must never cost an answer: a call that finds no cache is sent in full, a cached call that hangs or is refused is
 * repeated in full, and a cache that failed is left alone for a while.
 */
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() { return { credentials: {}, getAccessToken: async () => ({ token: "token-1" }) }; }
  },
}));

const decisionResponse = () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"kind":"clarify","question":"Budget?"}' }] } }] });
const cacheCreated = () => Response.json({ name: "projects/p/locations/global/cachedContents/1", expireTime: new Date(Date.now() + 600_000).toISOString() });
const decls = [{ name: "read_balance", description: "Read the wallet balance.", parameters: { type: "object", properties: {} } }] as never;

type Call = { url: string; body: Record<string, unknown> };
function stubFetch(handler: (call: Call, init: RequestInit | undefined) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> };
    calls.push(call);
    return handler(call, init);
  });
  vi.stubGlobal("fetch", fetcher);
  return calls;
}
const isCreate = (call: Call) => call.url.includes("/cachedContents");
const isWarmup = (call: Call) => JSON.stringify(call.body.contents).includes("Reply with OK.");
const generations = (calls: Call[]) => calls.filter((call) => !isCreate(call) && !isWarmup(call));
const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

async function load() { vi.resetModules(); return import("@/lib/copilot/vertex"); }
const run = (vertex: Awaited<ReturnType<typeof load>>) =>
  vertex.generateInvestigationJson("gemini-3.8-flash", "the rules", "the user's message", new AbortController().signal, "LOW", decls);

beforeEach(() => {
  vi.stubEnv("GOOGLE_WORKLOAD_IDENTITY_AUDIENCE", "");
  vi.stubEnv("VERTEX_MODEL", "gemini-3.8-flash");
  vi.stubEnv("VERTEX_MODEL_FALLBACKS", "");
  vi.stubEnv("COPILOT_PROMPT_CACHE", "on");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("explicit prefix cache for the research loop", () => {
  it("sends the first call in full, then only the turn's message once the cache exists", async () => {
    const calls = stubFetch((call) => (isCreate(call) ? cacheCreated() : decisionResponse()));
    const vertex = await load();
    await run(vertex);
    await tick();
    await run(vertex);

    const [first, second] = generations(calls);
    expect(first.body.cachedContent).toBeUndefined();
    expect(first.body.systemInstruction).toBeDefined();
    expect(first.body.tools).toBeDefined();
    expect(second.body.cachedContent).toBe("projects/p/locations/global/cachedContents/1");
    expect(second.body.systemInstruction).toBeUndefined();
    expect(second.body.tools).toBeUndefined();
    expect(second.body.contents).toEqual([{ role: "user", parts: [{ text: "the user's message" }] }]);

    const create = calls.find(isCreate)!.body;
    expect(create.model).toContain("publishers/google/models/gemini-3.8-flash");
    expect(create.contents).toBeDefined(); // gemini-3.8-flash never finished creating a cache without a contents entry
    expect((create.toolConfig as { functionCallingConfig: { mode: string } }).functionCallingConfig.mode).toBe("ANY");
    expect(calls.filter(isCreate)).toHaveLength(1); // one cache for every request, not one each
  });

  it("repeats a cached call that never returns in full, and does not use that cache again", async () => {
    vi.stubEnv("COPILOT_CACHED_CALL_TIMEOUT_MS", "40");
    const calls = stubFetch((call, init) => {
      if (isCreate(call)) return cacheCreated();
      if (isWarmup(call)) return decisionResponse();
      if (call.body.cachedContent) {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      }
      return decisionResponse();
    });
    const vertex = await load();
    await run(vertex);
    await tick();
    await expect(run(vertex)).resolves.toMatchObject({ kind: "clarify" }); // cached call hangs, the full call answers
    await run(vertex);

    expect(generations(calls).map((call) => Boolean(call.body.cachedContent))).toEqual([false, true, false, false]);
  });

  it("repeats a cached call the endpoint refuses, in full", async () => {
    const calls = stubFetch((call) => {
      if (isCreate(call)) return cacheCreated();
      if (isWarmup(call)) return decisionResponse();
      return call.body.cachedContent ? new Response("cache not found", { status: 404 }) : decisionResponse();
    });
    const vertex = await load();
    await run(vertex);
    await tick();
    await expect(run(vertex)).resolves.toMatchObject({ kind: "clarify" });
    expect(generations(calls).map((call) => Boolean(call.body.cachedContent))).toEqual([false, true, false]);
  });

  it("uses a cache only after one background call has read it", async () => {
    const calls = stubFetch((call) => {
      if (isCreate(call)) return cacheCreated();
      return isWarmup(call) ? new Response("warming failed", { status: 500 }) : decisionResponse();
    });
    const vertex = await load();
    await run(vertex);
    await tick();
    await run(vertex);
    expect(calls.some(isWarmup)).toBe(true);
    expect(generations(calls).every((call) => !call.body.cachedContent)).toBe(true); // a cache that did not warm is never used
  });

  it("never fails a request because the cache could not be created", async () => {
    const calls = stubFetch((call) => (isCreate(call) ? new Response("quota", { status: 429 }) : decisionResponse()));
    const vertex = await load();
    await expect(run(vertex)).resolves.toMatchObject({ kind: "clarify" });
    await tick();
    await expect(run(vertex)).resolves.toMatchObject({ kind: "clarify" });
    expect(generations(calls).every((call) => !call.body.cachedContent)).toBe(true);
    expect(calls.filter(isCreate)).toHaveLength(1); // not retried on every call
  });

  it("is off when asked, and for a call without tools", async () => {
    vi.stubEnv("COPILOT_PROMPT_CACHE", "off");
    const calls = stubFetch(() => decisionResponse());
    const vertex = await load();
    await run(vertex);
    await tick();
    await run(vertex);
    expect(calls.filter(isCreate)).toHaveLength(0);
  });
});
