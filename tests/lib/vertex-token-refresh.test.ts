import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every token google-auth-library hands out is numbered, so a test can tell a cached token
 * from a fresh one, and carries whatever expiry the test sets - a Cloud Run metadata token
 * can arrive with minutes left, which a flat 45-minute cache used to outlive.
 */
const auth = vi.hoisted(() => ({ issued: 0, expiresInMs: 60 * 60_000 as number | null }));

vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      const client = {
        credentials: {} as { expiry_date?: number },
        getAccessToken: async () => {
          auth.issued += 1;
          client.credentials = auth.expiresInMs === null ? {} : { expiry_date: Date.now() + auth.expiresInMs };
          return { token: `token-${auth.issued}` };
        },
      };
      return client;
    }
  },
}));

function ok() {
  return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"kind":"clarify","question":"Budget?"}' }] } }] });
}

function bearer(fetcher: ReturnType<typeof vi.fn>, call: number): string {
  return String(((fetcher.mock.calls[call] as unknown as [string, RequestInit])[1].headers as Record<string, string>).Authorization);
}

async function load() {
  vi.resetModules();
  return import("@/lib/copilot/vertex");
}

const run = (vertex: Awaited<ReturnType<typeof load>>) =>
  vertex.generateInvestigationJson("gemini-3.8-flash", "system", "user", new AbortController().signal);

beforeEach(() => {
  auth.issued = 0;
  auth.expiresInMs = 60 * 60_000;
  vi.stubEnv("GOOGLE_WORKLOAD_IDENTITY_AUDIENCE", "");
  vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", JSON.stringify({ client_email: "fixture@example.test", private_key: "fixture" }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Vertex access token lifetime", () => {
  it("retries a 401 once with a fresh token and returns the decision", async () => {
    const vertex = await load();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetcher);
    await expect(run(vertex)).resolves.toEqual({ kind: "clarify", question: "Budget?" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(bearer(fetcher, 0)).toBe("Bearer token-1");
    expect(bearer(fetcher, 1)).toBe("Bearer token-2");
  });

  it("gives up after the one retry when the fresh token is refused too", async () => {
    const vertex = await load();
    const fetcher = vi.fn(async () => new Response("unauthenticated", { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(run(vertex)).rejects.toThrow(/^Vertex investigation HTTP 401$/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 403 - a permission problem is not a stale token", async () => {
    const vertex = await load();
    const fetcher = vi.fn(async () => new Response("denied", { status: 403 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(run(vertex)).rejects.toThrow(/^Vertex investigation HTTP 403$/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reuses a token while it has life left and refreshes it before Google's own expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    auth.expiresInMs = 20 * 60_000;
    const vertex = await load();
    const fetcher = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetcher);
    await run(vertex);
    vi.advanceTimersByTime(10 * 60_000);
    await run(vertex);
    // 16 min in, the token still has 4 min left - inside the margin, so it is replaced.
    vi.advanceTimersByTime(6 * 60_000);
    await run(vertex);
    expect([0, 1, 2].map((call) => bearer(fetcher, call))).toEqual(["Bearer token-1", "Bearer token-1", "Bearer token-2"]);
  });

  it("does not keep a token that arrives with only minutes left", async () => {
    auth.expiresInMs = 3 * 60_000;
    const vertex = await load();
    const fetcher = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetcher);
    await run(vertex);
    await run(vertex);
    expect([0, 1].map((call) => bearer(fetcher, call))).toEqual(["Bearer token-1", "Bearer token-2"]);
  });
});
